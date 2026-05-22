from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from radiotelescope.main import create_app
from radiotelescope.services.queue import QueueService


# ─── Unit tests ──────────────────────────────────────────────────────────────


async def test_queue_promotes_first_join():
    queue = QueueService(max_session_seconds=60, idle_timeout_seconds=30, max_queue_size=10)
    token = await queue.join("1.2.3.4")
    assert queue.is_active(token)


async def test_queue_orders_arrivals():
    queue = QueueService(max_session_seconds=60, idle_timeout_seconds=30, max_queue_size=10)
    a = await queue.join("1.1.1.1")
    b = await queue.join("2.2.2.2")
    c = await queue.join("3.3.3.3")
    assert queue.status_for(a).position == 0
    assert queue.status_for(b).position == 1
    assert queue.status_for(c).position == 2


async def test_queue_promotes_after_leave():
    queue = QueueService(max_session_seconds=60, idle_timeout_seconds=30, max_queue_size=10)
    a = await queue.join("1.1.1.1")
    b = await queue.join("2.2.2.2")
    assert queue.is_active(a)
    await queue.leave(a)
    assert queue.is_active(b)


async def test_queue_full_raises():
    from radiotelescope.services.queue import QueueFullError

    queue = QueueService(max_session_seconds=60, idle_timeout_seconds=30, max_queue_size=2)
    await queue.join("1.1.1.1")
    await queue.join("2.2.2.2")
    with pytest.raises(QueueFullError):
        await queue.join("3.3.3.3")


async def test_queue_limits_repeated_sessions_per_ip():
    from radiotelescope.services.queue import QueueRateLimitedError

    queue = QueueService(
        max_session_seconds=60,
        idle_timeout_seconds=30,
        max_queue_size=10,
        max_sessions_per_ip=1,
        join_cooldown_seconds=0,
    )
    await queue.join("1.1.1.1")
    with pytest.raises(QueueRateLimitedError):
        await queue.join("1.1.1.1")


async def test_queue_join_cooldown_limits_bursts():
    from radiotelescope.services.queue import QueueRateLimitedError

    queue = QueueService(
        max_session_seconds=60,
        idle_timeout_seconds=30,
        max_queue_size=10,
        max_sessions_per_ip=10,
        join_cooldown_seconds=5,
    )
    await queue.join("1.1.1.1")
    with pytest.raises(QueueRateLimitedError):
        await queue.join("1.1.1.1")


async def test_queue_lease_expires_on_idle(monkeypatch):
    queue = QueueService(max_session_seconds=60, idle_timeout_seconds=1, max_queue_size=10)
    a = await queue.join("1.1.1.1")
    b = await queue.join("2.2.2.2")

    # Fast-forward monotonic clock so the active session looks idle.
    import time
    real_monotonic = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real_monotonic() + 5)

    changed = await queue._tick()
    assert changed
    assert not queue.is_active(a)
    assert queue.is_active(b)


async def test_queue_hard_cap_kicks(monkeypatch):
    queue = QueueService(max_session_seconds=1, idle_timeout_seconds=300, max_queue_size=10)
    a = await queue.join("1.1.1.1")
    b = await queue.join("2.2.2.2")
    # Keep the session "active" via mark_command but advance past hard cap.
    await queue.mark_command(a)

    import time
    real_monotonic = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real_monotonic() + 5)

    changed = await queue._tick()
    assert changed
    assert not queue.is_active(a)
    assert queue.is_active(b)


# ─── HTTP integration tests ──────────────────────────────────────────────────


def _config_with_queue(simulated_config_path):
    """Take the simulated fixture and disable Turnstile + remove the LAN admin
    bypass so we can exercise queue gating from `testclient`."""
    text = simulated_config_path.read_text(encoding="utf-8")
    text = text.replace(
        'allowed_clients = ["testclient"]',
        'allowed_clients = []',
    )
    text += """
[queue]
enabled = true
max_session_seconds = 600
idle_timeout_seconds = 60
max_sessions_per_ip = 10
join_cooldown_seconds = 0
cookie_secret = "test-secret-test-secret"
cookie_name = "rt_session"

[turnstile]
enabled = false
site_key = ""
secret_key = ""
"""
    simulated_config_path.write_text(text, encoding="utf-8")
    return simulated_config_path


def _config_with_beta_auth(simulated_config_path):
    cfg = _config_with_queue(simulated_config_path)
    password_file = cfg.with_name("passwords.txt")
    password_file.write_text("let-me-in\n", encoding="utf-8")
    text = cfg.read_text(encoding="utf-8")
    text += f"""
[auth]
enabled = true
passwords_file = "{password_file.as_posix()}"
secret_key = "test-auth-secret-test-auth-secret"
max_attempts = 5
lockout_minutes = 1
"""
    cfg.write_text(text, encoding="utf-8")
    return cfg


def test_control_endpoint_requires_lease(simulated_config_path):
    cfg = _config_with_queue(simulated_config_path)
    with TestClient(create_app(cfg)) as client:
        response = client.post(
            "/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}}
        )
    assert response.status_code == 403
    assert "active controller" in response.json()["detail"].lower()


def test_join_then_command_succeeds(simulated_config_path):
    cfg = _config_with_queue(simulated_config_path)
    with TestClient(create_app(cfg)) as client:
        join = client.post("/api/queue/join", json={"turnstile_token": None})
        assert join.status_code == 200
        body = join.json()
        assert body["is_active"] is True
        assert body["position"] == 0

        cmd = client.post(
            "/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}}
        )
        assert cmd.status_code == 200


def test_beta_auth_blocks_api_until_password_join(simulated_config_path):
    cfg = _config_with_beta_auth(simulated_config_path)
    with TestClient(create_app(cfg)) as client:
        config = client.get("/api/queue/config")
        assert config.status_code == 200
        assert config.json()["beta_password_enabled"] is True

        blocked = client.get("/api/roboclaw/status")
        assert blocked.status_code == 401
        assert blocked.json()["detail"] == "Authentication required"

        rejected = client.post("/api/queue/join", json={"beta_password": "wrong"})
        assert rejected.status_code == 403

        joined = client.post("/api/queue/join", json={"beta_password": "let-me-in"})
        assert joined.status_code == 200
        assert joined.json()["is_active"] is True

        allowed = client.get("/api/roboclaw/status")
        assert allowed.status_code == 200


def test_lan_admin_bypasses_queue(simulated_config_path):
    text = simulated_config_path.read_text(encoding="utf-8")
    text = text.replace(
        'allowed_clients = ["testclient"]',
        'allowed_clients = ["testclient"]',
    )
    text += """
[queue]
enabled = true
cookie_secret = "test-secret-test-secret"

[turnstile]
enabled = false
"""
    simulated_config_path.write_text(text, encoding="utf-8")

    with TestClient(create_app(simulated_config_path)) as client:
        # No /api/queue/join call. testclient is in allowed_clients => admin.
        cmd = client.post(
            "/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}}
        )
        assert cmd.status_code == 200


def test_second_visitor_gets_position_one(simulated_config_path):
    cfg = _config_with_queue(simulated_config_path)
    app = create_app(cfg)
    # Two TestClient instances sharing the same app => one queue, two cookie jars.
    with TestClient(app) as a, TestClient(app) as b:
        ra = a.post("/api/queue/join", json={"turnstile_token": None})
        rb = b.post("/api/queue/join", json={"turnstile_token": None})
        assert ra.status_code == 200
        assert rb.status_code == 200
        assert ra.json()["position"] == 0
        assert ra.json()["is_active"] is True
        assert rb.json()["position"] == 1
        assert rb.json()["is_active"] is False

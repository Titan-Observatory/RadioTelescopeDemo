from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from rt_platform.main import create_app
from rt_platform.services.queue import QueueService


# ─── QueueService unit tests ─────────────────────────────────────────────


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
    from rt_platform.services.queue import QueueFullError

    queue = QueueService(max_session_seconds=60, idle_timeout_seconds=30, max_queue_size=2)
    await queue.join("1.1.1.1")
    await queue.join("2.2.2.2")
    with pytest.raises(QueueFullError):
        await queue.join("3.3.3.3")


async def test_queue_limits_repeated_sessions_per_ip():
    from rt_platform.services.queue import QueueRateLimitedError

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
    from rt_platform.services.queue import QueueRateLimitedError

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
    await queue.mark_command(a)

    import time
    real_monotonic = time.monotonic
    monkeypatch.setattr(time, "monotonic", lambda: real_monotonic() + 5)

    changed = await queue._tick()
    assert changed
    assert not queue.is_active(a)
    assert queue.is_active(b)


# ─── HTTP integration: queue endpoints only ──────────────────────────────
#
# Tests that exercise control commands through the motor proxy require a
# backing hardware service (or an httpx mock); they are intentionally not
# covered here. The cross-service flow is verified by manual smoke and the
# Docker compose stack.


def test_queue_join_then_status(platform_config_path):
    with TestClient(create_app(platform_config_path)) as client:
        join = client.post("/api/queue/join", json={"turnstile_token": None})
        assert join.status_code == 200
        body = join.json()
        assert body["is_active"] is True
        assert body["position"] == 0

        status = client.get("/api/queue/status")
        assert status.status_code == 200
        assert status.json()["is_active"] is True


def test_second_visitor_gets_position_one(platform_config_path):
    app = create_app(platform_config_path)
    with TestClient(app) as a, TestClient(app) as b:
        ra = a.post("/api/queue/join", json={"turnstile_token": None})
        rb = b.post("/api/queue/join", json={"turnstile_token": None})
        assert ra.status_code == 200
        assert rb.status_code == 200
        assert ra.json()["position"] == 0
        assert ra.json()["is_active"] is True
        assert rb.json()["position"] == 1
        assert rb.json()["is_active"] is False


def test_control_endpoint_requires_lease(platform_config_path):
    """Without a queue lease, motor proxy refuses to forward."""
    with TestClient(create_app(platform_config_path)) as client:
        response = client.post(
            "/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}}
        )
    assert response.status_code == 403
    assert "active controller" in response.json()["detail"].lower()


@pytest.mark.parametrize(
    "path",
    [
        "/api/spectrum/status",
        "/api/spectrum/baseline",
        "/api/roboclaw/status",
        "/api/roboclaw/commands",
        "/api/telescope/goto",
        "/api/telescope/config",
    ],
)
def test_live_hardware_reads_require_active_queue_session(platform_config_path, path):
    """Without a queue lease, live read endpoints must not forward to hardware."""
    with TestClient(create_app(platform_config_path)) as client:
        response = client.get(path)
    assert response.status_code == 403
    assert "active queue session" in response.json()["detail"].lower()


def test_live_hardware_reads_allowed_after_join(platform_config_path):
    """After joining, live reads may forward; the fake upstream is unreachable."""
    with TestClient(create_app(platform_config_path)) as client:
        join = client.post("/api/queue/join", json={"turnstile_token": None})
        assert join.status_code == 200

        response = client.get("/api/roboclaw/status")

    assert response.status_code == 502
    assert "gateway unreachable" in response.json()["detail"].lower()


def test_queue_config_endpoint(platform_config_path):
    with TestClient(create_app(platform_config_path)) as client:
        response = client.get("/api/queue/config")
    assert response.status_code == 200
    body = response.json()
    assert body["beta_password_enabled"] is False

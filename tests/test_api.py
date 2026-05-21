from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from radiotelescope.main import create_app


def _make_public_safe_config(simulated_config_path):
    text = simulated_config_path.read_text(encoding="utf-8")
    text = text.replace(
        'host = "127.0.0.1"',
        'host = "0.0.0.0"',
    ).replace(
        'cors_origins = ["*"]',
        'cors_origins = ["https://telescope.example.test"]',
    ).replace(
        'allowed_clients = ["testclient"]',
        'allowed_clients = ["10.0.27.1"]\ntrusted_proxies = ["127.0.0.1"]',
    )
    text += """
[queue]
enabled = true
max_session_seconds = 600
idle_timeout_seconds = 60
max_sessions_per_ip = 10
join_cooldown_seconds = 0
cookie_secret = "prod-like-cookie-secret-for-tests"
cookie_name = "rt_session"

[turnstile]
enabled = true
site_key = "0x4AAAAAAAproductionLikeSiteKey"
secret_key = "0x4AAAAAAAproductionLikeSecretKey"
"""
    simulated_config_path.write_text(text, encoding="utf-8")
    return simulated_config_path


def test_api_exposes_disconnected_health(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["connection"]["mode"] == "disconnected"


def test_api_command_registry_exposes_operator_commands_only(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        registry = client.get("/api/roboclaw/commands")
        result = client.post("/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}})

    command_ids = {command["id"] for command in registry.json()}
    assert registry.status_code == 200
    assert "forward_m1" in command_ids
    assert "set_m1_default_duty_accel" in command_ids
    assert "write_settings" not in command_ids
    assert "restore_defaults" not in command_ids
    assert result.status_code == 200
    assert result.json()["ok"] is True


def test_api_rejects_non_operator_command(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        accepted = client.post("/api/roboclaw/commands/write_settings", json={"args": {}})

    assert accepted.status_code == 404


def test_gateway_server_accepts_trusted_hardware_commands_without_queue_session(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            "[roboclaw]",
            "[hardware]\nmode = \"gateway-server\"\n\n[roboclaw]",
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post("/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}})

    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_gateway_server_rejects_untrusted_hardware_commands_without_queue_session(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            "[roboclaw]",
            "[hardware]\nmode = \"gateway-server\"\n\n[roboclaw]",
        ).replace(
            'allowed_clients = ["testclient"]',
            "allowed_clients = []",
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post("/api/roboclaw/commands/forward_m1", json={"args": {"speed": 20}})

    assert response.status_code == 403


def test_gateway_server_accepts_internal_goto_command_from_trusted_client(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            "[roboclaw]",
            "[hardware]\nmode = \"gateway-server\"\n\n[roboclaw]",
        ),
        encoding="utf-8",
    )

    payload = {
        "args": {
            "m1_accel": 1000,
            "m1_speed": 1000,
            "m1_decel": 1000,
            "m1_position": 100,
            "m2_accel": 1000,
            "m2_speed": 1000,
            "m2_decel": 1000,
            "m2_position": 200,
            "buffer": 1,
        }
    }
    with TestClient(create_app(simulated_config_path)) as client:
        registry = client.get("/api/roboclaw/commands")
        response = client.post("/api/roboclaw/commands/speed_accel_decel_position_m1m2", json=payload)

    command_ids = {command["id"] for command in registry.json()}
    assert "speed_accel_decel_position_m1m2" not in command_ids
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_api_status_contains_telemetry(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/roboclaw/status")

    body = response.json()
    assert response.status_code == 200
    assert body["firmware"]
    assert "m1" in body["motors"]
    assert "lna" not in body


def test_spectrum_status_contains_lna(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/spectrum/status")

    body = response.json()
    assert response.status_code == 200
    assert body["lna"]["state"] in {"on", "off", "unknown", "fault"}


def test_spectrum_lna_toggle_runs_airspy_gpio(simulated_config_path, monkeypatch):
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("radiotelescope.hardware.sdr.subprocess.run", fake_run)

    with TestClient(create_app(simulated_config_path)) as client:
        join = client.post("/api/queue/join", json={"turnstile_token": None})
        response = client.post("/api/spectrum/lna", json={"enabled": True})
        off = client.post("/api/spectrum/lna", json={"enabled": False})

    assert join.status_code == 200
    assert response.status_code == 200
    assert response.json()["lna"]["state"] == "on"
    assert off.status_code == 200
    assert off.json()["lna"]["state"] == "off"
    assert calls[-2:] == [
        ["airspy_gpio", "-p", "1", "-n", "13", "-w", "1"],
        ["airspy_gpio", "-p", "1", "-n", "13", "-w", "0"],
    ]


def test_api_accepts_alt_az_goto(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post(
            "/api/telescope/goto",
            json={"altitude_deg": 30, "azimuth_deg": 45, "speed_qpps": 6000, "accel_qpps2": 7000},
        )

    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is True
    assert body["command_id"] == "speed_accel_decel_position_m1m2"
    assert body["response"]["m1_position"] == 550
    assert body["response"]["m2_position"] == 800
    assert body["response"]["az_speed_qpps"] == 6000
    assert body["response"]["alt_speed_qpps"] == 6000
    assert body["response"]["az_accel_qpps2"] == 7000
    assert body["response"]["alt_accel_qpps2"] == 7000


def test_home_elevation_zeros_after_encoder_stalls(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        service = client.app.state.roboclaw_service
        service.client._encoders["m2"] = 80

        response = client.post("/api/telescope/home/elevation", json={"speed": 108})
        status = client.get("/api/roboclaw/status")

    assert response.status_code == 200
    assert service.client._speeds["m2"] == 0
    assert status.json()["motors"]["m2"]["encoder"] == 0


def test_jog_rejects_stale_heartbeat(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        newer = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-1", "seq": 2, "direction": "west", "speed": 0},
        )
        stale = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-1", "seq": 1, "direction": "west", "speed": 40},
        )
        status = client.get("/api/roboclaw/status")

    assert newer.status_code == 200
    assert stale.status_code == 200
    assert stale.json()["accepted"] is False
    assert status.json()["motors"]["m1"]["raw_speed_qpps"] == 0


def test_stale_heartbeat_after_newer_jog_does_not_stop_active_motion(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        old = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-race", "seq": 1, "direction": "down", "speed": 40},
        )
        newer = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-race", "seq": 2, "direction": "down", "speed": 40},
        )
        stale = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-race", "seq": 1, "direction": "down", "speed": 40},
        )
        service = client.app.state.roboclaw_service

    assert old.status_code == 200
    assert newer.status_code == 200
    assert stale.status_code == 200
    assert stale.json()["accepted"] is False
    assert service.client._speeds["m2"] < 0


def test_jog_stop_stops_immediately(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        started = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-stop", "seq": 1, "direction": "west", "speed": 40},
        )
        stopped = client.post("/api/telescope/jog/stop", json={"token": "jog-token-stop", "seq": 2})
        status = client.get("/api/roboclaw/status")

    assert started.status_code == 200
    assert stopped.status_code == 200
    assert status.json()["motors"]["m1"]["raw_speed_qpps"] == 0


def test_old_jog_stop_does_not_stop_new_active_jog(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        old_started = client.post(
            "/api/telescope/jog",
            json={"token": "old-jog-token", "seq": 1, "direction": "west", "speed": 40},
        )
        new_started = client.post(
            "/api/telescope/jog",
            json={"token": "new-jog-token", "seq": 1, "direction": "west", "speed": 40},
        )
        delayed_old_stop = client.post("/api/telescope/jog/stop", json={"token": "old-jog-token", "seq": 2})
        service = client.app.state.roboclaw_service

    assert old_started.status_code == 200
    assert new_started.status_code == 200
    assert delayed_old_stop.status_code == 200
    assert service.client._speeds["m1"] > 0


def test_jog_watchdog_stops_when_heartbeats_stop(simulated_config_path):
    import time

    with TestClient(create_app(simulated_config_path)) as client:
        started = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-2", "seq": 1, "direction": "west", "speed": 40},
        )
        service = client.app.state.roboclaw_service
        assert service.client._speeds["m1"] > 0
        time.sleep(1.2)
        assert service.client._speeds["m1"] == 0

    assert started.status_code == 200
    assert started.json()["accepted"] is True


def test_api_rejects_goto_outside_pointing_limit_triangle(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            "[roboclaw]",
            "[hardware]\nmode = \"gateway-client\"\ngateway_host = \"192.0.2.1\"\n\n[roboclaw]",
        ).replace(
            "goto_decel_qpps2 = 5000",
            """goto_decel_qpps2 = 5000
pointing_limit_altaz = [
  { altitude_deg = 10.0, azimuth_deg = 10.0 },
  { altitude_deg = 70.0, azimuth_deg = 90.0 },
  { altitude_deg = 10.0, azimuth_deg = 170.0 },
]
""",
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path)) as client:
        rejected = client.post("/api/telescope/goto", json={"altitude_deg": 5, "azimuth_deg": 90})

    assert rejected.status_code == 400
    assert "outside configured pointing limits" in rejected.json()["detail"]


def test_api_telescope_config_includes_pointing_limits(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            "goto_decel_qpps2 = 5000",
            """goto_decel_qpps2 = 5000
pointing_limit_altaz = [
  { altitude_deg = 10.0, azimuth_deg = 10.0 },
  { altitude_deg = 70.0, azimuth_deg = 90.0 },
  { altitude_deg = 10.0, azimuth_deg = 170.0 },
]
""",
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/telescope/config")

    body = response.json()
    assert response.status_code == 200
    assert body["pointing_limit_altaz"] == [
        {"altitude_deg": 10.0, "azimuth_deg": 10.0},
        {"altitude_deg": 70.0, "azimuth_deg": 90.0},
        {"altitude_deg": 10.0, "azimuth_deg": 170.0},
    ]


def test_api_describes_alt_az_goto_for_browser_gets(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/telescope/goto")

    body = response.json()
    assert response.status_code == 200
    assert body["method"] == "POST"
    assert body["mapping"]["m1"] == "azimuth"
    assert body["mapping"]["m2"] == "altitude"


def test_api_rejects_out_of_range_alt_az(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post("/api/telescope/goto", json={"altitude_deg": 91, "azimuth_deg": 45})

    assert response.status_code == 422


def test_api_allows_configured_client(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            'allowed_clients = ["testclient"]',
            'allowed_clients = ["10.0.27.1", "10.0.27.2"]\nlan_only = true',
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path), client=("10.0.27.1", 50000)) as client:
        response = client.get("/api/health")

    assert response.status_code == 200


def test_api_rejects_unconfigured_client(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            'allowed_clients = ["testclient"]',
            'allowed_clients = ["10.0.27.1", "10.0.27.2"]\nlan_only = true',
        ),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path), client=("10.0.27.3", 50000)) as client:
        response = client.get("/api/health")

    assert response.status_code == 403
    assert response.text == "Client IP not allowed"


def test_public_proxy_does_not_make_external_client_lan_admin(simulated_config_path):
    cfg = _make_public_safe_config(simulated_config_path)
    with TestClient(create_app(cfg), client=("127.0.0.1", 50000)) as client:
        response = client.post(
            "/api/roboclaw/commands/forward_m1",
            headers={"x-forwarded-for": "203.0.113.44", "x-forwarded-proto": "https"},
            json={"args": {"speed": 20}},
        )

    assert response.status_code == 403


def test_public_proxy_allows_real_lan_admin_after_forwarding(simulated_config_path):
    cfg = _make_public_safe_config(simulated_config_path)
    with TestClient(create_app(cfg), client=("127.0.0.1", 50000)) as client:
        response = client.post(
            "/api/roboclaw/commands/forward_m1",
            headers={"x-forwarded-for": "10.0.27.1", "x-forwarded-proto": "https"},
            json={"args": {"speed": 20}},
        )

    assert response.status_code == 200


def test_public_proxy_without_forwarded_for_is_not_lan_admin(simulated_config_path):
    cfg = _make_public_safe_config(simulated_config_path)
    with TestClient(create_app(cfg), client=("127.0.0.1", 50000)) as client:
        response = client.post(
            "/api/roboclaw/commands/forward_m1",
            headers={"x-forwarded-proto": "https"},
            json={"args": {"speed": 20}},
        )

    assert response.status_code == 403


def test_unsafe_public_config_fails_startup(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8").replace(
            'host = "127.0.0.1"',
            'host = "0.0.0.0"',
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="Unsafe public exposure"):
        create_app(simulated_config_path)


def test_feedback_rate_limit_and_log_rotation(simulated_config_path, tmp_path):
    log_path = tmp_path / "feedback.jsonl"
    rotated_seed = "x" * 128
    log_path.write_text(rotated_seed, encoding="utf-8")
    text = simulated_config_path.read_text(encoding="utf-8")
    text = f'feedback_log_path = "{log_path.as_posix()}"\nfeedback_log_max_bytes = 64\n' + text
    text += """
[rate_limit]
feedback_per_minute = 2
"""
    simulated_config_path.write_text(text, encoding="utf-8")

    with TestClient(create_app(simulated_config_path)) as client:
        first = client.post("/api/feedback", json={"rating": 5, "message": "ok"})
        second = client.post("/api/feedback", json={"rating": 4, "message": "ok"})
        limited = client.post("/api/feedback", json={"rating": 3, "message": "ok"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert limited.status_code == 429
    assert log_path.exists()
    assert list(tmp_path.glob("feedback.*.jsonl"))


def test_events_reject_oversized_props(simulated_config_path, tmp_path):
    log_path = tmp_path / "events.jsonl"
    text = f'events_log_path = "{log_path.as_posix()}"\n' + simulated_config_path.read_text(encoding="utf-8")
    simulated_config_path.write_text(text, encoding="utf-8")

    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post(
            "/api/events",
            json={
                "event": "page_view",
                "session_id": "session-123",
                "props": {"payload": "x" * 5000},
            },
        )

    assert response.status_code == 422


# ─── Motion safety ────────────────────────────────────────────────────────────


def _mock_request_for_slew(*, mode: str, altitude: float | None, azimuth: float | None, cap: float = 45.0):
    """Build the smallest fake Request that `_enforce_max_slew` reads from."""
    from radiotelescope.api.routes_roboclaw import _enforce_max_slew  # noqa: F401 (smoke import)
    return SimpleNamespace(
        app=SimpleNamespace(
            state=SimpleNamespace(
                config=SimpleNamespace(
                    mount=SimpleNamespace(max_slew_deg_per_command=cap),
                ),
                roboclaw_service=SimpleNamespace(
                    client=SimpleNamespace(connection=SimpleNamespace(mode=mode)),
                    latest=SimpleNamespace(altitude_deg=altitude, azimuth_deg=azimuth),
                ),
            )
        )
    )


def test_enforce_max_slew_rejects_oversized():
    from fastapi import HTTPException

    from radiotelescope.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="ok", altitude=0.0, azimuth=0.0)
    with pytest.raises(HTTPException) as exc_info:
        _enforce_max_slew(80.0, 80.0, request)
    assert exc_info.value.status_code == 422
    assert "exceeds the per-command cap" in str(exc_info.value.detail)


def test_enforce_max_slew_passes_within_cap():
    from radiotelescope.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="ok", altitude=0.0, azimuth=0.0)
    # max(|Δalt|, shortest-arc |Δaz|) = max(30, 30) = 30 < 45 cap
    _enforce_max_slew(30.0, 30.0, request)  # should not raise


def test_enforce_max_slew_uses_shortest_arc_azimuth():
    from radiotelescope.api.routes_roboclaw import _enforce_max_slew

    # Current az=350°, target az=10° — shortest arc is 20°, not 340°.
    request = _mock_request_for_slew(mode="ok", altitude=0.0, azimuth=350.0)
    _enforce_max_slew(0.0, 10.0, request)  # should not raise


def test_enforce_max_slew_skips_when_disconnected():
    from radiotelescope.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="disconnected", altitude=0.0, azimuth=0.0)
    _enforce_max_slew(180.0, 180.0, request)  # huge, but no hardware to protect


def test_enforce_max_slew_skips_without_baseline_telemetry():
    from radiotelescope.api.routes_roboclaw import _enforce_max_slew

    # No current alt/az → first command after startup; can't compute distance.
    request = _mock_request_for_slew(mode="ok", altitude=None, azimuth=None)
    _enforce_max_slew(80.0, 80.0, request)  # should not raise


def test_goto_rate_limited_returns_429_with_retry_after(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8") + """
[rate_limit]
motion_per_minute = 2
""",
        encoding="utf-8",
    )
    with TestClient(create_app(simulated_config_path)) as client:
        first = client.post("/api/telescope/goto", json={"altitude_deg": 30, "azimuth_deg": 45})
        second = client.post("/api/telescope/goto", json={"altitude_deg": 30, "azimuth_deg": 45})
        third = client.post("/api/telescope/goto", json={"altitude_deg": 30, "azimuth_deg": 45})

    assert first.status_code == 200
    assert second.status_code == 200
    assert third.status_code == 429
    # Retry-After must be a positive integer per RFC 7231.
    retry_after = third.headers.get("retry-after")
    assert retry_after is not None
    assert int(retry_after) >= 1


def test_jog_is_not_rate_limited_by_motion_bucket(simulated_config_path):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8") + """
[rate_limit]
motion_per_minute = 2
""",
        encoding="utf-8",
    )
    with TestClient(create_app(simulated_config_path)) as client:
        responses = [
            client.post(
                "/api/telescope/jog",
                json={"token": "jog-rate-limit", "seq": seq, "direction": "west", "speed": 40},
            )
            for seq in range(1, 5)
        ]
        limited_goto = [
            client.post("/api/telescope/goto", json={"altitude_deg": 30, "azimuth_deg": 45})
            for _ in range(3)
        ]

    assert [response.status_code for response in responses] == [200, 200, 200, 200]
    assert [response.status_code for response in limited_goto] == [200, 200, 429]


def test_motion_audit_log_records_accepted_goto(simulated_config_path, tmp_path):
    import json

    log_path = tmp_path / "motion.jsonl"
    simulated_config_path.write_text(
        f'motion_log_path = "{log_path.as_posix()}"\n'
        + simulated_config_path.read_text(encoding="utf-8"),
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post(
            "/api/telescope/goto",
            json={"altitude_deg": 30, "azimuth_deg": 45},
        )

    assert response.status_code == 200
    assert log_path.exists()
    lines = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(lines) >= 1
    accepted = [entry for entry in lines if entry["endpoint"] == "goto" and entry["accepted"]]
    assert accepted, f"expected an accepted goto entry, got {lines}"
    entry = accepted[-1]
    assert entry["params"]["altitude_deg"] == 30
    assert entry["params"]["azimuth_deg"] == 45
    assert entry["reason"] is None


def test_motion_audit_log_records_rejected_goto(simulated_config_path, tmp_path):
    import json

    log_path = tmp_path / "motion.jsonl"
    # gateway-client mode keeps connection != "disconnected", which lets the
    # pointing-limit check (which doesn't need a current-position baseline)
    # engage and produce the rejection we audit-log.
    text = simulated_config_path.read_text(encoding="utf-8").replace(
        "[roboclaw]",
        "[hardware]\nmode = \"gateway-client\"\ngateway_host = \"192.0.2.1\"\n\n[roboclaw]",
    ).replace(
        "goto_decel_qpps2 = 5000",
        """goto_decel_qpps2 = 5000
pointing_limit_altaz = [
  { altitude_deg = 10.0, azimuth_deg = 10.0 },
  { altitude_deg = 70.0, azimuth_deg = 90.0 },
  { altitude_deg = 10.0, azimuth_deg = 170.0 },
]
""",
    )
    simulated_config_path.write_text(
        f'motion_log_path = "{log_path.as_posix()}"\n' + text,
        encoding="utf-8",
    )

    with TestClient(create_app(simulated_config_path)) as client:
        rejected = client.post(
            "/api/telescope/goto",
            json={"altitude_deg": 5, "azimuth_deg": 90},
        )

    assert rejected.status_code == 400
    assert log_path.exists()
    lines = [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    refused = [entry for entry in lines if entry["endpoint"] == "goto" and not entry["accepted"]]
    assert refused, f"expected a rejected goto entry, got {lines}"
    assert "outside configured pointing limits" in refused[-1]["reason"]

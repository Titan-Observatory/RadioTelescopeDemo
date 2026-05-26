from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from rt_hardware.main import create_app


# ─── Health / command registry ─────────────────────────────────────────────


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


# ─── Telemetry / spectrum status ──────────────────────────────────────────


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


def test_spectrum_lna_applied_at_boot(simulated_config_path, monkeypatch):
    """The configured `lna_bias_tee_enabled` is pushed to airspy_gpio at startup,
    not via a runtime toggle (which would conflict with the GR subprocess owning
    the dongle).
    """
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8")
        + "\n[sdr]\nenabled = true\nlna_bias_tee_enabled = true\n",
        encoding="utf-8",
    )
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr("rt_hardware.hardware.sdr.subprocess.run", fake_run)

    with TestClient(create_app(simulated_config_path)) as client:
        status = client.get("/api/spectrum/status")

    assert status.status_code == 200
    assert status.json()["lna"]["state"] == "on"
    # Exactly one airspy_gpio invocation at boot, enabling the bias tee.
    assert calls == [["airspy_gpio", "-p", "1", "-n", "13", "-w", "1"]]


# ─── Goto / jog ───────────────────────────────────────────────────────────


def test_spectrum_lna_not_touched_at_boot_when_disabled(simulated_config_path, monkeypatch):
    """Default/off config should not call airspy_gpio just to prove it is off."""
    calls: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        calls.append(list(cmd))
        raise AssertionError("airspy_gpio should not run when the configured bias tee is off")

    monkeypatch.setattr("rt_hardware.hardware.sdr.subprocess.run", fake_run)

    with TestClient(create_app(simulated_config_path)) as client:
        status = client.get("/api/spectrum/status")

    assert status.status_code == 200
    assert status.json()["lna"]["state"] == "off"
    assert calls == []


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


# ─── Pointing limits / range checks ───────────────────────────────────────


def test_api_rejects_goto_outside_pointing_limit_triangle(simulated_config_path):
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
        # The pointing-limit check is skipped when the client is "disconnected",
        # so reach in and flip the simulated client's connection mode so the
        # guard engages.
        client.app.state.roboclaw_service.client.connection.mode = "ok"
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


# ─── Motion safety helper ─────────────────────────────────────────────────


def _mock_request_for_slew(*, mode: str, altitude: float | None, azimuth: float | None, cap: float = 45.0):
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

    from rt_hardware.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="ok", altitude=0.0, azimuth=0.0)
    with pytest.raises(HTTPException) as exc_info:
        _enforce_max_slew(80.0, 80.0, request)
    assert exc_info.value.status_code == 422
    assert "exceeds the per-command cap" in str(exc_info.value.detail)


def test_enforce_max_slew_passes_within_cap():
    from rt_hardware.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="ok", altitude=0.0, azimuth=0.0)
    _enforce_max_slew(30.0, 30.0, request)


def test_enforce_max_slew_uses_shortest_arc_azimuth():
    from rt_hardware.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="ok", altitude=0.0, azimuth=350.0)
    _enforce_max_slew(0.0, 10.0, request)


def test_enforce_max_slew_skips_when_disconnected():
    from rt_hardware.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="disconnected", altitude=0.0, azimuth=0.0)
    _enforce_max_slew(180.0, 180.0, request)


def test_enforce_max_slew_skips_without_baseline_telemetry():
    from rt_hardware.api.routes_roboclaw import _enforce_max_slew

    request = _mock_request_for_slew(mode="ok", altitude=None, azimuth=None)
    _enforce_max_slew(80.0, 80.0, request)

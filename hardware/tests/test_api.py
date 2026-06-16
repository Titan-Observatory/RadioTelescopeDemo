from __future__ import annotations

import logging
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


def test_boot_log_says_disabled_when_bias_tee_off(simulated_config_path, caplog):
    """The boot log must not claim the bias tee was 'applied' when config has it off."""
    with caplog.at_level(logging.INFO, logger="rt_hardware"):
        with TestClient(create_app(simulated_config_path)):
            pass

    messages = [r.getMessage() for r in caplog.records if r.name == "rt_hardware"]
    assert any("LNA bias tee disabled" in m for m in messages), messages
    assert not any("LNA bias tee applied" in m or "LNA bias tee enabled" in m for m in messages), messages


def test_boot_log_says_enabled_when_bias_tee_on(simulated_config_path, monkeypatch, caplog):
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8")
        + "\n[sdr]\nenabled = true\nlna_bias_tee_enabled = true\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "rt_hardware.hardware.sdr.subprocess.run",
        lambda cmd, **kwargs: SimpleNamespace(returncode=0, stdout="", stderr=""),
    )

    with caplog.at_level(logging.INFO, logger="rt_hardware"):
        with TestClient(create_app(simulated_config_path)):
            pass

    messages = [r.getMessage() for r in caplog.records if r.name == "rt_hardware"]
    assert any("LNA bias tee enabled at boot" in m for m in messages), messages
    assert not any("LNA bias tee disabled" in m for m in messages), messages


def test_api_accepts_alt_az_goto(simulated_config_path):
    """Default (software-side) goto jogs each axis toward its target encoder count."""
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post(
            "/api/telescope/goto",
            json={"altitude_deg": 30, "azimuth_deg": 55},
        )

    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is True
    assert body["command_id"] == "software_goto"
    assert body["response"]["m1_position"] == 1950
    assert body["response"]["m2_position"] == 800
    # Encoders start at 0, both targets are positive, so both axes jog forward.
    assert body["response"]["m1_command"] == "forward_m1"
    assert body["response"]["m2_command"] == "forward_m2"
    assert body["response"]["jog_speed"] == 100


def test_api_accepts_alt_az_goto_position_pid(simulated_config_path):
    """With goto_software_side off, goto falls back to the onboard position PID."""
    config = simulated_config_path.read_text(encoding="utf-8").replace(
        "goto_decel_qpps2 = 5000",
        "goto_decel_qpps2 = 5000\ngoto_software_side = false",
    )
    simulated_config_path.write_text(config, encoding="utf-8")
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post(
            "/api/telescope/goto",
            json={"altitude_deg": 30, "azimuth_deg": 55, "speed_qpps": 6000, "accel_qpps2": 7000},
        )

    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is True
    assert body["command_id"] == "speed_accel_decel_position_m1m2"
    assert body["response"]["m1_position"] == 1950
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
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 1500  # az = 100 deg (in bounds, west allowed)
        service.client._encoders["m2"] = 1100  # alt = 45 deg
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
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 1500  # az = 100 deg
        service.client._encoders["m2"] = 1100  # alt = 45 deg
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

    assert old.status_code == 200
    assert newer.status_code == 200
    assert stale.status_code == 200
    assert stale.json()["accepted"] is False
    assert service.client._speeds["m2"] < 0


def test_jog_stop_stops_immediately(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 1500  # az = 100 deg (in bounds, west allowed)
        service.client._encoders["m2"] = 1100  # alt = 45 deg
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
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 1500  # az = 100 deg (in bounds, west allowed)
        service.client._encoders["m2"] = 1100  # alt = 45 deg
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


def test_stale_jog_finishing_after_stop_does_not_leave_motors_running(simulated_config_path):
    """A jog whose motion command lands *after* a newer stop was processed must
    undo itself — otherwise the motors run with no watchdog armed and no
    further heartbeats coming."""
    import asyncio
    import threading

    with TestClient(create_app(simulated_config_path)) as client:
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 1500  # az = 100 deg (in bounds, west allowed)
        service.client._encoders["m2"] = 1100  # alt = 45 deg
        original_execute = service.execute
        entered = threading.Event()
        release = threading.Event()

        async def delayed_execute(command_id, args=None):
            # Hold the jog's motion command until the stop has been processed,
            # reproducing the in-flight race deterministically.
            if command_id == "forward_m1":
                entered.set()
                await asyncio.to_thread(release.wait, 2.0)
            return await original_execute(command_id, args)

        service.execute = delayed_execute

        jog_response = {}

        def send_jog():
            jog_response["resp"] = client.post(
                "/api/telescope/jog",
                json={"token": "race-token-x", "seq": 1, "direction": "west", "speed": 40},
            )

        jog_thread = threading.Thread(target=send_jog)
        jog_thread.start()
        assert entered.wait(2.0), "jog never reached its motion command"
        stopped = client.post("/api/telescope/jog/stop", json={"token": "race-token-x", "seq": 2})
        release.set()
        jog_thread.join(timeout=5.0)
        service.execute = original_execute

    assert stopped.status_code == 200
    resp = jog_response["resp"]
    assert resp.status_code == 200
    assert resp.json()["accepted"] is False
    assert service.client._speeds["m1"] == 0


def test_jog_watchdog_stops_when_heartbeats_stop(simulated_config_path):
    import time

    with TestClient(create_app(simulated_config_path)) as client:
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 1500  # az = 100 deg (in bounds, west allowed)
        service.client._encoders["m2"] = 1100  # alt = 45 deg
        started = client.post(
            "/api/telescope/jog",
            json={"token": "jog-token-2", "seq": 1, "direction": "west", "speed": 40},
        )
        assert service.client._speeds["m1"] > 0
        time.sleep(1.2)
        assert service.client._speeds["m1"] == 0

    assert started.status_code == 200
    assert started.json()["accepted"] is True


# ─── Pointing limits / range checks ───────────────────────────────────────


def test_jog_rejects_motion_outside_hard_safety_limits(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 600  # az = 190 deg (at the east limit)
        service.client._encoders["m2"] = 1100  # alt = 45 deg

        # East drives further past the 190 deg limit, so it must be rejected.
        rejected = client.post(
            "/api/telescope/jog",
            json={"token": "jog-limit-token", "seq": 1, "direction": "east", "speed": 40},
        )

    assert rejected.status_code == 400
    assert "outside hard safety limits" in rejected.json()["detail"]
    assert service.client._speeds["m1"] == 0
    assert service.client._speeds["m2"] == 0


def test_jog_allows_recovery_back_toward_hard_safety_limits(simulated_config_path):
    # Already past the azimuth max (too far east): jogging further east is
    # rejected, but the recovery jog (west, back toward the allowed range) must
    # be accepted so an out-of-bounds dish is never stranded.
    with TestClient(create_app(simulated_config_path)) as client:
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 500  # az = 200 deg (past the east limit)
        service.client._encoders["m2"] = 1100  # alt = 45 deg

        further_out = client.post(
            "/api/telescope/jog",
            json={"token": "jog-further-out", "seq": 1, "direction": "east", "speed": 40},
        )
        assert further_out.status_code == 400
        assert "outside hard safety limits" in further_out.json()["detail"]

        # Stopped on rejection, so the encoder hasn't drifted: still az = 200.
        recover = client.post(
            "/api/telescope/jog",
            json={"token": "jog-recover-west", "seq": 1, "direction": "west", "speed": 40},
        )
        assert recover.status_code == 200
        assert recover.json()["accepted"] is True
        # West is forward_m1: the count rises, which lowers azimuth back toward
        # the allowed range.
        assert service.client._speeds["m1"] > 0


def test_active_jog_stops_when_it_crosses_hard_safety_limits(simulated_config_path):
    import time

    with TestClient(create_app(simulated_config_path)) as client:
        service = client.app.state.roboclaw_service
        service.client._encoders["m1"] = 610  # az = 189 deg, just inside the east limit
        service.client._encoders["m2"] = 1100  # alt = 45 deg

        # East is accepted at 189 deg; the telemetry poll then catches the jog
        # the moment it carries the dish past the 190 deg east limit.
        started = client.post(
            "/api/telescope/jog",
            json={"token": "jog-cross-token", "seq": 1, "direction": "east", "speed": 40},
        )
        assert started.status_code == 200
        assert service.client._speeds["m1"] < 0  # east = backward_m1, count falling

        time.sleep(0.5)

    assert service.client._speeds["m1"] == 0
    assert service.client._speeds["m2"] == 0

    assert service.client._speeds["m1"] == 0
    assert service.client._speeds["m2"] == 0


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
        rejected = client.post("/api/telescope/goto", json={"altitude_deg": 70, "azimuth_deg": 55})

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
    assert body["hard_safety_limits"] == {
        "altitude_min_deg": 30.0,
        "altitude_max_deg": 70.0,
        "azimuth_min_deg": 55.0,
        "azimuth_max_deg": 190.0,
    }


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


def test_api_rejects_goto_outside_hard_safety_limits(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        low_alt = client.post("/api/telescope/goto", json={"altitude_deg": 29, "azimuth_deg": 100})
        high_alt = client.post("/api/telescope/goto", json={"altitude_deg": 71, "azimuth_deg": 100})
        low_az = client.post("/api/telescope/goto", json={"altitude_deg": 45, "azimuth_deg": 54})
        high_az = client.post("/api/telescope/goto", json={"altitude_deg": 45, "azimuth_deg": 191})

    for response in [low_alt, high_alt, low_az, high_az]:
        assert response.status_code == 400
        assert "outside hard safety limits" in response.json()["detail"]


def test_api_rejects_radec_goto_outside_hard_safety_limits(simulated_config_path, monkeypatch):
    monkeypatch.setattr("rt_hardware.api.routes_roboclaw.radec_to_altaz", lambda *_args: (45.0, 191.0))

    with TestClient(create_app(simulated_config_path)) as client:
        response = client.post("/api/telescope/goto_radec", json={"ra_deg": 12.0, "dec_deg": 34.0})

    assert response.status_code == 400
    assert "outside hard safety limits" in response.json()["detail"]


# ─── Motion safety helper ─────────────────────────────────────────────────


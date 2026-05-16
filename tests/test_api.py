from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from radiotelescope.main import create_app


def test_api_exposes_simulated_health(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["connection"]["mode"] == "simulated"


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

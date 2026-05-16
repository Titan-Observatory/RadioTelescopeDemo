from __future__ import annotations

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
    assert body["response"]["speed_qpps"] == 6000
    assert body["response"]["accel_qpps2"] == 7000


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
        accepted = client.post("/api/telescope/goto", json={"altitude_deg": 30, "azimuth_deg": 90})
        rejected = client.post("/api/telescope/goto", json={"altitude_deg": 5, "azimuth_deg": 90})

    assert accepted.status_code == 200
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

"""GOES proxy routes: auth gating + graceful degradation when the hardware
gateway is unreachable (the conftest config points at a dead port)."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from rt_platform.main import create_app


def _join_queue(client: TestClient) -> None:
    # Joining the queue with nobody else waiting grants immediate control.
    resp = client.post("/api/queue/join", json={"turnstile_token": None, "beta_password": None})
    assert resp.status_code == 200


def test_observation_requires_session_then_degrades_gracefully(platform_config_path: Path):
    with TestClient(create_app(platform_config_path)) as client:
        assert client.get("/api/observation").status_code == 403

        _join_queue(client)
        body = client.get("/api/observation").json()
        # Hardware unreachable → fall back to hydrogen-line so the UI renders.
        assert body["mode"] == "hydrogen_line"
        assert body["degraded"] is True


def test_goes_status_degrades_to_disconnected(platform_config_path: Path):
    with TestClient(create_app(platform_config_path)) as client:
        _join_queue(client)
        body = client.get("/api/goes/status").json()
        assert body["mode"] == "disconnected"


def test_goes_mutations_require_control(platform_config_path: Path):
    with TestClient(create_app(platform_config_path)) as client:
        assert client.post("/api/goes/reconnect").status_code == 403
        assert client.get("/api/goes/products").status_code == 403


def test_goes_proxy_surfaces_502_when_gateway_down(platform_config_path: Path):
    with TestClient(create_app(platform_config_path)) as client:
        _join_queue(client)
        assert client.get("/api/goes/products").status_code == 502
        assert client.get("/api/goes/products/some-id/file").status_code == 502

"""API + service tests for GOES mode (simulate backend, no hardware/goestools)."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from rt_hardware.main import create_app


@pytest.fixture
def goes_config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from tests.fake_roboclaw import SimulatedRoboClaw

    monkeypatch.setattr("rt_hardware.main.make_client", lambda config: SimulatedRoboClaw(config))

    products_dir = tmp_path / "products"
    # Distinct filename: tests may use this fixture alongside
    # `simulated_config_path`, which also writes into tmp_path.
    path = tmp_path / "config-goes.toml"
    # as_posix() avoids backslashes in the path being parsed as TOML string
    # escapes (e.g. Windows "\Users\..." -> invalid \U escape). Forward-slash
    # paths are valid on Windows too.
    path.write_text(
        f"""
[general]
log_level = "DEBUG"

[roboclaw]
connect_mode = "auto"

[server]
host = "127.0.0.1"
port = 8001

[camera]
enabled = false

[observer]
latitude_deg = 38.9
longitude_deg = -77.0

[observation]
mode = "goes"

[goes]
simulate = true
products_dir = "{products_dir.as_posix()}"
""",
        encoding="utf-8",
    )
    return path


def _products_dir(app) -> Path:
    return app.state.goes_service.products.directory


def test_observation_endpoint_reports_goes_mode_with_look_angles(goes_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        body = client.get("/api/observation").json()

    assert body["mode"] == "goes"
    assert body["downlink_freq_mhz"] == pytest.approx(1694.1)
    assert body["symbol_rate_baud"] == pytest.approx(927_000)
    assert body["target_satellite_id"] == "goes-east"
    sats = {s["id"]: s for s in body["satellites"]}
    assert sats["goes-east"]["is_target"] is True
    # DC → GOES-East: high in the southern sky.
    assert 40.0 < sats["goes-east"]["elevation_deg"] < 48.0
    assert sats["goes-east"]["visible"] is True


def test_observation_endpoint_defaults_to_hydrogen_line(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        body = client.get("/api/observation").json()

    assert body["mode"] == "hydrogen_line"
    assert body["satellites"] == []


def test_modes_are_mutually_exclusive(goes_config_path, simulated_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        assert client.get("/api/goes/status").json()["enabled"] is True
        # Spectrum service is not instantiated in GOES mode.
        assert client.get("/api/spectrum/status").json()["mode"] == "disabled"

    with TestClient(create_app(simulated_config_path)) as client:
        assert client.get("/api/goes/status").json() == {"enabled": False, "mode": "disabled"}
        assert client.get("/api/spectrum/status").json()["enabled"] is True


def test_goes_status_snapshot_shape(goes_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        body = client.get("/api/goes/status").json()

    assert body["enabled"] is True
    assert body["mode"] == "idle"  # lazy: nothing spawned until a subscriber
    assert body["backend"] == "simulate"
    assert body["downlink_mode"] == "hrit"
    assert body["symbol_rate_baud"] == 927_000
    assert body["products_total"] == 0


def test_goes_ws_streams_simulated_frames(goes_config_path):
    with TestClient(create_app(goes_config_path)) as client:
        with client.websocket_connect("/ws/goes") as ws:
            frame = ws.receive_json()

    assert frame["stage"] in ("searching", "signal", "frames", "data")
    assert frame["snr_db"] is not None
    assert len(frame["constellation"]) > 0
    assert frame["snr_lock_db"] == 4.0
    assert "freq_offset_hz" in frame and "data_rate_kbps" in frame


def test_products_endpoints_serve_files_from_product_tree(goes_config_path):
    app = create_app(goes_config_path)
    with TestClient(app) as client:
        # Drop a file where goesproc would write it; the list endpoint rescans.
        bulletin_dir = _products_dir(app) / "text" / "2026-06-12"
        bulletin_dir.mkdir(parents=True)
        bulletin = bulletin_dir / "20260612T000000Z_TEST.txt"
        bulletin.write_text("GOES BULLETIN\nProduct index integration test.\n")
        import os
        os.utime(bulletin, (1.0, 1.0))  # old mtime → past the mid-write guard

        listing = client.get("/api/goes/products").json()
        assert listing["total"] == 1
        product = listing["products"][0]
        assert product["kind"] == "text"
        assert product["name"] == "20260612T000000Z_TEST.txt"
        assert product["group"] == "text/2026-06-12"
        assert "Product index" in product["preview"]
        assert product["media_type"] == "text/plain"

        file_resp = client.get(f"/api/goes/products/{product['id']}/file")
        assert file_resp.status_code == 200
        assert b"Product index" in file_resp.content

        assert client.get("/api/goes/products/unknown-id/file").status_code == 404


def test_goes_endpoints_404_in_hydrogen_mode(simulated_config_path):
    with TestClient(create_app(simulated_config_path)) as client:
        assert client.get("/api/goes/products").status_code == 404
        assert client.post("/api/goes/reconnect").status_code == 404


def test_product_index_survives_restart(goes_config_path):
    app = create_app(goes_config_path)
    with TestClient(app):
        keep = _products_dir(app) / "images" / "KEEP.png"
        keep.parent.mkdir(parents=True)
        keep.write_bytes(b"\x89PNG\r\n\x1a\nfake")
        import os
        os.utime(keep, (1.0, 1.0))

    app2 = create_app(goes_config_path)
    with TestClient(app2) as client:
        listing = client.get("/api/goes/products").json()
        assert listing["total"] == 1
        assert listing["products"][0]["name"] == "KEEP.png"
        assert listing["products"][0]["kind"] == "image"


def test_simulator_locks_and_produces_products_when_pointed(goes_config_path, tmp_path):
    """Drive the simulator directly: pointed at the satellite it reaches lock
    SNR and writes demo products; far off it stays near the noise floor."""
    from rt_hardware.config import load_config
    from rt_hardware.goes.simulator import GoesSimulator

    cfg = load_config(goes_config_path).goes

    on_target = GoesSimulator(cfg, tmp_path / "p1", pointing_error_deg=lambda: 0.05, beam_fwhm_deg=1.2)
    for _ in range(30):
        tick = on_target.tick()
    assert on_target.locked
    assert any(s["ok"] for s in tick.decoder_stats)
    assert len(tick.vcids) > 0
    # A demo product landed in the (simulated) goesproc output tree.
    assert any((tmp_path / "p1").rglob("*.png")) or any((tmp_path / "p1").rglob("*.txt"))

    off_target = GoesSimulator(cfg, tmp_path / "p2", pointing_error_deg=lambda: 5.0, beam_fwhm_deg=1.2)
    for _ in range(30):
        tick = off_target.tick()
    assert not off_target.locked
    assert tick.decoder_stats == []
    assert not any((tmp_path / "p2").rglob("*"))

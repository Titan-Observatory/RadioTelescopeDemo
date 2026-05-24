from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from rt_platform.main import create_app


def test_rt_env_includes_gtag_debug_flag(platform_config_path: Path):
    text = platform_config_path.read_text(encoding="utf-8")
    platform_config_path.write_text(
        'gtag_id = "G-TEST123"\ngtag_debug = true\n' + text,
        encoding="utf-8",
    )

    with TestClient(create_app(platform_config_path)) as client:
        response = client.get("/rt-env.js")

    assert response.status_code == 200
    assert '"gtagId": "G-TEST123"' in response.text
    assert '"gtagDebug": true' in response.text

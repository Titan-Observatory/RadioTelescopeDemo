from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def simulated_config_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Config that loads the test SimulatedRoboClaw in place of the real driver.

    Production code only ships SerialRoboClaw + NullRoboClaw; this fixture
    monkey-patches `make_client` so tests still get an in-memory RoboClaw that
    accepts commands and returns plausible telemetry.
    """
    from tests.fake_roboclaw import SimulatedRoboClaw

    def fake_make_client(config):
        return SimulatedRoboClaw(config)

    # main.py does `from radiotelescope.hardware.roboclaw import make_client`,
    # so the bound name lives on the main module — patch there.
    monkeypatch.setattr("radiotelescope.main.make_client", fake_make_client)

    path = tmp_path / "config.toml"
    path.write_text(
        """
[general]
log_level = "DEBUG"

[roboclaw]
port = "SIM"
baudrate = 38400
address = 128
timeout_s = 0.1
connect_mode = "auto"

[telemetry]
update_rate_hz = 5

[mount]
az_counts_per_degree = 10.0
alt_counts_per_degree = 20.0
az_zero_count = 100
alt_zero_count = 200
goto_speed_qpps = 3000
goto_accel_qpps2 = 4000
goto_decel_qpps2 = 5000

[server]
host = "127.0.0.1"
port = 8000
cors_origins = ["*"]
allowed_clients = ["testclient"]
""",
        encoding="utf-8",
    )
    return path

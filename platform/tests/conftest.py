from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture
def platform_config_path(tmp_path: Path) -> Path:
    """A minimal LAN-only platform config that boots without contacting hardware."""
    path = tmp_path / "config.toml"
    path.write_text(
        """
hardware_url = "http://127.0.0.1:65535"  # unreachable on purpose; tests must not depend on a live backend

[general]
log_level = "DEBUG"

[server]
host = "127.0.0.1"
port = 8000
cors_origins = ["http://localhost:5173"]
allowed_clients = []
trusted_proxies = ["127.0.0.1"]
lan_only = false

[rate_limit]
enabled = true

[queue]
enabled = true
max_session_seconds = 600
idle_timeout_seconds = 60
max_sessions_per_ip = 10
join_cooldown_seconds = 0
cookie_secret = "test-cookie-secret-test"
cookie_name = "rt_session"

[auth]
enabled = false

[turnstile]
enabled = false
""",
        encoding="utf-8",
    )
    return path

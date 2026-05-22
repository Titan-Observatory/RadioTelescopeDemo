import pytest

from radiotelescope.config import load_config


def test_load_config_defaults_to_auto_when_requested(simulated_config_path):
    cfg = load_config(simulated_config_path)

    assert cfg.roboclaw.port == "SIM"
    assert cfg.roboclaw.address == 0x80
    assert cfg.roboclaw.connect_mode == "auto"
    assert cfg.telemetry.update_rate_hz == 5
    assert cfg.mount.az_counts_per_degree == 10.0
    assert cfg.mount.alt_counts_per_degree == 20.0
    assert cfg.sdr.lna_bias_tee_enabled is False


def test_load_config_substitutes_env_vars(simulated_config_path, monkeypatch):
    monkeypatch.setenv("RT_QUEUE_COOKIE_SECRET", "from-env-not-from-toml-abcdef")
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8") + """
[queue]
enabled = true
cookie_secret = "${RT_QUEUE_COOKIE_SECRET}"
""",
        encoding="utf-8",
    )

    cfg = load_config(simulated_config_path)
    assert cfg.queue.cookie_secret == "from-env-not-from-toml-abcdef"


def test_load_config_env_var_default_fallback(simulated_config_path, monkeypatch):
    monkeypatch.delenv("RT_OPTIONAL_THING", raising=False)
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8") + """
[queue]
enabled = true
cookie_secret = "${RT_OPTIONAL_THING:-fallback-secret-1234}"
""",
        encoding="utf-8",
    )

    cfg = load_config(simulated_config_path)
    assert cfg.queue.cookie_secret == "fallback-secret-1234"


def test_load_config_missing_env_var_without_default_raises(simulated_config_path, monkeypatch):
    monkeypatch.delenv("RT_NEVER_SET", raising=False)
    simulated_config_path.write_text(
        simulated_config_path.read_text(encoding="utf-8") + """
[queue]
enabled = true
cookie_secret = "${RT_NEVER_SET}"
""",
        encoding="utf-8",
    )

    with pytest.raises(KeyError, match="RT_NEVER_SET"):
        load_config(simulated_config_path)

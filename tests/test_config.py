from radiotelescope.config import load_config


def test_load_config_defaults_to_simulated_when_requested(simulated_config_path):
    cfg = load_config(simulated_config_path)

    assert cfg.roboclaw.port == "SIM"
    assert cfg.roboclaw.address == 0x80
    assert cfg.roboclaw.connect_mode == "simulated"
    assert cfg.telemetry.update_rate_hz == 5
    assert cfg.mount.az_counts_per_degree == 10.0
    assert cfg.mount.alt_counts_per_degree == 20.0
    assert cfg.sdr.lna_bias_tee_enabled is False

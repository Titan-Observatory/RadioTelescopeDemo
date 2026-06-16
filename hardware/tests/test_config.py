import pytest

from rt_hardware.config import SDRConfig, load_config
from rt_hardware.hardware.sdr import _bias_command


def test_sdr_defaults_to_airspy_driver():
    cfg = SDRConfig()
    assert cfg.driver == "airspy"
    assert cfg.device_string == "driver=airspy"
    assert cfg.gain_max == 21.0


def test_sdr_rtlsdr_driver_string_and_gain_bound():
    cfg = SDRConfig(driver="rtlsdr", sample_rate_hz=2.4e6, device_args="serial=00000101")
    assert cfg.device_string == "driver=rtlsdr,serial=00000101"
    assert cfg.gain_max == 49.6


def test_sdr_rtlsdr_rejects_out_of_range_sample_rate():
    with pytest.raises(ValueError, match="rtlsdr"):
        SDRConfig(driver="rtlsdr", sample_rate_hz=6.0e6)


def test_bias_command_selects_tool_per_driver():
    assert _bias_command("airspy", "1") == ("airspy_gpio", "-p", "1", "-n", "13", "-w", "1")
    assert _bias_command("rtlsdr", "0") == ("rtl_biast", "-b", "0")


def test_load_config_defaults_to_auto_when_requested(simulated_config_path):
    cfg = load_config(simulated_config_path)

    assert cfg.roboclaw.port == "SIM"
    assert cfg.roboclaw.address == 0x80
    assert cfg.roboclaw.connect_mode == "auto"
    assert cfg.telemetry.update_rate_hz == 5
    assert cfg.mount.az_counts_per_degree == -10.0
    assert cfg.mount.alt_counts_per_degree == 20.0
    assert cfg.sdr.lna_bias_tee_enabled is False


def test_load_config_substitutes_env_vars(tmp_path, monkeypatch):
    monkeypatch.setenv("RT_HW_LOG_LEVEL", "DEBUG")
    path = tmp_path / "config.toml"
    path.write_text(
        """
[general]
log_level = "${RT_HW_LOG_LEVEL}"
""",
        encoding="utf-8",
    )

    cfg = load_config(path)
    assert cfg.general.log_level == "DEBUG"


def test_load_config_env_var_default_fallback(tmp_path, monkeypatch):
    monkeypatch.delenv("RT_HW_OPTIONAL_THING", raising=False)
    path = tmp_path / "config.toml"
    path.write_text(
        """
[general]
log_level = "${RT_HW_OPTIONAL_THING:-WARNING}"
""",
        encoding="utf-8",
    )

    cfg = load_config(path)
    assert cfg.general.log_level == "WARNING"


def test_load_config_missing_env_var_without_default_raises(tmp_path, monkeypatch):
    monkeypatch.delenv("RT_HW_NEVER_SET", raising=False)
    path = tmp_path / "config.toml"
    path.write_text(
        """
[general]
log_level = "${RT_HW_NEVER_SET}"
""",
        encoding="utf-8",
    )

    with pytest.raises(KeyError, match="RT_HW_NEVER_SET"):
        load_config(path)

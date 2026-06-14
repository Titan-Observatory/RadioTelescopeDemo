"""Smoke tests for the GNU Radio spectrum pipeline subprocess.

These tests are gated on GNU Radio actually being importable. On CI / dev
laptops without GNU Radio installed they skip cleanly — they're meant to
catch regressions on the Pi where the runtime dep is present.
"""
from __future__ import annotations

import numpy as np
import pytest

from rt_hardware.config import SDRConfig
from rt_hardware.sdr_pipeline import despur_spectrum


# ── Spur rejection (pure numpy — runs everywhere, no GNU Radio needed) ───────

# 1 MHz spanned by 1024 bins ≈ 977 Hz/bin, so a single bin ≈ 1 kHz wide.
_SR = 1.0e6


def test_despur_removes_narrowband_spike():
    # A tall birdie a few bins wide sitting on a flat floor must be flattened
    # back to the floor; its neighbours are left untouched.
    power = np.full(1024, 100.0, dtype=np.float32)
    power[400:404] += 5000.0  # ~4 kHz spur, way above the floor

    out = despur_spectrum(power, _SR, threshold_db=6.0, max_width_khz=50.0)

    assert out[400:404] == pytest.approx([100.0] * 4, rel=1e-3)
    assert out[200] == pytest.approx(100.0, rel=1e-3)  # untouched elsewhere


def test_despur_does_not_mutate_input():
    power = np.full(1024, 100.0, dtype=np.float32)
    power[500] += 5000.0
    before = power.copy()

    despur_spectrum(power, _SR, threshold_db=6.0, max_width_khz=50.0)

    assert np.array_equal(power, before)


def test_despur_preserves_broad_hydrogen_line():
    # A gentle ~275 kHz-wide bump (like the 21 cm line) is real signal and must
    # survive: it is far wider than the kHz width gate, and its gradual shoulders
    # never clear the threshold against the moving-average trend.
    x = np.arange(1024)
    # ~4 dB bump in power: 10**(4/10) ≈ 2.5× over a 100-unit floor.
    bump = 1.0 + 1.5 * np.exp(-0.5 * ((x - 512) / 70.0) ** 2)
    power = (100.0 * bump).astype(np.float32)

    out = despur_spectrum(power, _SR, threshold_db=6.0, max_width_khz=50.0)

    assert out == pytest.approx(power, rel=1e-3)


def test_despur_disabled_at_zero_threshold():
    power = np.full(1024, 100.0, dtype=np.float32)
    power[400] += 5000.0

    out = despur_spectrum(power, _SR, threshold_db=0.0, max_width_khz=50.0)

    assert np.array_equal(out, power)


# ── Flowgraph construction (gated on GNU Radio actually being importable) ────

pytest.importorskip("gnuradio", reason="GNU Radio not installed in this environment")


def test_pipeline_module_imports_without_gnu_radio_runtime():
    """The pipeline module itself loads even before the heavy imports happen.

    Imports of gnuradio.* are deferred to `build_flowgraph` so that this
    module can be loaded by tests, packaging tools, and `python -m help`
    on hosts without the system dep.
    """
    import rt_hardware.sdr_pipeline as pipeline  # noqa: F401 — import is the test

    assert hasattr(pipeline, "build_flowgraph")
    assert hasattr(pipeline, "main")


def test_pipeline_builds_flowgraph_with_default_config():
    """Constructing the flowgraph should succeed with a stock config.

    We don't start it (that would try to open the Airspy). We just want to
    confirm the block wiring, parameter coercion, and IPC path all parse.
    Skipped automatically if gr-soapy is missing — the soapy.source
    constructor will raise ImportError chained through RuntimeError.
    """
    from rt_hardware import sdr_pipeline

    class _Cfg:
        sdr = SDRConfig()
        general = type("G", (), {"log_level": "INFO"})()

    try:
        tb = sdr_pipeline.build_flowgraph(_Cfg())
    except RuntimeError as exc:
        if "gr-soapy" in str(exc):
            pytest.skip("gr-soapy not installed in this environment")
        raise

    # Smoke: top_block has its connected blocks and a sane name.
    assert tb.name() == "rt-spectrum-pipeline"


def test_pipeline_builds_flowgraph_with_rtlsdr_driver():
    """The flowgraph wiring is driver-agnostic — building it for the rtlsdr
    driver (Nooelec NESDR etc.) should parse just like the Airspy default.

    Requires soapysdr-module-rtlsdr at run time, but construction only needs
    gr-soapy; skipped when that's missing.
    """
    from rt_hardware import sdr_pipeline

    class _Cfg:
        sdr = SDRConfig(driver="rtlsdr", sample_rate_hz=2.4e6)
        general = type("G", (), {"log_level": "INFO"})()

    try:
        tb = sdr_pipeline.build_flowgraph(_Cfg())
    except RuntimeError as exc:
        if "gr-soapy" in str(exc):
            pytest.skip("gr-soapy not installed in this environment")
        raise

    assert tb.name() == "rt-spectrum-pipeline"

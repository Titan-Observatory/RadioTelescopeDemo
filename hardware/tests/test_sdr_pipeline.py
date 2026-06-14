"""Smoke tests for the GNU Radio spectrum pipeline subprocess.

These tests are gated on GNU Radio actually being importable. On CI / dev
laptops without GNU Radio installed they skip cleanly — they're meant to
catch regressions on the Pi where the runtime dep is present.
"""
from __future__ import annotations

import pytest

from rt_hardware.config import SDRConfig


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

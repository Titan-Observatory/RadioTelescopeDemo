"""GNU Radio flowgraph that produces integrated power spectra.

Runs as a standalone subprocess spawned by :class:`SpectrumService`. We use
GNU Radio (with NEON-optimised FFTW) rather than NumPy because the Pi 3B+
can't sustain 3 Msps FFT + EMA in Python — the asyncio + per-chunk thread-hop
overhead drops 60-80% of samples. GNU Radio's native scheduler runs the whole
chain in C++ with back-pressure between blocks, so throughput is bounded by
arithmetic rather than Python overhead.

Flowgraph::

    soapy.source(airspy)
        │  complex64 @ sample_rate_hz
        ▼
    blocks.stream_to_vector(fft_size)
        ▼
    fft.fft_vcc(fft_size, forward, hann, shift=True)
        ▼
    blocks.complex_to_mag_squared(fft_size)
        ▼
    blocks.integrate_ff(K, fft_size)
        │  float32[fft_size] @ ~publish_rate_hz
        ▼
    zeromq.pub_sink

The integration ratio ``K`` is chosen so that one published vector covers
``1 / publish_rate_hz`` of wall-clock time, i.e. averages
``(sample_rate_hz / fft_size) / publish_rate_hz`` raw FFTs. The Python
consumer ([rt_hardware.services.spectrum.SpectrumService]) layers a longer
EMA on top of this for the displayed integration window.

This module is intentionally importable only when GNU Radio is installed
(``apt install gnuradio gr-soapy``). The :class:`SpectrumService` consumer
handles the unavailable case by reporting ``mode="unavailable"``.
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys

from rt_hardware.config import load_config

logger = logging.getLogger(__name__)


def build_flowgraph(cfg):
    """Construct and return a configured ``gr.top_block``.

    Imports GNU Radio lazily so the module can be imported (e.g. by tests
    that just want to confirm it exists) without the runtime dependency.
    """
    # Imports are deferred so this module can be loaded for help text /
    # arg parsing on hosts without GNU Radio installed.
    from gnuradio import blocks, fft, gr, zeromq  # type: ignore[import-not-found]
    from gnuradio.fft import window  # type: ignore[import-not-found]

    try:
        from gnuradio import soapy  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "gr-soapy is not installed. On Debian/Ubuntu: `apt install gr-soapy`."
        ) from exc

    sdr = cfg.sdr
    fft_size = int(sdr.fft_size)
    sample_rate = float(sdr.sample_rate_hz)
    centre = float(sdr.center_freq_hz)

    # One published spectrum per (1 / publish_rate_hz) seconds. At 3 Msps,
    # fft_size=8192, publish_rate=5 Hz this averages 73 raw FFTs per output.
    raw_fft_rate = sample_rate / fft_size
    integrate_k = max(1, round(raw_fft_rate / float(sdr.publish_rate_hz)))

    tb = gr.top_block("rt-spectrum-pipeline")

    # ── Source ────────────────────────────────────────────────────────
    # gr-soapy's source block constructor signature varies slightly across
    # versions; this matches GR 3.10 (Bookworm). Keep arguments minimal and
    # set tunables via the typed setters so the call works on 3.10.x.
    source = soapy.source(
        "driver=airspy",
        "fc32",  # complex float32 sample format
        1,        # nchan
        "",       # dev_args (empty — already in device string)
        "",       # stream_args
        [""],     # tune_args
        [""],     # other_settings
    )
    source.set_sample_rate(0, sample_rate)
    source.set_frequency(0, centre)
    if sdr.gain_db is None:
        source.set_gain_mode(0, True)  # AGC on
    else:
        source.set_gain_mode(0, False)
        # Airspy's "overall" gain is a 0-21 linearity index; clamp.
        gain = max(0.0, min(21.0, float(sdr.gain_db)))
        source.set_gain(0, gain)
    # Bias-tee state is owned by the FastAPI service via airspy_gpio (see
    # rt_hardware.hardware.sdr); we don't touch it here so the toggle remains
    # available while the pipeline is running.

    # ── DSP chain ─────────────────────────────────────────────────────
    s2v = blocks.stream_to_vector(gr.sizeof_gr_complex, fft_size)
    fft_block = fft.fft_vcc(fft_size, True, window.hann(fft_size), True, 1)
    mag2 = blocks.complex_to_mag_squared(fft_size)
    integrator = blocks.integrate_ff(integrate_k, fft_size)

    # ── Sink ──────────────────────────────────────────────────────────
    # Vector-typed PUB sink — each ZMQ message carries one full Float32
    # spectrum of length fft_size. ``hwm=2`` keeps the queue tight so a
    # stalled consumer can't accumulate stale spectra.
    sink = zeromq.pub_sink(
        gr.sizeof_float,
        fft_size,
        sdr.pipeline_ipc_path,
        100,   # timeout (ms)
        False, # pass_tags
        2,     # hwm
        "",    # key
    )

    tb.connect(source, s2v, fft_block, mag2, integrator, sink)

    logger.info(
        "Flowgraph built: %.3f MHz centre, %.1f Msps, fft=%d, integrate=%d × FFT (~%.1f Hz output), ipc=%s",
        centre / 1e6, sample_rate / 1e6, fft_size, integrate_k,
        raw_fft_rate / integrate_k, sdr.pipeline_ipc_path,
    )
    return tb


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GNU Radio spectrum pipeline (subprocess of rt-hardware).")
    parser.add_argument("-c", "--config", required=True, help="Path to hardware config.toml")
    args = parser.parse_args(argv)

    cfg = load_config(args.config)
    logging.basicConfig(
        level=getattr(logging, cfg.general.log_level, logging.INFO),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        stream=sys.stderr,
    )

    if not cfg.sdr.enabled:
        logger.info("SDR disabled in config; exiting.")
        return 0

    tb = build_flowgraph(cfg)

    # Install signal handlers so the parent service can shut us down cleanly.
    def _shutdown(signum, _frame):
        logger.info("Received signal %d; stopping flowgraph", signum)
        tb.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    tb.start()
    tb.wait()
    logger.info("Flowgraph exited cleanly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

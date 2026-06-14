"""GNU Radio flowgraph that produces baseline-corrected power spectra.

Runs as a standalone subprocess spawned by :class:`SpectrumService`. We use
GNU Radio (with NEON-optimised FFTW) rather than NumPy because the Pi 3B+
can't sustain 3 Msps FFT + integration in Python — the asyncio + per-chunk
thread-hop overhead drops 60-80% of samples. GNU Radio's native scheduler runs
the whole chain in C++ with back-pressure between blocks, so throughput is
bounded by arithmetic rather than Python overhead.

The flowgraph owns the *entire* DSP path: FFT, integration (rolling EMA),
baseline division and the dB conversion. The Python consumer
([rt_hardware.services.spectrum.SpectrumService]) is a pure forwarder — it
just packages each finished spectrum into a WebSocket frame. This keeps a
single processing stream rather than splitting work between C++ and numpy.

Live flowgraph::

    soapy.source(airspy)
        │  complex64 @ sample_rate_hz
        ▼
    blocks.stream_to_vector(fft_size)
        ▼
    fft.fft_vcc(fft_size, forward, hann, shift=True)
        ▼
    blocks.complex_to_mag_squared(fft_size)
        ▼
    blocks.integrate_ff(K, fft_size)            # block-average K raw FFTs
        ▼
    _SpurReject(fft_size)                        # despur (before the EMA sees it)
        ▼
    filter.single_pole_iir_filter_ff(α, fft_size)   # rolling EMA window
        ▼
    blocks.multiply_const_vff(1 / baseline)     # baseline division (no-op if none)
        ▼
    blocks.nlog10_ff(10, fft_size, offset_db)   # → dB (+ optional offset)
        ▼
    zeromq.pub_sink                              # float32[fft_size] @ ~publish_rate_hz

``K`` is chosen so one ``integrate_ff`` output covers ``1 / publish_rate_hz``
of wall-clock time. The EMA constant ``α = 1 / integration_frames`` realises
the displayed integration window while keeping output at publish-rate (so the
line chart + waterfall stay live). Pushing the window into a decimating
``integrate_ff`` instead would drop output to one frame per ``integration_seconds``.

Baseline capture (``--capture-baseline <path>``) runs a one-shot variant that
integrates a full window, scales it to a per-bin mean matching one settled live
frame, and writes a single float32[fft_size] vector to ``<path>`` before
exiting::

    soapy → s2v → fft → mag² → integrate_ff(total) → multiply_const_vff(K/total)
          → _SpurReject → head(1) → file_sink(<path>)

The live flowgraph then loads that file and divides by it. Because the captured
baseline has the same magnitude as a settled live frame, ``power / baseline ≈ 1``
→ ~0 dB across the band when corrected.

This module is intentionally importable only when GNU Radio is installed
(``apt install gnuradio gr-soapy``). The :class:`SpectrumService` consumer
handles the unavailable case by reporting ``mode="unavailable"``.
"""
from __future__ import annotations

import argparse
import logging
import signal
import sys
from pathlib import Path

import numpy as np

from rt_hardware.config import load_config

logger = logging.getLogger(__name__)

# Floor applied to baseline power before taking its reciprocal, so a dead bin
# (zero power) doesn't blow the division up to infinity. Matches the floor the
# service uses when persisting the baseline JSON sidecar.
POWER_FLOOR = 1e-12


def _moving_average(values: np.ndarray, window: int) -> np.ndarray:
    """Edge-padded moving average across frequency bins, O(n) via cumsum.

    ``window`` is forced odd; 0 or 1 is a no-op. Used as the slowly-varying
    spectral trend that spur rejection measures spikes against — cheap enough
    to run on every integrated frame even at tens of thousands of bins.
    """
    if window <= 1 or values.size == 0:
        return values.astype(np.float32, copy=False)
    k = int(window) | 1  # force odd
    if k >= values.size:
        return np.full_like(values, float(np.mean(values)), dtype=np.float32)
    pad = k // 2
    padded = np.pad(values, pad, mode="edge")
    csum = np.cumsum(padded, dtype=np.float64)
    sums = csum[k - 1:] - np.concatenate(([0.0], csum[:-k]))
    return (sums / k).astype(np.float32)


def despur_spectrum(
    power: np.ndarray,
    sample_rate_hz: float,
    threshold_db: float,
    max_width_khz: float,
) -> np.ndarray:
    """Replace narrowband spurs in a linear-power spectrum with the local trend.

    Operates on the FFT-shifted (monotonic-frequency) integrated power vector,
    in the linear domain GNU Radio hands us — so it slots in before the dB
    conversion, the EMA window and any baseline division. Spurs are judged in dB
    against a wide moving-average trend (which steps over the handful of bins a
    birdie spans yet still follows the broad hydrogen line): a bin rising more
    than ``threshold_db`` above the trend, inside a contiguous run no wider than
    ``max_width_khz``, has its power overwritten by the trend power. Runs wider
    than that are real structure and are left alone. Width is reasoned about in
    frequency, so the reject behaves identically at any fft_size / sample rate.

    Returns a new array; the input is not mutated.
    """
    n = int(power.size)
    if threshold_db <= 0 or max_width_khz <= 0 or n < 8:
        return np.asarray(power, dtype=np.float32)
    bin_hz = float(sample_rate_hz) / n
    if bin_hz <= 0:
        return np.asarray(power, dtype=np.float32)
    max_width_bins = max(1, round(max_width_khz * 1e3 / bin_hz))

    floored = np.maximum(np.asarray(power, dtype=np.float32), POWER_FLOOR)
    db = (10.0 * np.log10(floored)).astype(np.float32)
    # Trend window several times wider than the widest spur so a birdie sitting
    # inside it can't drag the local average up to itself.
    trend_window = min(n - 1, max(3, 6 * max_width_bins))
    trend_db = _moving_average(db, trend_window)
    flagged = (db - trend_db) > threshold_db

    out = np.array(power, dtype=np.float32)  # copy; never mutate the input
    i = 0
    while i < n:
        if not flagged[i]:
            i += 1
            continue
        j = i
        while j < n and flagged[j]:
            j += 1
        if (j - i) <= max_width_bins:
            # Overwrite the spur bins with the trend *power* (back out of dB).
            out[i:j] = (10.0 ** (trend_db[i:j] / 10.0)).astype(np.float32)
        i = j
    return out


def _build_despur_block(sdr, fft_size: int):
    """Embedded GNU Radio block that runs :func:`despur_spectrum` per frame.

    A vector ``sync_block`` (float32[fft_size] in/out) so it drops straight into
    the chain after ``integrate_ff``. Constructed lazily — imports ``gr`` — so
    the surrounding module stays importable without GNU Radio.
    """
    from gnuradio import gr  # type: ignore[import-not-found]

    sample_rate_hz = float(sdr.sample_rate_hz)
    threshold_db = float(sdr.spur_threshold_db)
    max_width_khz = float(sdr.spur_max_width_khz)

    class _SpurReject(gr.sync_block):  # type: ignore[misc]
        def __init__(self) -> None:
            gr.sync_block.__init__(
                self,
                name="spur_reject",
                in_sig=[(np.float32, fft_size)],
                out_sig=[(np.float32, fft_size)],
            )

        def work(self, input_items, output_items):  # noqa: D401 — GR signature
            inp = input_items[0]
            out = output_items[0]
            for k in range(inp.shape[0]):
                out[k, :] = despur_spectrum(
                    inp[k], sample_rate_hz, threshold_db, max_width_khz,
                )
            return inp.shape[0]

    return _SpurReject()


def _load_baseline_reciprocal(baseline_path: str | None, fft_size: int) -> list[float] | None:
    """Read a captured baseline ``.f32`` and return ``1 / baseline`` per bin.

    Returns ``None`` (→ no division) when the file is absent or its length
    doesn't match the current FFT layout. The service clears the baseline on
    any FFT/centre/sample-rate change, so a mismatch here is belt-and-braces.
    """
    if not baseline_path:
        return None
    path = Path(baseline_path)
    if not path.exists():
        return None
    baseline = np.fromfile(path, dtype=np.float32)
    if baseline.size != fft_size:
        logger.warning(
            "Baseline %s has %d bins, expected %d — ignoring.",
            path, baseline.size, fft_size,
        )
        return None
    baseline = np.maximum(baseline, POWER_FLOOR)
    return (1.0 / baseline).astype(np.float32).tolist()


def _build_source(soapy, sdr):
    """Construct the configured Soapy source (Airspy or RTL-SDR) with
    gain/tuning applied."""
    source = soapy.source(
        sdr.device_string,  # e.g. "driver=airspy" or "driver=rtlsdr"
        "fc32",  # complex float32 sample format
        1,        # nchan
        "",       # dev_args (empty — already in device string)
        "",       # stream_args
        [""],     # tune_args
        [""],     # other_settings
    )
    source.set_sample_rate(0, float(sdr.sample_rate_hz))
    source.set_frequency(0, float(sdr.center_freq_hz))
    if sdr.gain_db is None:
        source.set_gain_mode(0, True)  # AGC on
    else:
        source.set_gain_mode(0, False)
        # Clamp to the driver's gain range (Airspy: 0-21 linearity index;
        # RTL-SDR: 0-49.6 dB tuner gain).
        source.set_gain(0, max(0.0, min(sdr.gain_max, float(sdr.gain_db))))
    # Bias-tee state is owned by the FastAPI service via airspy_gpio / rtl_biast
    # (see rt_hardware.hardware.sdr); we don't touch it here so the toggle
    # remains available while the pipeline is running.
    return source


def build_flowgraph(cfg, baseline_path: str | None = None):
    """Construct and return the configured live ``gr.top_block``.

    Imports GNU Radio lazily so the module can be imported (e.g. by tests
    that just want to confirm it exists) without the runtime dependency.
    """
    # Imports are deferred so this module can be loaded for help text /
    # arg parsing on hosts without GNU Radio installed.
    from gnuradio import blocks, fft, filter as gr_filter, gr, zeromq  # type: ignore[import-not-found]
    from gnuradio.fft import window  # type: ignore[import-not-found]

    try:
        from gnuradio import soapy  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "gr-soapy is not installed. On Debian/Ubuntu: `apt install gr-soapy`."
        ) from exc

    # single_pole_iir_filter_ff ships in gr-filter, but be defensive about the
    # module split across GNU Radio versions so we never crash at spawn time.
    single_pole_iir = getattr(gr_filter, "single_pole_iir_filter_ff", None) \
        or getattr(blocks, "single_pole_iir_filter_ff")

    sdr = cfg.sdr
    fft_size = int(sdr.fft_size)
    sample_rate = float(sdr.sample_rate_hz)

    # One integrate_ff output per (1 / publish_rate_hz) seconds. At 3 Msps,
    # fft_size=8192, publish_rate=5 Hz this averages 73 raw FFTs per output.
    raw_fft_rate = sample_rate / fft_size
    integrate_k = max(1, round(raw_fft_rate / float(sdr.publish_rate_hz)))
    # EMA constant for the displayed integration window. integration_frames is
    # the number of publish-rate outputs inside one window; α = 1/N means each
    # output contributes ~1/N of the running value.
    alpha = 1.0 / max(1, int(sdr.integration_frames))

    tb = gr.top_block("rt-spectrum-pipeline")

    source = _build_source(soapy, sdr)

    # ── DSP chain ─────────────────────────────────────────────────────
    s2v = blocks.stream_to_vector(gr.sizeof_gr_complex, fft_size)
    fft_block = fft.fft_vcc(fft_size, True, window.hann(fft_size), True, 1)
    mag2 = blocks.complex_to_mag_squared(fft_size)
    integrator = blocks.integrate_ff(integrate_k, fft_size)
    ema = single_pole_iir(alpha, fft_size)

    chain = [source, s2v, fft_block, mag2, integrator]

    # ── Spur rejection ────────────────────────────────────────────────
    # Strip narrowband birdies / RFI from each integrated FFT *before* the EMA
    # window or any baseline division sees them, so a transient spur can neither
    # smear into the rolling trace nor get baked into a captured baseline.
    if sdr.spur_reject_enabled:
        chain.append(_build_despur_block(sdr, fft_size))

    chain.append(ema)

    # ── Baseline division ─────────────────────────────────────────────
    # multiply_const_vff by 1/baseline is an element-wise vector divide. When
    # no baseline is loaded we skip the block entirely (one fewer copy per
    # frame) — the output is then plain 10·log10(power).
    reciprocal = _load_baseline_reciprocal(baseline_path, fft_size)
    baseline_loaded = reciprocal is not None
    scale = float(sdr.baseline_scale)
    if baseline_loaded and scale != 1.0:
        # baseline_scale multiplies the stored baseline before division, i.e.
        # divide the reciprocal by the scale.
        reciprocal = [r / scale for r in reciprocal]
    if baseline_loaded:
        chain.append(blocks.multiply_const_vff(reciprocal))

    # ── dB conversion (+ optional offset) ─────────────────────────────
    # Floor the power before log10 so a dead (zero) bin can't produce -inf,
    # which would serialise as JSON "-Infinity" and break the browser parser.
    # POWER_FLOOR is negligible next to real signal/baseline-divided values.
    chain.append(blocks.add_const_vff([POWER_FLOOR] * fft_size))
    offset_db = float(sdr.baseline_offset_db)
    nlog10 = blocks.nlog10_ff(10.0, fft_size, offset_db)
    chain.append(nlog10)

    # ── Sink ──────────────────────────────────────────────────────────
    # Vector-typed PUB sink — each ZMQ message carries one full Float32
    # spectrum (in dB) of length fft_size. ``hwm=2`` keeps the queue tight so
    # a stalled consumer can't accumulate stale spectra.
    sink = zeromq.pub_sink(
        gr.sizeof_float,
        fft_size,
        sdr.pipeline_ipc_path,
        100,   # timeout (ms)
        False, # pass_tags
        2,     # hwm
        "",    # key
    )
    chain.append(sink)

    tb.connect(*chain)

    logger.info(
        "Live flowgraph built: %.3f MHz centre, %.1f Msps, fft=%d, integrate=%d × FFT "
        "(~%.1f Hz output), EMA α=%.4f, baseline=%s, offset=%.1f dB, ipc=%s",
        sdr.center_freq_hz / 1e6, sample_rate / 1e6, fft_size, integrate_k,
        raw_fft_rate / integrate_k, alpha,
        "loaded" if baseline_loaded else "none", offset_db, sdr.pipeline_ipc_path,
    )
    return tb


def build_capture_flowgraph(cfg, output_path: str):
    """Construct a one-shot flowgraph that writes a baseline ``.f32`` and exits.

    Integrates a full ``integration_seconds`` window of raw FFT power, scales it
    to the per-bin mean of one ``integrate_ff(K)`` block (so it matches the
    magnitude of a settled live frame), emits exactly one vector via
    ``head(1)`` and writes it to ``output_path``. ``tb.wait()`` returns once the
    single vector has flowed through, so the subprocess exits on its own.
    """
    from gnuradio import blocks, fft, gr  # type: ignore[import-not-found]
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
    raw_fft_rate = sample_rate / fft_size
    integrate_k = max(1, round(raw_fft_rate / float(sdr.publish_rate_hz)))
    # Total raw FFTs to sum over the full window, and the scale that turns that
    # sum into the mean of one K-block (= settled live-frame magnitude).
    total_ffts = max(integrate_k, round(raw_fft_rate * float(sdr.integration_seconds)))
    mean_scale = float(integrate_k) / float(total_ffts)

    tb = gr.top_block("rt-spectrum-baseline-capture")

    source = _build_source(soapy, sdr)
    s2v = blocks.stream_to_vector(gr.sizeof_gr_complex, fft_size)
    fft_block = fft.fft_vcc(fft_size, True, window.hann(fft_size), True, 1)
    mag2 = blocks.complex_to_mag_squared(fft_size)
    integrator = blocks.integrate_ff(total_ffts, fft_size)
    scale = blocks.multiply_const_vff([mean_scale] * fft_size)
    head = blocks.head(gr.sizeof_float * fft_size, 1)
    sink = blocks.file_sink(gr.sizeof_float * fft_size, output_path, False)
    sink.set_unbuffered(True)

    # Despur the integrated baseline before it's written, so a spur present
    # during capture is never baked into the stored reference (the live
    # flowgraph divides by this file, so a baked-in spur would notch the trace).
    chain = [source, s2v, fft_block, mag2, integrator, scale]
    if sdr.spur_reject_enabled:
        chain.append(_build_despur_block(sdr, fft_size))
    chain += [head, sink]

    tb.connect(*chain)

    logger.info(
        "Capture flowgraph built: integrating %d FFTs (~%.1f s) → %s",
        total_ffts, total_ffts / raw_fft_rate, output_path,
    )
    return tb


def _run(tb) -> None:
    """Start a top block, install signal handlers, and wait for it to finish."""
    def _shutdown(signum, _frame):
        logger.info("Received signal %d; stopping flowgraph", signum)
        tb.stop()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    tb.start()
    tb.wait()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="GNU Radio spectrum pipeline (subprocess of rt-hardware).")
    parser.add_argument("-c", "--config", required=True, help="Path to hardware config.toml")
    parser.add_argument(
        "--baseline",
        default=None,
        help="Path to a captured baseline .f32 to divide the live spectrum by.",
    )
    parser.add_argument(
        "--capture-baseline",
        default=None,
        metavar="PATH",
        help="Run a one-shot baseline capture, write the .f32 to PATH, and exit.",
    )
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

    if args.capture_baseline:
        tb = build_capture_flowgraph(cfg, args.capture_baseline)
        _run(tb)
        logger.info("Baseline capture complete: %s", args.capture_baseline)
        return 0

    tb = build_flowgraph(cfg, args.baseline)
    _run(tb)
    logger.info("Flowgraph exited cleanly.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

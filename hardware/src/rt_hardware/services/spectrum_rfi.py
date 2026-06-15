"""Pure RFI-detection DSP for the spectrum service.

These functions are deliberately free of any service/subprocess state: they take
a finished dB spectrum plus its frequency axis and return ``[lo_mhz, hi_mhz]``
bands describing where RFI sits. The spectrum itself is *never* modified — the
service forwards the untouched trace and the frontend shades these bands.

Split out of ``spectrum.py`` so the DSP can be unit-tested in isolation from the
GNU Radio subprocess lifecycle. ``SpectrumService`` re-exports ``_flag_rfi`` for
back-compat with existing callers/tests.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

# Broad-excess pass tuning. A second, shallower detector that catches wide bumps
# (e.g. a hydrogen-line-shaped feature) the narrow sigma-clip pass skips, so they
# still travel through ``rfi_bands`` for the frontend label path.
BROAD_RFI_MIN_DB = 0.08
BROAD_RFI_SIGNAL_WIDTH_KHZ = 120.0
BROAD_RFI_TREND_WIDTH_KHZ = 600.0


def _moving_average(values: np.ndarray, window: int) -> np.ndarray:
    """Edge-padded moving average across frequency bins, O(n) via cumsum.

    ``window`` is forced odd; 0 or 1 is a no-op. Used as the slowly-varying
    spectral trend the RFI sigma-clip detrends against — cheap enough to run on
    every published frame even at tens of thousands of bins.
    """
    if window <= 1 or values.size == 0:
        return np.asarray(values, dtype=np.float32)
    k = int(window) | 1  # force odd
    if k >= values.size:
        return np.full_like(values, float(np.mean(values)), dtype=np.float32)
    pad = k // 2
    padded = np.pad(values, pad, mode="edge")
    csum = np.cumsum(padded, dtype=np.float64)
    sums = csum[k - 1:] - np.concatenate(([0.0], csum[:-k]))
    return (sums / k).astype(np.float32)


def _runs_to_bands(
    flagged: np.ndarray,
    freqs_mhz: list[float],
    half_bin_mhz: float,
    accept: Callable[[int], bool],
) -> list[list[float]]:
    """Collapse contiguous runs of ``flagged`` bins into ``[lo, hi]`` MHz bands.

    ``accept`` receives each run's width in bins and decides whether to keep it,
    so the narrow and broad passes share this scan and differ only in their
    width test.
    """
    n = int(flagged.size)
    bands: list[list[float]] = []
    i = 0
    while i < n:
        if not flagged[i]:
            i += 1
            continue
        j = i
        while j < n and flagged[j]:
            j += 1
        if accept(j - i):
            lo = float(freqs_mhz[i]) - half_bin_mhz
            hi = float(freqs_mhz[j - 1]) + half_bin_mhz
            bands.append([round(lo, 6), round(hi, 6)])
        i = j
    return bands


def flag_rfi(
    values_db: np.ndarray,
    freqs_mhz: list[float],
    bin_hz: float,
    sigma: float,
    max_width_khz: float,
) -> list[list[float]]:
    """Detect RFI in a dB spectrum, returning ``[lo_mhz, hi_mhz]`` bands.

    The standard radio-astronomy spike detector (the same idea as
    ``astropy.stats.sigma_clip`` with median centre + MAD spread):

    1. Detrend with a wide moving average so receiver bandpass and broad
       structure do not inflate the narrow-spike pass.
    2. Estimate the noise from the median absolute deviation of the residual —
       ``σ ≈ 1.4826 · MAD`` — which spurs can't inflate the way a plain stdev
       would.
    3. Flag bins more than ``sigma`` robust-σ above the residual median.

    Each contiguous narrow run no wider than ``max_width_khz`` is reported as one
    ``[lo_mhz, hi_mhz]`` band. A second broad-excess pass catches shallow wide
    bumps against the local trend, because hydrogen-line shaped features should
    also travel through ``rfi_bands`` for the frontend label path. Width is in
    frequency, so detection behaves the same at any fft_size / sample rate. The
    spectrum itself is *never* modified — this only describes where the RFI is so
    the frontend can shade it.
    """
    n = int(values_db.size)
    if sigma <= 0 or max_width_khz <= 0 or bin_hz <= 0 or n < 8 or len(freqs_mhz) != n:
        return []
    max_width_bins = max(1, round(max_width_khz * 1e3 / bin_hz))
    vals = np.asarray(values_db, dtype=np.float32)

    trend = _moving_average(vals, min(n - 1, max(3, 6 * max_width_bins)))
    resid = vals - trend
    med = float(np.median(resid))
    robust_sigma = 1.4826 * float(np.median(np.abs(resid - med)))
    if robust_sigma <= 0:
        return []
    flagged = (resid - med) > sigma * robust_sigma

    half_bin_mhz = (bin_hz / 1e6) / 2.0
    bands = _runs_to_bands(flagged, freqs_mhz, half_bin_mhz, lambda w: w <= max_width_bins)
    bands.extend(_flag_broad_rfi(vals, freqs_mhz, bin_hz, max_width_bins, half_bin_mhz))
    return _merge_bands(bands)


def _flag_broad_rfi(
    values_db: np.ndarray,
    freqs_mhz: list[float],
    bin_hz: float,
    min_width_bins: int,
    half_bin_mhz: float,
) -> list[list[float]]:
    n = int(values_db.size)
    signal_bins = max(3, round(BROAD_RFI_SIGNAL_WIDTH_KHZ * 1e3 / bin_hz))
    trend_bins = max(signal_bins * 3, round(BROAD_RFI_TREND_WIDTH_KHZ * 1e3 / bin_hz))
    if n < trend_bins or min_width_bins <= 0:
        return []

    vals = np.asarray(values_db, dtype=np.float32)
    smoothed = _moving_average(vals, signal_bins)
    trend = _moving_average(vals, trend_bins)
    excess = smoothed - trend
    med = float(np.median(excess))
    robust_sigma = 1.4826 * float(np.median(np.abs(excess - med)))
    threshold = med + max(BROAD_RFI_MIN_DB, 3.0 * robust_sigma)
    flagged = excess > threshold

    return _runs_to_bands(flagged, freqs_mhz, half_bin_mhz, lambda w: w > min_width_bins)


def _merge_bands(bands: list[list[float]]) -> list[list[float]]:
    if not bands:
        return []
    ordered = sorted(bands, key=lambda band: band[0])
    merged = [ordered[0][:]]
    for lo, hi in ordered[1:]:
        last = merged[-1]
        if lo <= last[1]:
            last[1] = max(last[1], hi)
        else:
            merged.append([lo, hi])
    return [[round(lo, 6), round(hi, 6)] for lo, hi in merged]


__all__ = ("flag_rfi", "BROAD_RFI_MIN_DB", "BROAD_RFI_SIGNAL_WIDTH_KHZ", "BROAD_RFI_TREND_WIDTH_KHZ")

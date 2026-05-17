"""Spectrum service.

Pulls IQ chunks from `SDRReceiver`, computes Hann-windowed FFTs, maintains a
rolling exponential-moving-average integration, and publishes frames to
subscribers over an asyncio.Queue (drop-oldest on full).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from radiotelescope.config import SDRConfig
from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.services._sdr_task import SDRDriverTask

# Baseline cache lives next to where the server was launched so it survives
# restarts. Small JSON file — a couple thousand floats.
BASELINE_CACHE = Path("spectrum_baseline.json")

logger = logging.getLogger(__name__)


class SpectrumFrame(dict):
    """Plain dict so FastAPI's WebSocket can JSON-encode it cheaply."""


class SpectrumService(SDRDriverTask[SpectrumFrame]):
    name = "spectrum-service"

    def __init__(self, receiver: SDRReceiver, cfg: SDRConfig) -> None:
        super().__init__(receiver)
        self._cfg = cfg
        self._latest: SpectrumFrame | None = None
        self._integrated: np.ndarray | None = None
        self._frames_seen: int = 0
        self._window = np.hanning(cfg.fft_size).astype(np.float32)
        self._freqs_mhz = self._build_freq_axis()
        # Measured wall-clock cadence between FFT iterations. The driver yields
        # one IQ chunk per Soapy read regardless of `fft_size`, so the theoretical
        # `fft_size / sample_rate` underestimates the period by ~10×. We seed with
        # that theoretical value and let the EMA below drift it to reality.
        self._frame_period_s: float = cfg.fft_size / cfg.sample_rate_hz
        self._last_frame_monotonic: float | None = None

    def _build_freq_axis(self) -> np.ndarray:
        """FFT-shifted frequency axis in MHz, centred on `center_freq_hz`."""
        bin_hz = self._cfg.sample_rate_hz / self._cfg.fft_size
        # Standard centred axis: -N/2 .. N/2-1
        k = np.arange(self._cfg.fft_size, dtype=np.float64) - self._cfg.fft_size / 2.0
        return ((self._cfg.center_freq_hz + k * bin_hz) / 1e6).astype(np.float32)

    @property
    def latest(self) -> SpectrumFrame | None:
        return self._latest

    @property
    def frames_seen(self) -> int:
        return self._frames_seen

    def subscribe(self, maxsize: int | None = None) -> asyncio.Queue[SpectrumFrame]:
        # Replay the latest frame so a new subscriber doesn't have to wait up
        # to one publish interval to see anything.
        q = super().subscribe(maxsize)
        if self._latest is not None:
            q.put_nowait(self._latest)
        return q

    # ── Baseline capture / load / clear ──────────────────────────────────
    #
    # A captured baseline is a single integrated spectrum the user marks as
    # "reference" — typically a cold-sky / off-source scan. The frontend
    # subtracts it from the live trace to flatten the bandpass shape so the
    # 21 cm line stands out. We just store it; the subtraction happens on
    # the client side.

    def capture_baseline(self) -> dict[str, Any] | None:
        latest = self._latest
        if latest is None:
            return None
        baseline = {
            "captured_at": time.time(),
            "center_freq_mhz": latest["center_freq_mhz"],
            "sample_rate_mhz": latest["sample_rate_mhz"],
            "integration_frames": latest["integration_frames"],
            "freqs_mhz": list(latest["freqs_mhz"]),
            "power_db": list(latest["power_db"]),
        }
        try:
            BASELINE_CACHE.write_text(json.dumps(baseline))
        except Exception:
            logger.exception("Failed to persist baseline to %s", BASELINE_CACHE)
        return baseline

    def load_baseline(self) -> dict[str, Any] | None:
        if not BASELINE_CACHE.exists():
            return None
        try:
            return json.loads(BASELINE_CACHE.read_text())
        except Exception:
            logger.exception("Failed to read baseline from %s", BASELINE_CACHE)
            return None

    def clear_baseline(self) -> None:
        try:
            BASELINE_CACHE.unlink(missing_ok=True)
        except Exception:
            logger.exception("Failed to remove baseline cache %s", BASELINE_CACHE)

    # ── Integration controls ─────────────────────────────────────────────
    #
    # The rolling EMA window is configured through `sdr.integration_frames`.
    # The counter and accumulator can be reset together to start a fresh
    # integration.

    def reset_integration(self) -> None:
        self._integrated = None
        self._frames_seen = 0
        self._last_frame_monotonic = None

    async def _run(self) -> None:
        cfg = self._cfg
        publish_interval = 1.0 / cfg.publish_rate_hz
        last_publish = 0.0
        async for iq in self._rx.stream():
            if iq.size < cfg.fft_size:
                continue
            samples = iq[: cfg.fft_size]
            spectrum = np.fft.fftshift(np.fft.fft(samples * self._window))
            power = (spectrum.real ** 2 + spectrum.imag ** 2).astype(np.float32)
            # Avoid log(0); the FFT magnitudes never quite hit zero in practice
            # but a floor keeps the y-axis tidy when the gain is low.
            power = np.maximum(power, 1e-12)
            alpha = 1.0 / max(cfg.integration_frames, 1)
            if self._integrated is None:
                self._integrated = power
            else:
                self._integrated = (1.0 - alpha) * self._integrated + alpha * power
            self._frames_seen += 1

            now = time.monotonic()
            # Track real FFT cadence so the UI can show wall-clock integration
            # time honestly. EMA over ~32 frames smooths Soapy chunk-size jitter.
            if self._last_frame_monotonic is not None:
                dt = now - self._last_frame_monotonic
                if 0 < dt < 1.0:
                    self._frame_period_s += 0.03125 * (dt - self._frame_period_s)
            self._last_frame_monotonic = now

            if now - last_publish < publish_interval:
                continue
            last_publish = now
            self._publish(self._integrated)

    def _publish(self, integrated: np.ndarray) -> None:
        # Convert to dB; subtract median so the trace floats around 0 dB and the
        # 1420 MHz line stands out without needing a calibrated reference.
        power_db = 10.0 * np.log10(integrated)
        power_db -= float(np.median(power_db))
        # Effective integration time is the rolling EMA window's wall-clock
        # length, capped by how many frames have actually been accumulated
        # since the last reset. Past `integration_frames`, the window is
        # saturated and the value plateaus — which is what the UI should show
        # instead of a counter that climbs forever.
        cfg = self._cfg
        effective_frames = min(self._frames_seen, cfg.integration_frames)
        frame = SpectrumFrame(
            timestamp=time.time(),
            center_freq_mhz=cfg.center_freq_hz / 1e6,
            sample_rate_mhz=cfg.sample_rate_hz / 1e6,
            integration_frames=cfg.integration_frames,
            frames_seen=self._frames_seen,
            frame_duration_s=self._frame_period_s,
            integration_seconds=effective_frames * self._frame_period_s,
            mode=self._rx.mode,
            freqs_mhz=self._freqs_mhz.tolist(),
            power_db=power_db.astype(np.float32).round(3).tolist(),
        )
        self._latest = frame
        self.publish(frame)


__all__: Iterable[str] = ("SpectrumService", "SpectrumFrame")

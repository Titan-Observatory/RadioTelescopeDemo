"""Airspy SDR hardware wrapper.

Talks to an Airspy Mini (or R2) via SoapySDR's ``airspy`` module. If
SoapySDR or a real dongle is unavailable the receiver enters ``unavailable``
mode and produces no samples — downstream consumers see an empty stream and
publish nothing, rather than receiving synthetic data that would silently
masquerade as live.

Streaming is bridged from SoapySDR's blocking ``readStream`` onto asyncio
via ``asyncio.to_thread`` so the rest of the app can ``async for`` over it.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess
from typing import AsyncIterator

import numpy as np

from radiotelescope.config import SDRConfig
from radiotelescope.models.state import LnaStatus

logger = logging.getLogger(__name__)

try:
    import SoapySDR  # type: ignore
    from SoapySDR import SOAPY_SDR_RX, SOAPY_SDR_CF32  # type: ignore
    _SOAPY_AVAILABLE = True
    # Soapy negative return codes that mean "samples were dropped, keep going":
    #   TIMEOUT (-1), OVERFLOW (-4), UNDERFLOW (-7).
    # We deliberately do NOT retry on STREAM_ERROR (-2) or CORRUPTION (-3) —
    # those indicate the stream itself is broken and we need to re-open.
    _SOAPY_RETRYABLE = (
        SoapySDR.SOAPY_SDR_TIMEOUT,
        SoapySDR.SOAPY_SDR_OVERFLOW,
        SoapySDR.SOAPY_SDR_UNDERFLOW,
    )
except Exception as exc:  # pragma: no cover — exercised on non-Pi hosts
    SoapySDR = None  # type: ignore
    SOAPY_SDR_RX = 0  # type: ignore
    SOAPY_SDR_CF32 = "CF32"  # type: ignore
    _SOAPY_AVAILABLE = False
    _SOAPY_IMPORT_ERROR = str(exc)
    _SOAPY_RETRYABLE = (-1, -4, -7)


# Airspy Mini supports 3 Msps and 6 Msps only. Airspy R2 adds 2.5 / 10 Msps.
_AIRSPY_RATES = (2_500_000.0, 3_000_000.0, 6_000_000.0, 10_000_000.0)
_AIRSPY_BIAS_GPIO_CMD = ("airspy_gpio", "-p", "1", "-n", "13", "-w")


class SDRReceiver:
    """Async source of complex IQ sample chunks of length ``fft_size``."""

    def __init__(self, cfg: SDRConfig) -> None:
        self._cfg = cfg
        self._sdr: object | None = None
        self._stream: object | None = None
        self.mode: str = "uninitialised"
        self._lna_status = LnaStatus(state="unknown", label="Unknown", detail="Airspy not opened yet")

    @property
    def config(self) -> SDRConfig:
        return self._cfg

    @property
    def lna_status(self) -> LnaStatus:
        return self._lna_status

    async def set_lna_bias_tee(self, enabled: bool) -> LnaStatus:
        return await asyncio.to_thread(self._set_lna_bias_tee_live, enabled)

    async def open(self) -> None:
        if not self._cfg.enabled:
            self.mode = "disabled"
            self._lna_status = LnaStatus(state="off", label="Off", detail="SDR disabled")
            return
        if not _SOAPY_AVAILABLE:
            self.mode = "unavailable"
            self._lna_status = LnaStatus(state="fault", label="Issue", detail="SoapySDR unavailable")
            logger.error(
                "SoapySDR is not importable (%s); SDR will produce no data. "
                "Install soapysdr-module-airspy + python3-soapysdr to enable "
                "the spectrum pipeline.",
                _SOAPY_IMPORT_ERROR,
            )
            return
        try:
            # String form ("driver=airspy") rather than dict — the SWIG
            # dict→Kwargs conversion is broken in some 0.8.x builds and
            # silently raises `Device::make() no match`.
            sdr = SoapySDR.Device("driver=airspy")  # type: ignore[union-attr]
            sdr.setSampleRate(SOAPY_SDR_RX, 0, float(self._cfg.sample_rate_hz))
            sdr.setFrequency(SOAPY_SDR_RX, 0, float(self._cfg.center_freq_hz))
            self._set_lna_bias_tee(sdr)
            if self._cfg.gain_db is None:
                sdr.setGainMode(SOAPY_SDR_RX, 0, True)  # AGC
            else:
                sdr.setGainMode(SOAPY_SDR_RX, 0, False)
                # Airspy's "overall" gain is a 0-21 linearity index, not dB.
                # We pass the configured value straight through and clamp.
                g = max(0.0, min(21.0, float(self._cfg.gain_db)))
                sdr.setGain(SOAPY_SDR_RX, 0, g)
            stream = sdr.setupStream(SOAPY_SDR_RX, SOAPY_SDR_CF32)
            sdr.activateStream(stream)
            self._sdr = sdr
            self._stream = stream
            self.mode = "airspy"
            logger.info(
                "Airspy opened at %.3f MHz, %.1f Msps",
                self._cfg.center_freq_hz / 1e6,
                self._cfg.sample_rate_hz / 1e6,
            )
        except Exception as exc:
            self._sdr = None
            self._stream = None
            self.mode = "unavailable"
            self._lna_status = LnaStatus(state="fault", label="Issue", detail=f"Airspy open failed: {exc}")
            logger.error(
                "Airspy open failed (%s); SDR will produce no data. "
                "Check that the dongle is plugged in and not held by another process.",
                exc,
            )

    async def close(self) -> None:
        sdr, stream = self._sdr, self._stream
        self._sdr = None
        self._stream = None
        if sdr is None or stream is None:
            return
        try:
            self._set_lna_bias_tee_gpio(False)
        except Exception:
            try:
                sdr.writeSetting("biastee", "false")  # type: ignore[attr-defined]
            except Exception:
                pass
        try:
            sdr.deactivateStream(stream)  # type: ignore[attr-defined]
        except Exception:
            pass
        try:
            sdr.closeStream(stream)  # type: ignore[attr-defined]
        except Exception:
            pass
        self._lna_status = LnaStatus(state="off", label="Off", detail="Airspy closed")

    def _set_lna_bias_tee(self, sdr: object) -> None:
        enabled = bool(self._cfg.lna_bias_tee_enabled)
        try:
            self._set_lna_bias_tee_gpio(enabled)
            return
        except Exception as exc:
            logger.warning("airspy_gpio bias tee control failed, trying SoapySDR setting: %s", exc)

        try:
            sdr.writeSetting("biastee", "true" if enabled else "false")  # type: ignore[attr-defined]
        except Exception as exc:
            if enabled:
                self._lna_status = LnaStatus(state="fault", label="Issue", detail=f"Airspy bias tee failed: {exc}")
                logger.error("Could not enable Airspy bias tee for LNA: %s", exc)
            else:
                self._lna_status = LnaStatus(state="unknown", label="Unknown", detail=f"Airspy bias tee status unavailable: {exc}")
                logger.debug("Could not explicitly disable Airspy bias tee: %s", exc)
            return

        self._lna_status = (
            LnaStatus(state="on", label="On", detail="Airspy bias tee enabled")
            if enabled
            else LnaStatus(state="off", label="Off", detail="Airspy bias tee disabled")
        )

    def _set_lna_bias_tee_live(self, enabled: bool) -> LnaStatus:
        try:
            return self._set_lna_bias_tee_gpio(enabled)
        except Exception as gpio_exc:
            if self._sdr is None:
                raise
            try:
                self._sdr.writeSetting("biastee", "true" if enabled else "false")  # type: ignore[attr-defined]
            except Exception as soapy_exc:
                raise RuntimeError(f"{gpio_exc}; SoapySDR fallback failed: {soapy_exc}") from soapy_exc
            self._cfg.lna_bias_tee_enabled = enabled
            self._lna_status = (
                LnaStatus(state="on", label="On", detail="Airspy bias tee enabled")
                if enabled
                else LnaStatus(state="off", label="Off", detail="Airspy bias tee disabled")
            )
            return self._lna_status

    def _set_lna_bias_tee_gpio(self, enabled: bool) -> LnaStatus:
        value = "1" if enabled else "0"
        cmd = (*_AIRSPY_BIAS_GPIO_CMD, value)
        try:
            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
        except FileNotFoundError as exc:
            status = LnaStatus(state="fault", label="Issue", detail="airspy_gpio command not found")
            self._lna_status = status
            raise RuntimeError(status.detail) from exc
        except subprocess.TimeoutExpired as exc:
            status = LnaStatus(state="fault", label="Issue", detail="airspy_gpio timed out")
            self._lna_status = status
            raise RuntimeError(status.detail) from exc

        if result.returncode != 0:
            detail = (result.stderr or result.stdout or f"airspy_gpio exited with {result.returncode}").strip()
            status = LnaStatus(state="fault", label="Issue", detail=f"Airspy bias tee failed: {detail}")
            self._lna_status = status
            raise RuntimeError(status.detail)

        self._cfg.lna_bias_tee_enabled = enabled
        self._lna_status = (
            LnaStatus(state="on", label="On", detail="Airspy bias tee enabled")
            if enabled
            else LnaStatus(state="off", label="Off", detail="Airspy bias tee disabled")
        )
        return self._lna_status

    def _read_chunk(self, buf: np.ndarray) -> int:
        """Blocking single read into ``buf``. Returns samples read (>=0) or <0 on error."""
        sr = self._sdr.readStream(  # type: ignore[union-attr]
            self._stream, [buf], buf.size, timeoutUs=1_000_000
        )
        return int(sr.ret)

    async def stream(self) -> AsyncIterator[np.ndarray]:
        """Yield successive IQ chunks of length ``fft_size`` as complex64."""
        if self.mode != "airspy" or self._sdr is None or self._stream is None:
            return
        n = self._cfg.fft_size
        while True:
            buf = np.empty(n, dtype=np.complex64)
            got = 0
            while got < n:
                read = await asyncio.to_thread(self._read_chunk, buf[got:])
                if read >= 0:
                    got += read
                    continue
                if read in _SOAPY_RETRYABLE:
                    # Overflow / timeout — drop the partial frame and start
                    # over. The Airspy keeps streaming under the hood.
                    logger.debug("Airspy readStream transient (%d); skipping frame", read)
                    got = 0
                    continue
                logger.warning("Airspy readStream fatal error: %d; ending stream", read)
                return
            yield buf


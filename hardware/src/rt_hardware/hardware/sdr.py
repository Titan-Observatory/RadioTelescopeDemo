"""LNA bias-tee controller for an inline LNA powered through the Airspy.

After the spectrum DSP moved into a GNU Radio subprocess
([rt_hardware.sdr_pipeline]), this module's only remaining job is toggling
the +4.5 V bias on the Airspy's antenna SMA via the ``airspy_gpio`` tool.
The bias-tee path is kept separate from the DSP subprocess on purpose:
the operator should be able to flip the LNA on/off while the flowgraph
is running (or stopped) without bouncing either.
"""
from __future__ import annotations

import asyncio
import logging
import subprocess

from rt_hardware.config import SDRConfig
from rt_hardware.models.state import LnaStatus

logger = logging.getLogger(__name__)

# Airspy: pin 13 on port 1 is the bias-tee enable line.
_AIRSPY_BIAS_GPIO_CMD = ("airspy_gpio", "-p", "1", "-n", "13", "-w")


class LnaController:
    """Wraps the ``airspy_gpio`` subprocess so route handlers stay simple."""

    def __init__(self, cfg: SDRConfig) -> None:
        self._cfg = cfg
        self._status = LnaStatus(
            state="on" if cfg.lna_bias_tee_enabled else "off",
            label="On" if cfg.lna_bias_tee_enabled else "Off",
            detail="Initial state from config (not yet applied to hardware)",
        )

    @property
    def status(self) -> LnaStatus:
        return self._status

    async def set(self, enabled: bool) -> LnaStatus:
        return await asyncio.to_thread(self._set_blocking, enabled)

    def _set_blocking(self, enabled: bool) -> LnaStatus:
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
            self._status = LnaStatus(state="fault", label="Issue", detail="airspy_gpio command not found")
            raise RuntimeError(self._status.detail) from exc
        except subprocess.TimeoutExpired as exc:
            self._status = LnaStatus(state="fault", label="Issue", detail="airspy_gpio timed out")
            raise RuntimeError(self._status.detail) from exc

        if result.returncode != 0:
            detail = (result.stderr or result.stdout or f"airspy_gpio exited with {result.returncode}").strip()
            self._status = LnaStatus(state="fault", label="Issue", detail=f"Airspy bias tee failed: {detail}")
            raise RuntimeError(self._status.detail)

        self._cfg.lna_bias_tee_enabled = enabled
        self._status = (
            LnaStatus(state="on", label="On", detail="Airspy bias tee enabled")
            if enabled
            else LnaStatus(state="off", label="Off", detail="Airspy bias tee disabled")
        )
        return self._status


__all__ = ("LnaController",)

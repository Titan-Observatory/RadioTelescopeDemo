"""Host-side relay of spectrum frames from a gateway-server.

In ``gateway-client`` mode the Pi runs the full ``SpectrumService`` (FFT,
EMA, baseline persistence) and exposes ``/ws/spectrum``. This bridge opens a
single upstream WebSocket to that endpoint, decodes JSON frames, and fans
them out to local browser subscribers using the same drop-oldest pubsub the
in-process service uses. Browsers see an identical wire format, so the
front-end has no idea the spectrum was produced on another box.

The bridge intentionally does *not* mirror the full ``SpectrumService``
surface (baseline capture, reconnect, LNA toggle, status). Those endpoints
are proxied via HTTP straight to the gateway-server — see
``routes_spectrum_proxy``. Keeping bridge logic confined to the data path
avoids two sources of truth for things like the saved baseline.
"""
from __future__ import annotations

import asyncio
import json
import logging

from radiotelescope.config import HardwareConfig
from radiotelescope.services._pubsub import Broadcaster

logger = logging.getLogger(__name__)

# Cap upstream WS frames generously — a spectrum frame is ~8192 floats plus
# metadata, well under 1 MiB, but `max_size=None` removes a footgun if anyone
# bumps ``fft_size`` upstream without thinking about the receiver.
_WS_MAX_SIZE = None

# Reconnect cadence when the upstream WS is unreachable. Short enough that
# bouncing the Pi recovers quickly; long enough not to hammer it during an
# extended outage.
_RECONNECT_DELAY_S = 2.0


class SpectrumBridge(Broadcaster[dict]):
    """Subscribes to the gateway-server's ``/ws/spectrum`` and re-publishes."""

    name = "spectrum-bridge"

    def __init__(self, hardware_cfg: HardwareConfig) -> None:
        super().__init__()
        self._hw = hardware_cfg
        self._task: asyncio.Task[None] | None = None
        self._latest: dict | None = None
        self._connected: bool = False

    @property
    def latest(self) -> dict | None:
        return self._latest

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def upstream_url(self) -> str:
        return f"{self._hw.ws_base_url}/ws/spectrum"

    def subscribe(self, maxsize: int | None = None) -> asyncio.Queue[dict]:
        # Replay the most recent frame so a brand-new subscriber doesn't have
        # to wait up to one publish interval before seeing anything. Matches
        # SpectrumService.subscribe behaviour.
        q = super().subscribe(maxsize)
        if self._latest is not None:
            q.put_nowait(self._latest)
        return q

    async def start(self) -> None:
        if self._task is not None:
            return
        self._task = asyncio.create_task(self._safe_run(), name=self.name)
        logger.info("%s started against %s", self.name, self.upstream_url)

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logger.info("%s stopped", self.name)

    async def _safe_run(self) -> None:
        try:
            await self._run()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("%s loop crashed", self.name)

    async def _run(self) -> None:
        # Local import keeps `websockets` an optional dep at module load time,
        # matching the convention used by the old RemoteSDRReceiver.
        import websockets

        while True:
            try:
                async with websockets.connect(
                    self.upstream_url,
                    max_size=_WS_MAX_SIZE,
                    ping_interval=20,
                    ping_timeout=20,
                ) as ws:
                    self._connected = True
                    logger.info("Connected to gateway spectrum stream at %s", self.upstream_url)
                    async for message in ws:
                        if isinstance(message, bytes):
                            # Spectrum frames are JSON; ignore stray binary.
                            continue
                        try:
                            frame = json.loads(message)
                        except json.JSONDecodeError:
                            logger.warning("%s received non-JSON message; skipping", self.name)
                            continue
                        self._latest = frame
                        self.publish(frame)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "%s upstream dropped (%s); reconnecting in %.1fs",
                    self.name, exc, _RECONNECT_DELAY_S,
                )
            finally:
                self._connected = False
            await asyncio.sleep(_RECONNECT_DELAY_S)


__all__ = ("SpectrumBridge",)

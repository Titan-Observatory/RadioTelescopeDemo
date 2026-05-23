"""Shared lifecycle scaffolding for SDR-driven services.

``SpectrumService`` (computes FFTs from the attached SDR) uses this base for
its start/stop/reconnect/loop plumbing. Subclasses only own their data path
(``_run``).

The receiver passed in must implement the minimal ``open() / close() /
.mode`` surface from :class:`rt_hardware.hardware.sdr.SDRReceiver`.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Generic, Protocol, TypeVar

from rt_hardware.models.state import LnaStatus
from rt_hardware.services._pubsub import Broadcaster

logger = logging.getLogger(__name__)

T = TypeVar("T")


class _SDRLike(Protocol):
    mode: str

    async def open(self) -> None: ...
    async def close(self) -> None: ...
    async def set_lna_bias_tee(self, enabled: bool) -> LnaStatus: ...


class SDRDriverTask(Broadcaster[T], Generic[T]):
    """Owns an SDR receiver + a single consumer task with restart support.

    Subclasses implement :meth:`_run` to drive the receiver and call
    :meth:`publish` (inherited from :class:`Broadcaster`) for each output
    item. Lifecycle (``start``, ``stop``, ``reconnect``) and crash handling
    are provided here.

    The receiver is held open only while there is at least one subscriber.
    The first ``subscribe()`` opens the SDR and starts the consumer loop;
    when the last subscriber leaves, the SDR is closed after a short grace
    period (``idle_close_delay_s``) so a page reload doesn't churn the
    dongle. This keeps the Airspy (and the Pi it sits on) cool when nobody
    is watching the spectrum panel.
    """

    name: str = "sdr-task"
    idle_close_delay_s: float = 5.0

    def __init__(self, receiver: _SDRLike) -> None:
        super().__init__()
        self._rx = receiver
        self._task: asyncio.Task[None] | None = None
        self._running: bool = False
        self._lifecycle_lock = asyncio.Lock()
        self._idle_close_task: asyncio.Task[None] | None = None
        self._shutting_down: bool = False

    @property
    def mode(self) -> str:
        # When lazily closed, the receiver still reports its last-known mode
        # (e.g. "airspy"). Surface "idle" instead so the status endpoint
        # accurately reflects that the dongle isn't currently streaming.
        if not self._running:
            return "idle"
        return self._rx.mode

    @property
    def lna_status(self) -> LnaStatus:
        return getattr(
            self._rx,
            "lna_status",
            LnaStatus(state="unknown", label="Unknown", detail="Receiver does not expose LNA status"),
        )

    async def set_lna_bias_tee(self, enabled: bool) -> LnaStatus:
        setter = getattr(self._rx, "set_lna_bias_tee", None)
        if setter is None:
            raise RuntimeError("Receiver does not support LNA bias tee control")
        return await setter(enabled)

    async def start(self) -> None:
        # Lazy: don't power up the SDR until someone subscribes.
        logger.info("%s ready (lazy — SDR opens on first subscriber)", self.name)

    async def stop(self) -> None:
        self._shutting_down = True
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            await self._cancel_task()
            if self._running:
                await self._rx.close()
                self._running = False
        logger.info("%s stopped", self.name)

    async def reconnect(self) -> str:
        """Tear down and re-open the SDR without restarting the server.

        Lets the operator power-cycle the dongle or fix udev permissions
        and recover without bouncing uvicorn. If nobody is currently
        subscribed the SDR stays closed afterwards — the next viewer will
        open it lazily. Returns the receiver's mode so the caller can
        tell whether the retry worked.
        """
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            await self._cancel_task()
            if self._running:
                await self._rx.close()
                self._running = False
            if self.subscriber_count > 0 and not self._shutting_down:
                await self._open_locked()
        logger.info("%s reconnected (mode=%s)", self.name, self._rx.mode)
        return self._rx.mode

    # ── Subscriber-driven lifecycle ──────────────────────────────────────

    def subscribe(self, maxsize: int | None = None) -> asyncio.Queue[T]:
        q = super().subscribe(maxsize)
        if not self._shutting_down:
            asyncio.create_task(self._ensure_running(), name=f"{self.name}-open")
        return q

    def unsubscribe(self, q: asyncio.Queue[T]) -> None:
        super().unsubscribe(q)
        if self.subscriber_count == 0 and self._running and not self._shutting_down:
            if self._idle_close_task is None or self._idle_close_task.done():
                self._idle_close_task = asyncio.create_task(
                    self._close_after_idle(), name=f"{self.name}-idle-close",
                )

    async def _ensure_running(self) -> None:
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            if self._running or self._shutting_down or self.subscriber_count == 0:
                return
            await self._open_locked()

    async def _open_locked(self) -> None:
        await self._rx.open()
        self._running = True
        self._task = asyncio.create_task(self._safe_run(), name=self.name)
        logger.info("%s opened (mode=%s)", self.name, self._rx.mode)

    async def _close_after_idle(self) -> None:
        try:
            await asyncio.sleep(self.idle_close_delay_s)
        except asyncio.CancelledError:
            return
        async with self._lifecycle_lock:
            if self.subscriber_count > 0 or not self._running or self._shutting_down:
                return
            await self._cancel_task()
            await self._rx.close()
            self._running = False
            logger.info("%s closed (idle, no subscribers)", self.name)

    async def _cancel_idle_close(self) -> None:
        task = self._idle_close_task
        self._idle_close_task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _cancel_task(self) -> None:
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _safe_run(self) -> None:
        try:
            await self._run()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("%s loop crashed", self.name)
        # Natural exit (e.g. receiver opened in "unavailable" mode and the
        # stream returned immediately). Tear down so the next subscriber
        # gets a fresh open attempt instead of inheriting a dead task.
        if not self._shutting_down:
            asyncio.create_task(self._teardown_after_natural_exit(), name=f"{self.name}-teardown")

    async def _teardown_after_natural_exit(self) -> None:
        async with self._lifecycle_lock:
            if self._task is None or not self._task.done():
                return
            self._task = None
            if self._running:
                try:
                    await self._rx.close()
                finally:
                    self._running = False

    async def _run(self) -> None:
        raise NotImplementedError


__all__ = ("SDRDriverTask",)

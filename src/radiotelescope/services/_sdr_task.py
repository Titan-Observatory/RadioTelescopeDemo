"""Shared lifecycle scaffolding for SDR-driven services.

``SpectrumService`` (computes FFTs locally in the ``local`` / ``gateway-client``
deployment modes) and ``IQPublisher`` (forwards raw IQ over WebSocket in
``gateway-server`` mode) used to copy-paste their start/stop/reconnect/loop
plumbing verbatim. That scaffolding now lives here; subclasses only own
their data path (``_run``).

The receiver passed in must implement the minimal ``open() / close() /
.mode`` surface from :class:`radiotelescope.hardware.sdr.SDRReceiver` (the
remote variant also satisfies this), so the same base supports both the
all-in-one (aio) and client-server deployments without modification.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Generic, Protocol, TypeVar

from radiotelescope.models.state import LnaStatus
from radiotelescope.services._pubsub import Broadcaster

logger = logging.getLogger(__name__)

T = TypeVar("T")


class _SDRLike(Protocol):
    mode: str

    async def open(self) -> None: ...
    async def close(self) -> None: ...


class SDRDriverTask(Broadcaster[T], Generic[T]):
    """Owns an SDR receiver + a single consumer task with restart support.

    Subclasses implement :meth:`_run` to drive the receiver and call
    :meth:`publish` (inherited from :class:`Broadcaster`) for each output
    item. Lifecycle (``start``, ``stop``, ``reconnect``) and crash handling
    are provided here.
    """

    name: str = "sdr-task"

    def __init__(self, receiver: _SDRLike) -> None:
        super().__init__()
        self._rx = receiver
        self._task: asyncio.Task[None] | None = None

    @property
    def mode(self) -> str:
        return self._rx.mode

    @property
    def lna_status(self) -> LnaStatus:
        return getattr(
            self._rx,
            "lna_status",
            LnaStatus(state="unknown", label="Unknown", detail="Receiver does not expose LNA status"),
        )

    async def start(self) -> None:
        await self._rx.open()
        self._task = asyncio.create_task(self._safe_run(), name=self.name)
        logger.info("%s started (mode=%s)", self.name, self._rx.mode)

    async def stop(self) -> None:
        await self._cancel_task()
        await self._rx.close()
        logger.info("%s stopped", self.name)

    async def reconnect(self) -> str:
        """Tear down and re-open the SDR without restarting the server.

        Lets the operator power-cycle the dongle or fix udev permissions
        and recover without bouncing uvicorn. Returns the receiver's new
        mode so the caller can tell whether the retry worked.
        """
        await self._cancel_task()
        await self._rx.close()
        await self._rx.open()
        self._task = asyncio.create_task(self._safe_run(), name=self.name)
        logger.info("%s reconnected (mode=%s)", self.name, self._rx.mode)
        return self._rx.mode

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

    async def _run(self) -> None:
        raise NotImplementedError


__all__ = ("SDRDriverTask",)

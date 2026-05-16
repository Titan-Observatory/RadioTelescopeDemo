"""Drop-oldest pub/sub helpers shared across services.

Every long-lived service in this app fans out the same kind of data to a
small set of WebSocket subscribers: spectrum frames, RoboClaw telemetry,
queue status, raw IQ chunks. The fan-out behaviour is identical — keep
each subscriber's queue bounded, drop the *oldest* entry when the queue
is full so slow consumers can't stall fast producers — so it lives here
once instead of being copy-pasted into every service.
"""
from __future__ import annotations

import asyncio
from typing import Generic, TypeVar

T = TypeVar("T")


def put_latest(q: asyncio.Queue[T], item: T) -> None:
    """Enqueue ``item``, evicting the oldest entry when the queue is full."""
    try:
        q.put_nowait(item)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
        try:
            q.put_nowait(item)
        except asyncio.QueueFull:
            # Another task drained-and-refilled between our get/put — drop.
            pass


class Broadcaster(Generic[T]):
    """Bounded drop-oldest pub/sub over ``asyncio.Queue``.

    Subscribers receive new items via ``subscribe()`` and detach with
    ``unsubscribe()``. ``publish()`` fans the item out to every current
    subscriber using :func:`put_latest`.
    """

    default_maxsize: int = 4

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[T]] = []

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)

    def subscribe(self, maxsize: int | None = None) -> asyncio.Queue[T]:
        q: asyncio.Queue[T] = asyncio.Queue(
            maxsize=self.default_maxsize if maxsize is None else maxsize,
        )
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[T]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    def publish(self, item: T) -> None:
        for q in list(self._subscribers):
            put_latest(q, item)


__all__ = ("Broadcaster", "put_latest")

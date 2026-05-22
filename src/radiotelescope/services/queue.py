"""Single-controller queue with first-come-first-serve lease handover.

The active session holds the *control lease*; everyone else is in line.
The lease is released when (a) the hard cap elapses, (b) the active session
goes idle (no commands for `idle_timeout_seconds`), or (c) the session
explicitly leaves / disconnects from the queue WebSocket.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
from collections import deque
from dataclasses import dataclass, field

from pydantic import BaseModel

from radiotelescope.services._pubsub import Broadcaster

logger = logging.getLogger(__name__)


@dataclass
class _Session:
    token: str
    ip: str
    joined_at: float
    last_seen_at: float
    ws_connected: bool = False


class QueueStatus(BaseModel):
    token: str
    is_active: bool
    position: int  # 0 == active controller, 1 == next, ... ; -1 == not in queue
    queue_length: int
    lease_remaining_s: float | None
    idle_remaining_s: float | None
    has_active_user: bool


class QueueService:
    def __init__(
        self,
        max_session_seconds: int,
        idle_timeout_seconds: int,
        max_queue_size: int,
        max_sessions_per_ip: int = 3,
        join_cooldown_seconds: int = 5,
    ) -> None:
        self.max_session_seconds = max_session_seconds
        self.idle_timeout_seconds = idle_timeout_seconds
        self.max_queue_size = max_queue_size
        self.max_sessions_per_ip = max_sessions_per_ip
        self.join_cooldown_seconds = join_cooldown_seconds

        self._sessions: dict[str, _Session] = {}
        self._queue: deque[str] = deque()
        self._last_join_by_ip: dict[str, float] = {}
        self._active: str | None = None
        self._active_lease_started_at: float | None = None
        self._active_last_command_at: float | None = None

        self._lock = asyncio.Lock()
        self._broadcaster: Broadcaster[QueueStatus] = Broadcaster()
        self._broadcaster.default_maxsize = 8
        self._task: asyncio.Task[None] | None = None
        self._stopped = False

    # ─── lifecycle ───────────────────────────────────────────────────────────

    async def start(self) -> None:
        if self._task is None:
            self._stopped = False
            self._task = asyncio.create_task(self._tick_loop(), name="queue-tick")

    async def stop(self) -> None:
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    # ─── public API ──────────────────────────────────────────────────────────

    async def join(self, ip: str) -> str:
        """Create a session and append it to the queue. Returns the session token."""
        async with self._lock:
            now = time.monotonic()
            last_join = self._last_join_by_ip.get(ip)
            if (
                last_join is not None
                and self.join_cooldown_seconds > 0
                and (now - last_join) < self.join_cooldown_seconds
            ):
                raise QueueRateLimitedError("Please wait before joining again.")
            current_from_ip = sum(1 for session in self._sessions.values() if session.ip == ip)
            if current_from_ip >= self.max_sessions_per_ip:
                raise QueueRateLimitedError("Too many active queue sessions from this address.")
            if len(self._queue) + (1 if self._active else 0) >= self.max_queue_size:
                raise QueueFullError("Queue is full, please try again later.")
            token = secrets.token_urlsafe(24)
            self._sessions[token] = _Session(
                token=token, ip=ip, joined_at=now, last_seen_at=now,
            )
            self._queue.append(token)
            self._last_join_by_ip[ip] = now
            self._promote_if_idle()
        await self._broadcast()
        return token

    async def rejoin(self, token: str, ip: str) -> bool:
        """Re-attach an existing session if still tracked. Returns True if known."""
        async with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return False
            session.ip = ip
            session.last_seen_at = time.monotonic()
            return True

    async def leave(self, token: str) -> None:
        async with self._lock:
            self._drop_locked(token)
            self._promote_if_idle()
        await self._broadcast()

    async def mark_command(self, token: str) -> None:
        """Called whenever the active session issues a control command."""
        async with self._lock:
            if self._active == token:
                self._active_last_command_at = time.monotonic()

    async def mark_ws_connected(self, token: str, connected: bool) -> None:
        async with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return
            session.ws_connected = connected
            session.last_seen_at = time.monotonic()

    def is_active(self, token: str | None) -> bool:
        return token is not None and self._active == token

    def status_for(self, token: str | None) -> QueueStatus:
        now = time.monotonic()
        # position 0 == active controller, 1 == next up, etc. -1 == not in queue.
        position = -1
        if token is not None:
            if self._active == token:
                position = 0
            elif token in self._queue:
                position = list(self._queue).index(token) + 1

        lease_remaining: float | None = None
        idle_remaining: float | None = None
        if self._active == token and self._active_lease_started_at is not None:
            lease_remaining = max(
                0.0,
                self.max_session_seconds - (now - self._active_lease_started_at),
            )
            if self._active_last_command_at is not None:
                idle_remaining = max(
                    0.0,
                    self.idle_timeout_seconds - (now - self._active_last_command_at),
                )

        return QueueStatus(
            token=token or "",
            is_active=self._active == token and token is not None,
            position=position,
            queue_length=len(self._queue),
            lease_remaining_s=lease_remaining,
            idle_remaining_s=idle_remaining,
            has_active_user=self._active is not None,
        )

    # ─── pub/sub for /ws/queue ───────────────────────────────────────────────

    def subscribe(self) -> asyncio.Queue[QueueStatus]:
        return self._broadcaster.subscribe()

    def unsubscribe(self, q: asyncio.Queue[QueueStatus]) -> None:
        self._broadcaster.unsubscribe(q)

    async def _broadcast(self) -> None:
        # Each listener gets a status snapshot relevant to its own token via
        # the route handler; here we just nudge listeners to re-poll. We push
        # a sentinel `QueueStatus` with empty token; the handler will recompute
        # using its own token.
        sentinel = QueueStatus(
            token="",
            is_active=False,
            position=-1,
            queue_length=len(self._queue),
            lease_remaining_s=None,
            idle_remaining_s=None,
            has_active_user=self._active is not None,
        )
        self._broadcaster.publish(sentinel)

    # ─── background expiry loop ──────────────────────────────────────────────

    async def _tick_loop(self) -> None:
        try:
            while not self._stopped:
                await asyncio.sleep(1.0)
                changed = await self._tick()
                if changed:
                    await self._broadcast()
        except asyncio.CancelledError:
            raise

    async def _tick(self) -> bool:
        now = time.monotonic()
        changed = False
        async with self._lock:
            if self._active is not None and self._active_lease_started_at is not None:
                expired = (now - self._active_lease_started_at) > self.max_session_seconds
                idle = (
                    self._active_last_command_at is not None
                    and (now - self._active_last_command_at) > self.idle_timeout_seconds
                )
                if expired or idle:
                    logger.info(
                        "Releasing lease for %s (expired=%s idle=%s)",
                        self._active[:8], expired, idle,
                    )
                    self._drop_locked(self._active)
                    changed = True

            # Drop the active controller if their WS has been gone past the
            # reconnect grace window (covers tab-close / hard-refresh).
            if self._active is not None:
                session = self._sessions.get(self._active)
                if (
                    session is not None
                    and not session.ws_connected
                    and (now - session.last_seen_at) > 10.0
                ):
                    logger.info(
                        "Releasing lease for %s (ws disconnected)", self._active[:8],
                    )
                    self._drop_locked(self._active)
                    changed = True

            # Prune queue entries whose WS has been gone for more than 5 s after joining.
            stale: list[str] = []
            for token in list(self._queue):
                session = self._sessions.get(token)
                if session is None:
                    stale.append(token)
                    continue
                if not session.ws_connected and (now - session.joined_at) > 10.0:
                    stale.append(token)
            for token in stale:
                logger.info("Pruning stale queued session %s", token[:8])
                self._drop_locked(token)
                changed = True

            if self._promote_if_idle():
                changed = True
        return changed

    # ─── internals (must be called with lock held) ──────────────────────────

    def _drop_locked(self, token: str) -> None:
        if self._active == token:
            self._active = None
            self._active_lease_started_at = None
            self._active_last_command_at = None
        try:
            self._queue.remove(token)
        except ValueError:
            pass
        self._sessions.pop(token, None)

    def _promote_if_idle(self) -> bool:
        if self._active is not None:
            return False
        while self._queue:
            candidate = self._queue.popleft()
            if candidate in self._sessions:
                now = time.monotonic()
                self._active = candidate
                self._active_lease_started_at = now
                self._active_last_command_at = now
                logger.info("Promoting %s to active controller", candidate[:8])
                return True
        return False


class QueueFullError(Exception):
    pass


class QueueRateLimitedError(Exception):
    pass

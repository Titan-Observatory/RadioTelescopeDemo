from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from radiotelescope.config import RateLimitConfig


class RateLimitMiddleware:
    """Small in-process limiter for public write/stream surfaces.

    Reverse proxies should still enforce the outer limits. This catches
    accidental direct access to the app and keeps abuse controls near the API
    behavior they protect.
    """

    def __init__(self, app: ASGIApp, *, config: RateLimitConfig) -> None:
        self.app = app
        self.config = config
        self._hits: dict[tuple[str, str], deque[float]] = defaultdict(deque)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.config.enabled or scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        limit_key = self._limit_key(scope)
        if limit_key is None:
            await self.app(scope, receive, send)
            return

        client = scope.get("client")
        ip = client[0] if client else "unknown"
        allowed, retry_after = self._allow(ip, limit_key[0], limit_key[1])
        if not allowed:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008, "reason": "Rate limited"})
                return
            await self._send_too_many_requests(send, retry_after)
            return

        await self.app(scope, receive, send)

    def _limit_key(self, scope: Scope) -> tuple[str, int] | None:
        path = scope.get("path", "")
        method = scope.get("method", "GET")
        if scope["type"] == "websocket":
            if path.startswith("/ws/"):
                return ("ws", self.config.websocket_connect_per_minute)
            return None
        if method == "POST" and path == "/api/queue/join":
            return ("queue_join", self.config.queue_join_per_minute)
        if method == "POST" and path == "/api/feedback":
            return ("feedback", self.config.feedback_per_minute)
        if method == "POST" and path == "/api/events":
            return ("events", self.config.events_per_minute)
        if method == "GET" and path == "/api/camera/stream":
            return ("camera_stream", self.config.camera_stream_per_minute)
        if method == "POST" and path in {
            "/api/telescope/goto",
            "/api/telescope/goto_radec",
            "/api/telescope/jog",
        }:
            return ("motion", self.config.motion_per_minute)
        return None

    def _allow(self, ip: str, bucket: str, limit: int) -> tuple[bool, float]:
        """Returns (allowed, retry_after_seconds). retry_after is 0 when allowed."""
        now = time.monotonic()
        window_start = now - 60.0
        hits = self._hits[(ip, bucket)]
        while hits and hits[0] <= window_start:
            hits.popleft()
        if len(hits) >= limit:
            # One slot frees up when the oldest hit ages out of the 60 s window.
            retry_after = max(0.0, hits[0] + 60.0 - now)
            return False, retry_after
        hits.append(now)
        return True, 0.0

    async def _send_too_many_requests(self, send: Send, retry_after_seconds: float) -> None:
        body = b'{"detail":"Rate limit exceeded"}'
        # Round up to a whole second; Retry-After must be an integer per RFC 7231.
        retry_after = max(1, int(retry_after_seconds + 0.999))
        send_message: Callable[[Message], Awaitable[None]] = send
        await send_message(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"retry-after", str(retry_after).encode("ascii")),
                ],
            }
        )
        await send_message({"type": "http.response.body", "body": body})

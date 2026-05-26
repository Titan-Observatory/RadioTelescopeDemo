"""HTTP client for the rt-hardware service.

A single long-lived ``httpx.AsyncClient`` is shared by every proxy route so
each forwarded request reuses an existing TCP (and TLS) connection. Opening
a fresh connection per jog tick added a full round-trip of handshake latency
to every command, which over the LAN/internet between the platform host and
the Pi was enough to blow past the hardware-side jog watchdog.

Responses are forwarded verbatim to the browser, which already knows the
schema from ``types.gen.ts``, so this wrapper deliberately stays untyped.
"""
from __future__ import annotations

import httpx


class HardwareClient:
    """Pooled async HTTP client bound to the hardware service base URL."""

    def __init__(self, base_url: str, *, timeout_s: float = 5.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout_s
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        # Keepalive pool sized so the four proxy categories (motor status,
        # jog ticks, spectrum HTTP, camera) can each hold a warm connection
        # without thrashing. Idle connections expire after 60 s so a Pi
        # restart on the other side is recovered transparently.
        limits = httpx.Limits(
            max_keepalive_connections=8,
            max_connections=32,
            keepalive_expiry=60.0,
        )
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=self._timeout,
            limits=limits,
            http2=False,
        )

    async def stop(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("HardwareClient is not started")
        return self._client

    async def request(
        self,
        method: str,
        path: str,
        *,
        json: dict | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        kwargs: dict = {"json": json}
        if timeout is not None:
            kwargs["timeout"] = timeout
        return await self.client.request(method, path, **kwargs)

    @property
    def ws_base_url(self) -> str:
        if self.base_url.startswith("http://"):
            return "ws://" + self.base_url[len("http://"):]
        if self.base_url.startswith("https://"):
            return "wss://" + self.base_url[len("https://"):]
        return self.base_url

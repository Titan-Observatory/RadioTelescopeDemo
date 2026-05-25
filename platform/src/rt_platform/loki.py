"""Fire-and-forget Loki push client.

Call loki.push(job, entry) from any async context after calling configure().
A missing or unreachable Loki URL is always a no-op — never raises, never
blocks the caller.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

import httpx

logger = logging.getLogger(__name__)

_client: httpx.AsyncClient | None = None
_url: str = ""


def configure(loki_url: str) -> None:
    """Call once at app startup. Empty/unset URL disables all pushes."""
    global _client, _url
    if loki_url:
        _url = loki_url.rstrip("/") + "/loki/api/v1/push"
        _client = httpx.AsyncClient(timeout=5)
        logger.info("Loki push enabled → %s", _url)


def push(job: str, entry: dict) -> None:
    """Schedule a non-blocking Loki push. Safe to call from any async context."""
    if not _client:
        return
    try:
        asyncio.get_running_loop().create_task(_push(job, entry))
    except RuntimeError:
        pass  # No running event loop — skip silently (e.g. during tests)


async def _push(job: str, entry: dict) -> None:
    ts_ns = str(int(time.time() * 1e9))
    payload = {
        "streams": [
            {"stream": {"job": job}, "values": [[ts_ns, json.dumps(entry, default=str)]]}
        ]
    }
    try:
        await _client.post(_url, json=payload)  # type: ignore[union-attr]
    except Exception as exc:
        logger.warning("Loki push failed (%s): %s", job, exc)

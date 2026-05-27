"""Operator-controlled telescope status flag with broadcast + disk persistence.

Holds one record describing whether the telescope is operational, down for
maintenance, or fully closed to visitors. The queue gates new joins on this
state, and the queue page header surfaces the message to visitors.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from rt_platform.services._pubsub import Broadcaster

logger = logging.getLogger(__name__)

TelescopeState = Literal["operational", "maintenance", "closed"]
_VALID_STATES: tuple[TelescopeState, ...] = ("operational", "maintenance", "closed")


class TelescopeStatus(BaseModel):
    state: TelescopeState = "operational"
    message: str | None = None
    updated_at: str | None = None
    updated_by_ip_hash: str | None = None


class TelescopeStatusService:
    def __init__(self, storage_path: Path) -> None:
        self._path = Path(storage_path)
        self._status = TelescopeStatus()
        self._lock = asyncio.Lock()
        self._broadcaster: Broadcaster[TelescopeStatus] = Broadcaster()
        self._broadcaster.default_maxsize = 8

    @property
    def status(self) -> TelescopeStatus:
        return self._status

    @property
    def is_operational(self) -> bool:
        return self._status.state == "operational"

    async def start(self) -> None:
        await asyncio.to_thread(self._load_from_disk)
        logger.info("Telescope status: %s (loaded from %s)", self._status.state, self._path)

    async def stop(self) -> None:
        pass

    async def set(
        self,
        state: TelescopeState,
        message: str | None,
        updated_by_ip_hash: str | None = None,
    ) -> TelescopeStatus:
        if state not in _VALID_STATES:
            raise ValueError(f"Invalid state: {state!r}")
        async with self._lock:
            self._status = TelescopeStatus(
                state=state,
                message=message.strip() if message else None,
                updated_at=datetime.now(timezone.utc)
                    .isoformat(timespec="seconds")
                    .replace("+00:00", "Z"),
                updated_by_ip_hash=updated_by_ip_hash,
            )
            await asyncio.to_thread(self._save_to_disk, self._status)
        self._broadcaster.publish(self._status)
        return self._status

    def subscribe(self) -> asyncio.Queue[TelescopeStatus]:
        return self._broadcaster.subscribe()

    def unsubscribe(self, q: asyncio.Queue[TelescopeStatus]) -> None:
        self._broadcaster.unsubscribe(q)

    def _load_from_disk(self) -> None:
        if not self._path.exists():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            self._status = TelescopeStatus.model_validate(raw)
        except Exception:
            logger.exception("Failed to load telescope status from %s; using default", self._path)

    def _save_to_disk(self, status: TelescopeStatus) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(status.model_dump_json(), encoding="utf-8")
        os.replace(tmp, self._path)

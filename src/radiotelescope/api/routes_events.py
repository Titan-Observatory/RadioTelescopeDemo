from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field, field_validator

from radiotelescope.api.log_files import append_jsonl_with_rotation

logger = logging.getLogger(__name__)
router = APIRouter(tags=["events"])

_write_lock = asyncio.Lock()

# snake_case names only — keeps the column space tidy for downstream tooling.
_EVENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class EventRequest(BaseModel):
    event: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=8, max_length=64)
    ts_client: str | None = Field(default=None, max_length=40)
    is_active_controller: bool | None = None
    queue_position: int | None = None
    viewport_w: int | None = Field(default=None, ge=0, le=20000)
    viewport_h: int | None = Field(default=None, ge=0, le=20000)
    device_class: str | None = Field(default=None, max_length=16)
    page_path: str | None = Field(default=None, max_length=256)
    props: dict[str, Any] = Field(default_factory=dict)

    @field_validator("event")
    @classmethod
    def _event_name_shape(cls, value: str) -> str:
        if not _EVENT_NAME_RE.match(value):
            raise ValueError("event must be snake_case ([a-z][a-z0-9_]*)")
        return value

    @field_validator("props")
    @classmethod
    def _props_size(cls, value: dict[str, Any]) -> dict[str, Any]:
        # Hard cap so a misbehaving client can't fill the disk with one event.
        if len(json.dumps(value, default=str)) > 4096:
            raise ValueError("props payload too large (>4KB)")
        return value


def _hash_ip(ip: str | None) -> str | None:
    if not ip:
        return None
    return hashlib.sha256(ip.encode("utf-8")).hexdigest()[:12]


@router.post("/api/events")
async def submit_event(body: EventRequest, request: Request) -> Response:
    log_path = Path(request.app.state.config.events_log_path)
    client_host = request.client.host if request.client else None
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "ts_client": body.ts_client,
        "session_id": body.session_id,
        "event": body.event,
        "is_active_controller": body.is_active_controller,
        "queue_position": body.queue_position,
        "viewport_w": body.viewport_w,
        "viewport_h": body.viewport_h,
        "device_class": body.device_class,
        "page_path": body.page_path,
        "client_ip_hash": _hash_ip(client_host),
        "props": body.props,
    }
    async with _write_lock:
        append_jsonl_with_rotation(log_path, entry, request.app.state.config.events_log_max_bytes)
    # 204 keeps sendBeacon happy and avoids parsing a response body on the client.
    return Response(status_code=204)

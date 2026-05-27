"""LAN-admin-only routes for the operator control panel.

Everything here is gated by ``require_lan_admin``: from a non-allowlisted
client these endpoints return 404, which makes the whole admin surface
invisible to public visitors. Mutations are appended to ``motion.jsonl``
alongside motor activity so there is a single audit trail.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from rt_platform.api.dependencies import (
    client_ip,
    queue_service,
    require_lan_admin,
)
from rt_platform.api.log_files import (
    append_jsonl_with_rotation,
    hash_ip,
    utc_now_iso,
)
from rt_platform.services.queue import QueueSnapshot
from rt_platform.services.status import TelescopeStatus

logger = logging.getLogger("rt_platform.admin")
router = APIRouter(tags=["admin"], dependencies=[Depends(require_lan_admin)])


class StatusUpdateRequest(BaseModel):
    state: Literal["operational", "maintenance", "closed"]
    message: str | None = Field(default=None, max_length=500)


class KickRequest(BaseModel):
    token: str = Field(min_length=8, max_length=128)


def _audit(request: Request, endpoint: str, params: dict | None = None) -> None:
    cfg = request.app.state.config
    entry = {
        "ts": utc_now_iso(),
        "endpoint": endpoint,
        "accepted": True,
        "reason": None,
        "session_id": None,
        "session_hash": None,
        "ip_hash": hash_ip(client_ip(request)),
        "params": params or {},
    }
    try:
        append_jsonl_with_rotation(
            Path(cfg.motion_log_path), entry, cfg.motion_log_max_bytes,
        )
    except Exception:
        logger.exception("Failed to append admin audit entry")


@router.get("/api/admin/status", response_model=TelescopeStatus)
async def get_status(request: Request) -> TelescopeStatus:
    return request.app.state.status_service.status


@router.post("/api/admin/status", response_model=TelescopeStatus)
async def set_status(body: StatusUpdateRequest, request: Request) -> TelescopeStatus:
    service = request.app.state.status_service
    updated = await service.set(
        state=body.state,
        message=body.message,
        updated_by_ip_hash=hash_ip(client_ip(request)),
    )
    _audit(request, "admin_status_change", {"state": body.state, "message": body.message})
    return updated


@router.get("/api/admin/queue", response_model=QueueSnapshot)
async def get_queue(request: Request) -> QueueSnapshot:
    return queue_service(request).snapshot(ip_hasher=hash_ip)


@router.post("/api/admin/queue/kick")
async def kick_session(body: KickRequest, request: Request) -> dict[str, bool]:
    known = await queue_service(request).kick(body.token)
    if not known:
        raise HTTPException(404, "Unknown session token")
    _audit(request, "admin_kick", {"token_prefix": body.token[:8]})
    return {"kicked": True}

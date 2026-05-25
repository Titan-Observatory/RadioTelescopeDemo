"""Motor proxy.

Forwards all motor / telescope HTTP endpoints to the rt-hardware service and
bridges ``/ws/roboclaw``. Enforces the queue (``require_control``) on
mutations before forwarding, and appends every motion attempt to the JSONL
motion audit log on this side — the hardware service is unauthenticated and
does no logging.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse

from rt_platform.api.dependencies import (
    queue_service,
    read_session_token,
    require_active_queue_session,
    require_control,
    require_lan_admin,
)
from rt_platform.api.log_files import append_jsonl_with_rotation
from rt_platform import loki

logger = logging.getLogger("rt_platform.motor_proxy")
router = APIRouter(tags=["motor-proxy"])

_motion_audit_lock = asyncio.Lock()


def _base_url(request: Request) -> str:
    return request.app.state.config.hardware_url


def _ws_base_url(app) -> str:
    base = app.state.config.hardware_url
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):]
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):]
    return base


def _session_fingerprint(request: Request) -> str | None:
    cookie_name = request.app.state.config.queue.cookie_name
    raw = request.cookies.get(cookie_name)
    if not raw:
        return None
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _ip_fingerprint(request: Request) -> str | None:
    client = request.client
    if client is None:
        return None
    return hashlib.sha256(client.host.encode("utf-8")).hexdigest()[:12]


async def _audit_motion(
    request: Request,
    endpoint: str,
    *,
    accepted: bool,
    params: dict[str, Any] | None = None,
    reason: str | None = None,
) -> None:
    try:
        cfg = request.app.state.config
        log_path = Path(cfg.motion_log_path)
        max_bytes = cfg.motion_log_max_bytes
    except AttributeError:
        return
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "endpoint": endpoint,
        "accepted": accepted,
        "reason": reason,
        "session_hash": _session_fingerprint(request),
        "ip_hash": _ip_fingerprint(request),
        "params": params or {},
    }
    try:
        async with _motion_audit_lock:
            await asyncio.to_thread(append_jsonl_with_rotation, log_path, entry, max_bytes)
        loki.push("rt_motion", entry)
    except Exception:
        pass


async def _forward(
    method: str,
    request: Request,
    path: str,
    json_body: dict | None = None,
    timeout_s: float = 10.0,
) -> JSONResponse:
    url = _base_url(request) + path
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            r = await client.request(method, url, json=json_body)
    except Exception as exc:
        raise HTTPException(502, f"Hardware gateway unreachable: {exc}") from exc
    try:
        body = r.json()
    except Exception:
        body = {"detail": r.text}
    return JSONResponse(body, status_code=r.status_code)


# ─── Read-only endpoints (no queue gate) ──────────────────────────────────


@router.get("/api/health", dependencies=[Depends(require_active_queue_session)])
async def health(request: Request) -> JSONResponse:
    return await _forward("GET", request, "/api/health", timeout_s=3.0)


@router.get("/api/roboclaw/status", dependencies=[Depends(require_active_queue_session)])
async def status(request: Request) -> JSONResponse:
    return await _forward("GET", request, "/api/roboclaw/status", timeout_s=3.0)


@router.get("/api/roboclaw/commands", dependencies=[Depends(require_active_queue_session)])
async def commands(request: Request) -> JSONResponse:
    return await _forward("GET", request, "/api/roboclaw/commands", timeout_s=3.0)


@router.get("/api/telescope/goto", dependencies=[Depends(require_active_queue_session)])
async def goto_info(request: Request) -> JSONResponse:
    return await _forward("GET", request, "/api/telescope/goto", timeout_s=3.0)


@router.get("/api/telescope/config", dependencies=[Depends(require_active_queue_session)])
async def telescope_config(request: Request) -> JSONResponse:
    return await _forward("GET", request, "/api/telescope/config", timeout_s=3.0)


# ─── Control-gated endpoints ──────────────────────────────────────────────


@router.post("/api/roboclaw/commands/{command_id}", dependencies=[Depends(require_control)])
async def execute_command(command_id: str, request: Request) -> JSONResponse:
    body = await _safe_json(request)
    return await _forward("POST", request, f"/api/roboclaw/commands/{command_id}", json_body=body)


@router.post("/api/roboclaw/stop", dependencies=[Depends(require_control)])
async def stop(request: Request) -> JSONResponse:
    return await _forward("POST", request, "/api/roboclaw/stop")


@router.post("/api/telescope/jog", dependencies=[Depends(require_control)])
async def jog(request: Request) -> JSONResponse:
    body = await _safe_json(request)
    audit_params = {k: body.get(k) for k in ("direction", "speed", "seq") if k in body}
    resp = await _forward("POST", request, "/api/telescope/jog", json_body=body)
    payload = _payload(resp)
    accepted = bool(payload.get("accepted")) if isinstance(payload, dict) else False
    await _audit_motion(
        request, "jog",
        accepted=accepted and resp.status_code < 400,
        params=audit_params,
        reason=_reason_from(payload, resp.status_code, accepted and resp.status_code < 400),
    )
    return resp


@router.post("/api/telescope/jog/stop", dependencies=[Depends(require_control)])
async def stop_jog(request: Request) -> JSONResponse:
    body = await _safe_json(request)
    return await _forward("POST", request, "/api/telescope/jog/stop", json_body=body)


@router.post("/api/telescope/goto", dependencies=[Depends(require_control)])
async def goto_alt_az(request: Request) -> JSONResponse:
    body = await _safe_json(request)
    audit_params = {k: body.get(k) for k in ("altitude_deg", "azimuth_deg") if k in body}
    resp = await _forward("POST", request, "/api/telescope/goto", json_body=body)
    accepted = resp.status_code < 400
    await _audit_motion(
        request, "goto",
        accepted=accepted,
        params=audit_params,
        reason=_reason_from(_payload(resp), resp.status_code, accepted),
    )
    return resp


@router.post("/api/telescope/goto_radec", dependencies=[Depends(require_control)])
async def goto_radec(request: Request) -> JSONResponse:
    body = await _safe_json(request)
    audit_params = {k: body.get(k) for k in ("ra_deg", "dec_deg") if k in body}
    resp = await _forward("POST", request, "/api/telescope/goto_radec", json_body=body)
    accepted = resp.status_code < 400
    await _audit_motion(
        request, "goto_radec",
        accepted=accepted,
        params=audit_params,
        reason=_reason_from(_payload(resp), resp.status_code, accepted),
    )
    return resp


@router.post("/api/telescope/sync", dependencies=[Depends(require_lan_admin)])
async def sync_alt_az(request: Request) -> JSONResponse:
    body = await _safe_json(request)
    return await _forward("POST", request, "/api/telescope/sync", json_body=body)


@router.post("/api/telescope/home/elevation", dependencies=[Depends(require_lan_admin)])
async def home_elevation(request: Request) -> JSONResponse:
    body = await _safe_json(request)
    return await _forward("POST", request, "/api/telescope/home/elevation", json_body=body, timeout_s=120.0)


@router.post("/api/telescope/home/azimuth", dependencies=[Depends(require_lan_admin)])
async def home_azimuth(request: Request) -> JSONResponse:
    return await _forward("POST", request, "/api/telescope/home/azimuth")


@router.post("/api/telescope/home/altitude", dependencies=[Depends(require_lan_admin)])
async def home_altitude(request: Request) -> JSONResponse:
    return await _forward("POST", request, "/api/telescope/home/altitude")


# ─── WebSocket bridge ─────────────────────────────────────────────────────


@router.websocket("/ws/roboclaw")
async def roboclaw_ws(ws: WebSocket) -> None:
    """Open one upstream WS to the hardware, relay frames to the browser."""
    await ws.accept()
    if ws.app.state.config.queue.enabled:
        token = read_session_token(ws)
        if not queue_service(ws).is_active(token):
            await ws.close(code=1008, reason="Active queue session required")
            return
    upstream_url = _ws_base_url(ws.app) + "/ws/roboclaw"
    import websockets

    try:
        async with websockets.connect(
            upstream_url,
            ping_interval=20,
            ping_timeout=20,
            max_size=None,
        ) as upstream:
            async for message in upstream:
                if isinstance(message, bytes):
                    await ws.send_bytes(message)
                else:
                    await ws.send_text(message)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:
        logger.warning("roboclaw WS bridge failed: %s", exc)
        try:
            await ws.close(code=1011)
        except Exception:
            pass


# ─── helpers ──────────────────────────────────────────────────────────────


async def _safe_json(request: Request) -> dict:
    try:
        return await request.json()
    except Exception:
        return {}


def _payload(resp: JSONResponse) -> Any:
    try:
        return json.loads(resp.body)
    except Exception:
        return None


def _reason_from(payload: Any, status: int, accepted: bool) -> str | None:
    if accepted:
        return None
    if isinstance(payload, dict):
        detail = payload.get("detail")
        if isinstance(detail, str):
            return detail
    return f"http {status}"

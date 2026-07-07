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

from fastapi import (
    APIRouter,
    Depends,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse

from rt_platform.api import _proxy
from rt_platform.api.dependencies import (
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
        "session_id": read_session_token(request),
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
    # Motor commands keep a more generous default timeout than the other
    # proxies (the hardware-side jog watchdog is latency-sensitive); the
    # forwarding body itself is shared via _proxy.
    return await _proxy.proxy_json(
        method, request, path, json_body=json_body, timeout_s=timeout_s, label="Hardware",
    )


# ─── Control-gated endpoints (audited / param'd — see table below for the
#     pure pass-throughs) ──────────────────────────────────────────────────


@router.post("/api/roboclaw/commands/{command_id}", dependencies=[Depends(require_control)])
async def execute_command(command_id: str, request: Request) -> JSONResponse:
    body = await _safe_json(request)
    return await _forward("POST", request, f"/api/roboclaw/commands/{command_id}", json_body=body)


@router.post("/api/telescope/jog", dependencies=[Depends(require_control)])
async def jog(request: Request) -> JSONResponse:
    body = await _safe_json(request)
    audit_params = {k: body.get(k) for k in ("direction", "speed", "seq") if k in body}
    resp = await _forward("POST", request, "/api/telescope/jog", json_body=body)
    # Only log the first command in each hold (seq 0 or absent) — the hardware
    # sends repeated jog requests while the button is held and we don't need
    # one audit entry per tick.
    if body.get("seq", 0) == 0:
        payload = _payload(resp)
        accepted = bool(payload.get("accepted")) if isinstance(payload, dict) else False
        await _audit_motion(
            request, "jog",
            accepted=accepted and resp.status_code < 400,
            params=audit_params,
            reason=_reason_from(payload, resp.status_code, accepted and resp.status_code < 400),
        )
    return resp


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


# ─── Straight pass-throughs ───────────────────────────────────────────────
# No audit, no body inspection — just forward, so they live in a table rather
# than a function each. Reads use a tight 3 s timeout; control writes
# keep this proxy's generous 10 s default (the hardware-side jog watchdog is
# latency-sensitive), except homing which physically sweeps the axis. Rows that
# forward the request body mirror the old `_safe_json` ({} when absent/!JSON).
_proxy.register_proxy_routes(router, [
    _proxy.ProxyRoute("GET", "/api/roboclaw/status", require_active_queue_session, timeout_s=3.0),
    _proxy.ProxyRoute("GET", "/api/roboclaw/commands", require_active_queue_session, timeout_s=3.0),
    _proxy.ProxyRoute("GET", "/api/telescope/config", require_active_queue_session, timeout_s=3.0),
    _proxy.ProxyRoute("POST", "/api/roboclaw/stop", require_control, timeout_s=10.0),
    _proxy.ProxyRoute("POST", "/api/telescope/jog/stop", require_control, timeout_s=10.0, forward_body=True),
    _proxy.ProxyRoute("POST", "/api/telescope/home/elevation", require_lan_admin, timeout_s=120.0, forward_body=True),
])


# ─── WebSocket bridge ─────────────────────────────────────────────────────


@router.websocket("/ws/roboclaw")
async def roboclaw_ws(ws: WebSocket) -> None:
    """Open one upstream WS to the hardware, relay frames to the browser."""
    await ws.accept()
    if await _proxy.reject_unauthorized_ws(ws):
        return
    upstream_url = _proxy.ws_base_url(ws.app) + "/ws/roboclaw"
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

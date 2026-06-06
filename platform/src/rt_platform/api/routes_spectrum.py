"""Spectrum proxy.

The hardware service runs ``SpectrumService`` (FFT / EMA / baseline) and is
the source of truth for everything spectrum-related. The platform forwards
the HTTP calls and bridges ``/ws/spectrum`` through ``SpectrumBridge``.

Auth: ``require_control`` still gates mutations here, so an anonymous LAN
client can't punch through the proxy to flip the LNA or clobber the
baseline. The hardware service itself is unauthenticated; protect it at the
network layer (Docker internal network, firewall).
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from rt_platform.api.dependencies import (
    is_lan_admin,
    queue_service,
    read_session_token,
    require_active_queue_session,
    require_control,
    require_lan_admin,
)

logger = logging.getLogger("radiotelescope.spectrum_proxy")
router = APIRouter(tags=["spectrum-proxy"])


def _hardware(request: Request):
    return request.app.state.hardware_client


def _bridge(request: Request):
    bridge = getattr(request.app.state, "spectrum_bridge", None)
    if bridge is None:
        raise HTTPException(404, "Spectrum bridge is not running on this host")
    return bridge


async def _proxy_json(
    method: str,
    request: Request,
    path: str,
    json_body: dict | None = None,
    timeout_s: float = 5.0,
) -> JSONResponse:
    """Forward a JSON request to the gateway, mirror its status and body.

    Surfaces 502 only when the upstream is unreachable. Upstream 4xx/5xx
    responses are passed through verbatim so the front-end sees the same
    error semantics it would in ``local`` mode.
    """
    try:
        r = await _hardware(request).request(method, path, json=json_body, timeout=timeout_s)
    except Exception as exc:
        raise HTTPException(502, f"Spectrum gateway unreachable: {exc}") from exc
    try:
        body = r.json()
    except Exception:
        body = {"detail": r.text}
    return JSONResponse(body, status_code=r.status_code)


@router.get("/api/spectrum/status", dependencies=[Depends(require_active_queue_session)])
async def spectrum_status(request: Request) -> JSONResponse:
    try:
        r = await _hardware(request).request("GET", "/api/spectrum/status", timeout=3.0)
        r.raise_for_status()
        return JSONResponse(r.json())
    except Exception as exc:
        # The front-end uses status to drive auto-reconnect — surface the
        # outage as a structured payload rather than a 5xx so it can render.
        logger.debug("Spectrum status proxy failed: %s", exc)
        bridge = getattr(request.app.state, "spectrum_bridge", None)
        return JSONResponse(
            {
                "enabled": True,
                "mode": "disconnected",
                "lna": {"state": "unknown", "label": "Unknown", "detail": "Gateway unreachable"},
                "subscriber_count": bridge.subscriber_count if bridge else 0,
            },
        )


@router.get("/api/spectrum/baseline", dependencies=[Depends(require_active_queue_session)])
async def get_baseline(request: Request) -> JSONResponse:
    return await _proxy_json("GET", request, "/api/spectrum/baseline")


@router.post("/api/spectrum/baseline", dependencies=[Depends(require_control)])
async def capture_baseline(request: Request) -> JSONResponse:
    # Capture integrates a full window (integration_seconds) then bounces the
    # flowgraph, so give the upstream generous headroom before declaring a 502.
    return await _proxy_json("POST", request, "/api/spectrum/baseline", timeout_s=90.0)


@router.delete("/api/spectrum/baseline", dependencies=[Depends(require_control)])
async def clear_baseline(request: Request) -> JSONResponse:
    # Clearing respawns the flowgraph without the baseline; allow for the bounce.
    return await _proxy_json("DELETE", request, "/api/spectrum/baseline", timeout_s=15.0)


@router.post("/api/spectrum/reset", dependencies=[Depends(require_control)])
async def reset_integration(request: Request) -> JSONResponse:
    # Reset bounces the flowgraph to flush the rolling integration.
    return await _proxy_json("POST", request, "/api/spectrum/reset", timeout_s=15.0)


@router.post("/api/spectrum/reconnect", dependencies=[Depends(require_control)])
async def reconnect_sdr(request: Request) -> JSONResponse:
    return await _proxy_json("POST", request, "/api/spectrum/reconnect")


@router.get("/api/admin/spectrum/processing", dependencies=[Depends(require_lan_admin)])
async def get_spectrum_processing(request: Request) -> JSONResponse:
    return await _proxy_json("GET", request, "/api/admin/spectrum/processing", timeout_s=3.0)


@router.post("/api/admin/spectrum/processing", dependencies=[Depends(require_lan_admin)])
async def set_spectrum_processing(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = None
    # Subprocess restarts can take a few seconds; bump the timeout so the
    # client doesn't see a 502 while the GNU Radio flowgraph is bouncing.
    return await _proxy_json("POST", request, "/api/admin/spectrum/processing", json_body=body, timeout_s=15.0)


@router.websocket("/ws/spectrum")
async def spectrum_ws(ws: WebSocket):
    """Re-publish frames from the host-side SpectrumBridge to a browser.

    One upstream WS to the Pi feeds every browser tab — the bridge's pubsub
    fans out locally, so we don't open N parallel connections to the Pi.
    """
    await ws.accept()
    if ws.app.state.config.queue.enabled:
        token = read_session_token(ws)
        if not (is_lan_admin(ws) or queue_service(ws).is_active(token)):
            await ws.close(code=1008, reason="Active queue session required")
            return
    bridge = getattr(ws.app.state, "spectrum_bridge", None)
    if bridge is None:
        await ws.close(code=1011)
        return
    q = bridge.subscribe()
    try:
        while True:
            frame = await q.get()
            await ws.send_json(frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        bridge.unsubscribe(q)

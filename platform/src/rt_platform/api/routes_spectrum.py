"""Spectrum proxy.

The hardware service runs ``SpectrumService`` (FFT / EMA / baseline) and is
the source of truth for everything spectrum-related. The platform forwards
the HTTP calls and bridges ``/ws/spectrum`` through a ``JsonWsBridge``.

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
from rt_platform.api import _proxy
from rt_platform.api.dependencies import (
    require_active_queue_session,
    require_control,
    require_lan_admin,
)

logger = logging.getLogger("radiotelescope.spectrum_proxy")
router = APIRouter(tags=["spectrum-proxy"])


async def _wait_for_ws_disconnect(ws: WebSocket) -> None:
    """Block until the browser closes a send-only websocket."""
    while True:
        await ws.receive_text()


def _bridge(request: Request):
    bridge = getattr(request.app.state, "spectrum_bridge", None)
    if bridge is None:
        raise HTTPException(404, "Spectrum bridge is not running on this host")
    return bridge


@router.get("/api/spectrum/status", dependencies=[Depends(require_active_queue_session)])
async def spectrum_status(request: Request) -> JSONResponse:
    # The front-end uses status to drive auto-reconnect — surface an outage as
    # a structured payload rather than a 5xx so it can render.
    bridge = getattr(request.app.state, "spectrum_bridge", None)
    return await _proxy.status_with_fallback(
        request, "/api/spectrum/status",
        {
            "enabled": True,
            "mode": "disconnected",
            "lna": {"state": "unknown", "label": "Unknown", "detail": "Gateway unreachable"},
            "subscriber_count": bridge.subscriber_count if bridge else 0,
        },
        log_label="Spectrum status",
    )


@router.post("/api/spectrum/baseline", dependencies=[Depends(require_control)])
async def capture_baseline(request: Request) -> JSONResponse:
    # Capture integrates a full window (integration_seconds) of the live stream
    # then bounces the flowgraph to apply the baseline, so give the upstream
    # generous headroom before declaring a 502.
    return await _proxy.proxy_json("POST", request, "/api/spectrum/baseline", timeout_s=90.0, label="Spectrum")


@router.delete("/api/spectrum/baseline", dependencies=[Depends(require_control)])
async def clear_baseline(request: Request) -> JSONResponse:
    # Clearing respawns the flowgraph without the baseline; allow for the bounce.
    return await _proxy.proxy_json("DELETE", request, "/api/spectrum/baseline", timeout_s=15.0, label="Spectrum")


@router.post("/api/spectrum/reset", dependencies=[Depends(require_control)])
async def reset_integration(request: Request) -> JSONResponse:
    # Reset bounces the flowgraph to flush the rolling integration.
    return await _proxy.proxy_json("POST", request, "/api/spectrum/reset", timeout_s=15.0, label="Spectrum")


@router.post("/api/spectrum/reconnect", dependencies=[Depends(require_control)])
async def reconnect_sdr(request: Request) -> JSONResponse:
    return await _proxy.proxy_json("POST", request, "/api/spectrum/reconnect", label="Spectrum")


@router.get("/api/admin/spectrum/processing", dependencies=[Depends(require_lan_admin)])
async def get_spectrum_processing(request: Request) -> JSONResponse:
    return await _proxy.proxy_json("GET", request, "/api/admin/spectrum/processing", timeout_s=3.0, label="Spectrum")


@router.post("/api/admin/spectrum/processing", dependencies=[Depends(require_lan_admin)])
async def set_spectrum_processing(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        body = None
    # Subprocess restarts can take a few seconds; bump the timeout so the
    # client doesn't see a 502 while the GNU Radio flowgraph is bouncing.
    return await _proxy.proxy_json(
        "POST", request, "/api/admin/spectrum/processing", json_body=body, timeout_s=15.0, label="Spectrum",
    )


@router.websocket("/ws/spectrum")
async def spectrum_ws(ws: WebSocket):
    """Re-publish frames from the host-side spectrum bridge to a browser.

    One upstream WS to the Pi feeds every browser tab — the bridge's pubsub
    fans out locally, so we don't open N parallel connections to the Pi.
    """
    await ws.accept()
    if await _proxy.reject_unauthorized_ws(ws):
        return
    bridge = getattr(ws.app.state, "spectrum_bridge", None)
    if bridge is None:
        await ws.close(code=1011)
        return
    bridge.clear_latest()
    if bridge.connected or bridge.subscriber_count > 0:
        try:
            r = await _proxy.hardware(ws).request("POST", "/api/spectrum/reset", timeout=15.0)
            r.raise_for_status()
        except Exception as exc:
            logger.warning("Spectrum reset before websocket subscribe failed: %s", exc)
            await ws.close(code=1011, reason="Spectrum reset failed")
            return
        bridge.clear_latest()
    q = bridge.subscribe()
    disconnect_task = asyncio.create_task(
        _wait_for_ws_disconnect(ws), name="spectrum-ws-disconnect",
    )
    frame_task: asyncio.Task | None = None
    try:
        while True:
            frame_task = asyncio.create_task(q.get(), name="spectrum-ws-frame")
            done, pending = await asyncio.wait(
                {frame_task, disconnect_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if disconnect_task in done:
                try:
                    disconnect_task.result()
                except (WebSocketDisconnect, RuntimeError):
                    pass
                for task in pending:
                    task.cancel()
                break
            frame = frame_task.result()
            frame_task = None
            await ws.send_json(frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        if frame_task is not None and not frame_task.done():
            frame_task.cancel()
        if not disconnect_task.done():
            disconnect_task.cancel()
        bridge.unsubscribe(q)

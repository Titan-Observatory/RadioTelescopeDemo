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

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from fastapi.responses import JSONResponse
from rt_platform.api import _proxy
from rt_platform.api.dependencies import (
    require_active_queue_session,
    require_control,
)

logger = logging.getLogger("radiotelescope.spectrum_proxy")
router = APIRouter(tags=["spectrum-proxy"])


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


# Straight pass-throughs — no params, no audit, no fallback. See _proxy.ProxyRoute.
# Mutations that bounce the GNU Radio flowgraph carry generous timeouts so the
# client doesn't see a 502 while the subprocess restarts.
_proxy.register_proxy_routes(router, [
    # Capture integrates a full window then bounces the flowgraph to apply it.
    _proxy.ProxyRoute("POST", "/api/spectrum/baseline", require_control, timeout_s=90.0, label="Spectrum"),
    # Resetting respawns the flowgraph; allow for the bounce. (Baseline *clearing*
    # is platform-initiated: the queue's control-handover callback calls the
    # hardware DELETE endpoint directly via HardwareClient.)
    _proxy.ProxyRoute("POST", "/api/spectrum/reset", require_control, timeout_s=15.0, label="Spectrum"),
    _proxy.ProxyRoute("POST", "/api/spectrum/reconnect", require_control, label="Spectrum"),
])


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
    await _proxy.pump_bridge_to_websocket(ws, bridge, frame_name="spectrum-ws")

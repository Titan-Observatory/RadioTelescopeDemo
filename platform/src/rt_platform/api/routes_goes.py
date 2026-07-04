"""GOES observation-mode proxy.

The hardware service runs ``GoesService`` (demod pipeline, decode chain,
product store) and is the source of truth. The platform forwards the HTTP
calls and bridges ``/ws/goes`` through a ``JsonWsBridge`` — the same split
used for the spectrum surface, so both observation modes stay segregated
end to end.

Auth mirrors the spectrum proxy: viewers (active queue session) can read
status/products and watch the stream; only the controller can bounce the
pipeline or clear the product archive.

Shared forwarding plumbing lives in ``_proxy`` — see that module.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, WebSocket
from fastapi.responses import JSONResponse, Response

from rt_platform.api import _proxy
from rt_platform.api.dependencies import (
    require_active_queue_session,
    require_control,
)

router = APIRouter(tags=["goes-proxy"])


@router.get("/api/observation", dependencies=[Depends(require_active_queue_session)])
async def observation_info(request: Request) -> JSONResponse:
    """Which observation mode the hardware booted in — drives panel selection.

    Falls back to hydrogen-line when the gateway is unreachable so the UI
    always has a render path; ``degraded`` flags the fallback.
    """
    return await _proxy.status_with_fallback(
        request, "/api/observation",
        {"mode": "hydrogen_line", "satellites": [], "degraded": True},
        log_label="Observation info",
    )


@router.get("/api/goes/status", dependencies=[Depends(require_active_queue_session)])
async def goes_status(request: Request) -> JSONResponse:
    return await _proxy.status_with_fallback(
        request, "/api/goes/status",
        {"enabled": True, "mode": "disconnected", "fault_detail": "Gateway unreachable"},
        log_label="GOES status",
    )


@router.get("/api/goes/products", dependencies=[Depends(require_active_queue_session)])
async def list_products(request: Request) -> JSONResponse:
    limit = request.query_params.get("limit", "60")
    return await _proxy.proxy_json("GET", request, f"/api/goes/products?limit={limit}", label="GOES")


@router.get("/api/goes/products/{product_id}/file", dependencies=[Depends(require_active_queue_session)])
async def product_file(product_id: str, request: Request) -> Response:
    """Binary passthrough for decoded product files (images, bulletins)."""
    return await _proxy.binary_passthrough(
        request, f"/api/goes/products/{product_id}/file",
        timeout_s=20.0,
        default_media_type="application/octet-stream",
        # Products are immutable once decoded; let the browser cache them.
        cache_control="private, max-age=3600",
        label="GOES",
    )


# Straight pass-throughs — no params, no audit, no fallback. See _proxy.ProxyRoute.
_proxy.register_proxy_routes(router, [
    # Bouncing the demod pipeline takes a few seconds; allow for it.
    _proxy.ProxyRoute("POST", "/api/goes/reconnect", require_control, timeout_s=15.0, label="GOES"),
])


@router.websocket("/ws/goes")
async def goes_ws(ws: WebSocket):
    """Re-publish GOES status frames from the host-side bridge to a browser."""
    await ws.accept()
    if await _proxy.reject_unauthorized_ws(ws):
        return
    bridge = getattr(ws.app.state, "goes_bridge", None)
    if bridge is None:
        await ws.close(code=1011)
        return
    await _proxy.pump_bridge_to_websocket(ws, bridge, frame_name="goes-ws")

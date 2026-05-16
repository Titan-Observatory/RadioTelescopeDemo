from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect

from radiotelescope.api.dependencies import require_control

router = APIRouter(tags=["iq"])


@router.post("/api/iq/reconnect", dependencies=[Depends(require_control)])
async def reconnect_iq(request: Request):
    """Force the gateway-server SDR to close + re-open without restarting."""
    publisher = getattr(request.app.state, "iq_publisher", None)
    if publisher is None:
        raise HTTPException(404, "IQ publisher is not running on this host")
    mode = await publisher.reconnect()
    return {"ok": mode not in ("unavailable", "disconnected"), "mode": mode}


@router.get("/api/iq/status")
async def iq_status(request: Request):
    publisher = getattr(request.app.state, "iq_publisher", None)
    if publisher is None:
        return {"enabled": False, "mode": "disabled", "lna": {"state": "off", "label": "Off", "detail": "IQ publisher disabled"}}
    return {"enabled": True, "mode": publisher.mode, "lna": publisher.lna_status.model_dump()}


@router.websocket("/ws/iq")
async def iq_ws(ws: WebSocket):
    """Stream raw `uint8` I/Q pairs from the SDR to a gateway-client host.

    Mounted only when `hardware.mode == "gateway-server"`. The wire format
    is interleaved I,Q,I,Q,... bytes; the consumer is responsible for
    chunking into FFT-sized frames if it cares.
    """
    await ws.accept()
    publisher = getattr(ws.app.state, "iq_publisher", None)
    if publisher is None:
        await ws.close(code=1011)
        return
    q = publisher.subscribe()
    try:
        while True:
            payload = await q.get()
            await ws.send_bytes(payload)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        publisher.unsubscribe(q)

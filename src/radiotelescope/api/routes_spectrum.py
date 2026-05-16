from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect

from radiotelescope.api.dependencies import require_control

router = APIRouter(tags=["spectrum"])


def _service(request: Request):
    service = getattr(request.app.state, "spectrum_service", None)
    if service is None:
        raise HTTPException(404, "Spectrum service is not running on this host")
    return service


@router.get("/api/spectrum/status")
async def spectrum_status(request: Request):
    service = getattr(request.app.state, "spectrum_service", None)
    if service is None:
        return {"enabled": False, "mode": "disabled"}
    cfg = request.app.state.config.sdr
    latest = service.latest
    latest_timestamp = latest.get("timestamp") if latest else None
    return {
        "enabled": cfg.enabled,
        "mode": service.mode,
        "lna": service.lna_status.model_dump(),
        "center_freq_mhz": cfg.center_freq_hz / 1e6,
        "sample_rate_mhz": cfg.sample_rate_hz / 1e6,
        "fft_size": cfg.fft_size,
        "integration_frames": cfg.integration_frames,
        "publish_rate_hz": cfg.publish_rate_hz,
        "latest_timestamp": latest_timestamp,
        "latest_frame_age_s": (time.time() - latest_timestamp) if latest_timestamp else None,
        "latest_frames_seen": service.frames_seen,
        "subscriber_count": service.subscriber_count,
    }


@router.get("/api/spectrum/baseline")
async def get_baseline(request: Request):
    service = _service(request)
    baseline = service.load_baseline()
    if baseline is None:
        raise HTTPException(404, "No baseline has been captured yet")
    return baseline


@router.post("/api/spectrum/baseline", dependencies=[Depends(require_control)])
async def capture_baseline(request: Request):
    service = _service(request)
    baseline = service.capture_baseline()
    if baseline is None:
        raise HTTPException(409, "No spectrum frame is available yet to capture")
    return baseline


@router.post("/api/spectrum/reset", dependencies=[Depends(require_control)])
async def reset_integration(request: Request):
    _service(request).reset_integration()
    return {"ok": True}


@router.post("/api/spectrum/reconnect", dependencies=[Depends(require_control)])
async def reconnect_sdr(request: Request):
    """Force the SDR receiver to close + re-open without restarting the app."""
    service = _service(request)
    mode = await service.reconnect()
    return {"ok": mode not in ("unavailable", "disconnected"), "mode": mode}


@router.delete("/api/spectrum/baseline", dependencies=[Depends(require_control)])
async def clear_baseline(request: Request):
    _service(request).clear_baseline()
    return {"ok": True}


@router.websocket("/ws/spectrum")
async def spectrum_ws(ws: WebSocket):
    await ws.accept()
    service = getattr(ws.app.state, "spectrum_service", None)
    if service is None:
        await ws.close(code=1011)
        return
    q = service.subscribe()
    try:
        while True:
            frame = await q.get()
            await ws.send_json(frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        service.unsubscribe(q)

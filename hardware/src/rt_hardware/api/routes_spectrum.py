from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect

from rt_hardware.services.spectrum import BaselineCaptureError

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
        "integration_seconds": cfg.integration_seconds,
        "publish_rate_hz": cfg.publish_rate_hz,
        "latest_timestamp": latest_timestamp,
        "latest_frame_age_s": (time.time() - latest_timestamp) if latest_timestamp else None,
        "latest_frames_seen": service.frames_seen,
        "subscriber_count": service.subscriber_count,
        "pipeline_pid": service.pipeline_pid,
        "fault_detail": service.fault_detail,
    }


@router.post("/api/spectrum/baseline")
async def capture_baseline(request: Request):
    service = _service(request)
    try:
        baseline = await service.capture_baseline()
    except BaselineCaptureError as exc:
        # Reportable precondition failure (e.g. read-only state dir). Surface
        # the actionable message rather than a generic 409.
        raise HTTPException(503, str(exc)) from exc
    if baseline is None:
        raise HTTPException(
            409,
            "Baseline capture failed: the SDR produced no spectrum. "
            "Check that the dongle is connected and see the hardware logs.",
        )
    return baseline


@router.post("/api/spectrum/reset")
async def reset_integration(request: Request):
    """Flush the rolling integration by bouncing the flowgraph."""
    mode = await _service(request).reset_integration()
    return {"ok": mode not in ("unavailable", "fault"), "mode": mode}


@router.post("/api/spectrum/reconnect")
async def reconnect_sdr(request: Request):
    """Kill + respawn the GNU Radio pipeline subprocess without restarting the app."""
    service = _service(request)
    mode = await service.reconnect()
    return {"ok": mode not in ("unavailable", "fault"), "mode": mode}


@router.delete("/api/spectrum/baseline")
async def clear_baseline(request: Request):
    await _service(request).clear_baseline()
    return {"ok": True}


@router.websocket("/ws/spectrum")
async def spectrum_ws(ws: WebSocket):
    await ws.accept()
    service = getattr(ws.app.state, "spectrum_service", None)
    if service is None:
        await ws.close(code=1011)
        return
    q = service.subscribe()
    # Ensure the pipeline is up without bouncing a running/warming one. Closing
    # here on a transient "fault" would just make the bridge reconnect and bounce
    # again, so only bail when the pipeline is genuinely unavailable (no SDR
    # binary / pyzmq) — a "fault" is left to self-heal via the consumer backoff.
    mode = await service.ensure_started()
    if mode == "unavailable":
        await ws.close(code=1011)
        service.unsubscribe(q)
        return
    while True:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            break
    try:
        while True:
            frame = await q.get()
            # Bound the send so a single slow/stuck consumer can't wedge the
            # writer indefinitely on drain(). The Broadcaster is already
            # drop-oldest on the queue side; if the socket itself can't keep
            # up we drop the connection rather than back the buffer up.
            await asyncio.wait_for(ws.send_json(frame), timeout=5)
    except (WebSocketDisconnect, asyncio.CancelledError, asyncio.TimeoutError):
        pass
    finally:
        service.unsubscribe(q)

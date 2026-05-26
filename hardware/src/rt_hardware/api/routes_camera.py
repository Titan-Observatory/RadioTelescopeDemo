from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from rt_hardware.services.camera import CameraService

logger = logging.getLogger("radiotelescope.camera")
router = APIRouter(tags=["camera"])


def _service(request: Request) -> CameraService | None:
    return getattr(request.app.state, "camera_service", None)


@router.get("/api/camera/frame")
async def camera_frame(request: Request) -> Response:
    """Single freshest JPEG. The intended path for live preview over the
    internet — each request is independent so a stalled fetch can't accumulate
    delay the way an MJPEG stream does.
    """
    svc = _service(request)
    if svc is None:
        raise HTTPException(404, "Camera not configured or disabled")
    data = await svc.acquire_jpeg()
    if data is None:
        raise HTTPException(503, "Camera unavailable")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "no-store"},
    )


@router.get("/api/camera/stream")
async def camera_stream(request: Request) -> StreamingResponse:
    """MJPEG stream, kept for direct hardware access. The platform frontend
    uses /api/camera/frame for resilience."""
    svc = _service(request)
    if svc is None:
        raise HTTPException(404, "Camera not configured or disabled")

    cfg = request.app.state.config.camera
    delay = 1.0 / max(cfg.fps, 1)

    async def _gen() -> AsyncIterator[bytes]:
        while True:
            if await request.is_disconnected():
                break
            data = await svc.acquire_jpeg()
            if data is None:
                break
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n"
            await asyncio.sleep(delay)

    return StreamingResponse(_gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@router.get("/api/camera/status")
async def camera_status(request: Request) -> Response:
    svc = _service(request)
    cfg = getattr(request.app.state.config, "camera", None)
    label = cfg.label if cfg else "Cam A"
    enabled = svc is not None and svc.available
    if enabled:
        enabled = await svc.is_live()
    return Response(
        content=json.dumps({"enabled": enabled, "label": label}),
        media_type="application/json",
    )

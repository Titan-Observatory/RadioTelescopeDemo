"""Camera proxy.

The camera is plugged into the hardware host. The platform exposes the same
`/api/camera/*` URLs the frontend already uses and pipes them through to the
hardware service. Browser-side code never has to know the camera isn't local.

The frontend polls the single-frame endpoint (`/api/camera/frame`) rather
than holding an MJPEG stream open; the hardware service's `/api/camera/stream`
remains available for direct trusted-network access but is not proxied.
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from rt_platform.api import _proxy

router = APIRouter(tags=["camera-proxy"])


@router.get("/api/camera/status")
async def camera_status(request: Request) -> JSONResponse:
    return await _proxy.status_with_fallback(
        request, "/api/camera/status",
        {"enabled": False, "label": "Cam A"},
        log_label="Camera status",
    )


@router.get("/api/camera/frame")
async def camera_frame(request: Request) -> Response:
    """Single-shot JPEG proxy. Short timeout so a stalled hardware fetch
    doesn't pin a connection — the browser polls anyway, it'll retry."""
    return await _proxy.binary_passthrough(
        request, "/api/camera/frame",
        timeout_s=4.0,
        default_media_type="image/jpeg",
        cache_control="no-store",
        label="Camera",
    )

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from rt_hardware.goes.pointing import look_angles
from rt_hardware.models.state import GoesSatelliteInfo, ObservationInfo

router = APIRouter(tags=["goes"])


@router.get("/api/observation")
async def observation_info(request: Request) -> ObservationInfo:
    """Which observation mode this hardware booted in.

    Available in *both* modes — the frontend uses it to pick the panel set.
    Satellite look angles are computed for the configured observer so the
    UI has an authoritative az/el to slew to.
    """
    cfg = request.app.state.config
    if cfg.observation.mode != "goes":
        return ObservationInfo(mode=cfg.observation.mode)
    observer = cfg.observer
    satellites = []
    for sat in cfg.goes.satellites:
        angles = look_angles(observer.latitude_deg, observer.longitude_deg, sat.longitude_deg)
        satellites.append(
            GoesSatelliteInfo(
                id=sat.id,
                name=sat.name,
                longitude_deg=sat.longitude_deg,
                azimuth_deg=round(angles.azimuth_deg, 3),
                elevation_deg=round(angles.elevation_deg, 3),
                range_km=round(angles.range_km, 1),
                visible=angles.visible,
                is_target=sat.id == cfg.goes.target_satellite_id,
            ),
        )
    return ObservationInfo(
        mode="goes",
        downlink_freq_mhz=cfg.goes.downlink_freq_hz / 1e6,
        symbol_rate_baud=cfg.goes.symbol_rate_baud,
        target_satellite_id=cfg.goes.target_satellite_id,
        satellites=satellites,
    )


def _service(request: Request):
    service = getattr(request.app.state, "goes_service", None)
    if service is None:
        raise HTTPException(404, "GOES service is not running on this host (observation.mode != goes)")
    return service


@router.get("/api/goes/status")
async def goes_status(request: Request):
    service = getattr(request.app.state, "goes_service", None)
    if service is None:
        return {"enabled": False, "mode": "disabled"}
    return service.status_snapshot()


@router.post("/api/goes/reconnect")
async def goes_reconnect(request: Request):
    mode = await _service(request).reconnect()
    return {"ok": mode not in ("unavailable", "fault"), "mode": mode}


@router.get("/api/goes/products")
async def list_products(request: Request, limit: int = Query(default=60, ge=1, le=500)):
    service = _service(request)
    # Re-index goesproc's output tree so the archive is fresh even when the
    # pipeline is idle (e.g. products decoded before a restart).
    await asyncio.to_thread(service.products.scan)
    return {
        "total": service.products.total,
        "products": [p.model_dump() for p in service.products.list(limit)],
    }


@router.get("/api/goes/products/{product_id}/file")
async def product_file(product_id: str, request: Request):
    found = _service(request).products.get(product_id)
    if found is None:
        raise HTTPException(404, "Product not found")
    product, path = found
    return FileResponse(path, media_type=product.media_type)


@router.websocket("/ws/goes")
async def goes_ws(ws: WebSocket):
    await ws.accept()
    service = getattr(ws.app.state, "goes_service", None)
    if service is None:
        await ws.close(code=1011)
        return
    q = service.subscribe()
    try:
        while True:
            frame = await q.get()
            # Bounded send so one wedged consumer can't back the writer up;
            # matches the spectrum WS behaviour.
            await asyncio.wait_for(ws.send_json(frame), timeout=5)
    except (WebSocketDisconnect, asyncio.CancelledError, asyncio.TimeoutError):
        pass
    finally:
        service.unsubscribe(q)

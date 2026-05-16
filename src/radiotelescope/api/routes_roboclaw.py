from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect

from radiotelescope.api.dependencies import require_control, require_lan_admin
from radiotelescope.geometry import normalise_azimuth, point_in_triangle, unwrap_azimuth
from radiotelescope.hardware.roboclaw import COMMANDS, OPERATOR_COMMAND_IDS, command_registry
from radiotelescope.models.state import AltAzRequest, CommandInfo, CommandRequest, CommandResult, HealthStatus, RaDecRequest, RoboClawTelemetry, TelescopeConfig
from radiotelescope.pointing import radec_to_altaz
from radiotelescope.services.geometry import altitude_to_encoder_counts

router = APIRouter(tags=["roboclaw"])


def _inside_pointing_limits(altitude_deg: float, azimuth_deg: float, request: Request) -> bool:
    limits = request.app.state.config.mount.pointing_limit_altaz
    if not limits:
        return True

    reference = limits[0].azimuth_deg
    triangle = [
        (unwrap_azimuth(p.azimuth_deg, reference), p.altitude_deg)
        for p in limits
    ]
    point = (unwrap_azimuth(normalise_azimuth(azimuth_deg), reference), altitude_deg)
    return point_in_triangle(point, triangle)


def _resolve(override: int | None, stored: int | None, default: int) -> int:
    """User override → stored controller value → config default."""
    if override is not None:
        return override
    if stored is not None:
        return stored
    return default


def _ramps(speed: int, accel: int | None, decel: int | None) -> tuple[int, int]:
    """Resolve accel/decel for one axis, defaulting both to the axis speed."""
    return (
        accel if accel is not None else speed,
        decel if decel is not None else speed,
    )


def _is_simulated(request: Request) -> bool:
    return _service(request).client.connection.mode == "simulated"


def _enforce_pointing_limits(altitude_deg: float, azimuth_deg: float, request: Request) -> None:
    if _is_simulated(request):
        return  # no physical hardware to protect in simulation
    if not _inside_pointing_limits(altitude_deg, azimuth_deg, request):
        raise HTTPException(
            status_code=400,
            detail=f"Target is outside configured pointing limits (alt={altitude_deg:.1f} deg, az={azimuth_deg:.1f} deg)",
        )


def _service(request: Request):
    return request.app.state.roboclaw_service


@router.get("/api/health", response_model=HealthStatus)
async def health(request: Request):
    service = _service(request)
    return HealthStatus(connection=service.client.connection)


@router.get("/api/roboclaw/status", response_model=RoboClawTelemetry)
async def status(request: Request):
    return _service(request).latest


@router.get("/api/roboclaw/commands", response_model=list[CommandInfo])
async def commands():
    return command_registry()


@router.post("/api/roboclaw/commands/{command_id}", response_model=CommandResult, dependencies=[Depends(require_control)])
async def execute_command(command_id: str, body: CommandRequest, request: Request):
    spec = COMMANDS.get(command_id)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown command: {command_id}")
    if command_id not in OPERATOR_COMMAND_IDS:
        raise HTTPException(status_code=404, detail=f"Command is not available from the web controller: {command_id}")

    client = _service(request).client
    result = await asyncio.to_thread(client.execute, command_id, body.args)
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.error or "RoboClaw command failed")
    return result


@router.post("/api/roboclaw/stop", response_model=dict[str, CommandResult], dependencies=[Depends(require_control)])
async def stop(request: Request):
    return await asyncio.to_thread(_service(request).client.stop_all)


@router.get("/api/telescope/goto")
async def goto_alt_az_info(request: Request):
    cfg = request.app.state.config.mount
    stored_m1, stored_m2 = _service(request).stored_qpps
    altitude_mapping: dict = {"alt_zero_count": cfg.alt_zero_count}
    if cfg.altitude_calibration is not None:
        altitude_mapping["calibration_points"] = [
            {"counts": p.counts, "alt_deg": p.alt_deg} for p in cfg.altitude_calibration.points
        ]
    else:
        altitude_mapping["alt_counts_per_degree"] = cfg.alt_counts_per_degree
    return {
        "method": "POST",
        "body": {
            "altitude_deg": "0..90",
            "azimuth_deg": "0..360",
            "speed_qpps": f"optional; default = controller stored QPPS, fallback {cfg.goto_speed_qpps}",
            "accel_qpps2": "optional; defaults to resolved speed",
            "decel_qpps2": "optional; defaults to resolved speed",
        },
        "mapping": {
            "m1": "azimuth",
            "m2": "altitude",
            "az_counts_per_degree": cfg.az_counts_per_degree,
            "az_zero_count": cfg.az_zero_count,
            "altitude": altitude_mapping,
            "stored_qpps": {"m1": stored_m1, "m2": stored_m2},
        },
    }


async def _execute_goto_altaz(
    altitude_deg: float,
    azimuth_deg: float,
    speed_qpps: int | None,
    accel_qpps2: int | None,
    decel_qpps2: int | None,
    request: Request,
) -> CommandResult:
    cfg = request.app.state.config.mount
    azimuth = 0.0 if azimuth_deg == 360 else azimuth_deg
    _enforce_pointing_limits(altitude_deg, azimuth, request)
    m1_position = round(cfg.az_zero_count + azimuth * cfg.az_counts_per_degree)
    m2_position = altitude_to_encoder_counts(altitude_deg, cfg)
    stored_m1, stored_m2 = _service(request).stored_qpps
    az_speed  = _resolve(speed_qpps, stored_m1, cfg.goto_speed_qpps)
    alt_speed = _resolve(speed_qpps, stored_m2, cfg.goto_speed_qpps)
    az_accel,  az_decel  = _ramps(az_speed,  accel_qpps2, decel_qpps2)
    alt_accel, alt_decel = _ramps(alt_speed, accel_qpps2, decel_qpps2)

    result = await asyncio.to_thread(
        _service(request).client.execute,
        "speed_accel_decel_position_m1m2",
        {
            "m1_accel": az_accel,
            "m1_speed": az_speed,
            "m1_decel": az_decel,
            "m1_position": m1_position,
            "m2_accel": alt_accel,
            "m2_speed": alt_speed,
            "m2_decel": alt_decel,
            "m2_position": m2_position,
            "buffer": 1,
        },
    )
    result.response.update(
        {
            "azimuth_deg": azimuth,
            "altitude_deg": altitude_deg,
            "m1_position": m1_position,
            "m2_position": m2_position,
            "az_speed_qpps": az_speed,
            "alt_speed_qpps": alt_speed,
            "az_accel_qpps2": az_accel,
            "alt_accel_qpps2": alt_accel,
            "az_decel_qpps2": az_decel,
            "alt_decel_qpps2": alt_decel,
        }
    )
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.error or "Goto command failed")
    return result


@router.post("/api/telescope/goto", response_model=CommandResult, dependencies=[Depends(require_control)])
async def goto_alt_az(body: AltAzRequest, request: Request):
    return await _execute_goto_altaz(
        body.altitude_deg, body.azimuth_deg,
        body.speed_qpps, body.accel_qpps2, body.decel_qpps2,
        request,
    )


@router.post("/api/telescope/sync", dependencies=[Depends(require_lan_admin)])
async def sync_alt_az(body: AltAzRequest, request: Request):
    """Recalibrate the alt/az offsets so the current encoder positions are reported as the given alt/az.

    Doesn't move the dish or touch the encoders — just shifts the zero references
    in memory. The change is non-persistent (lost on restart).
    """
    cfg = request.app.state.config.mount
    client = _service(request).client

    enc_m1 = await asyncio.to_thread(client.execute, "read_encoder_m1", {})
    enc_m2 = await asyncio.to_thread(client.execute, "read_encoder_m2", {})
    if not enc_m1.ok or not enc_m2.ok:
        raise HTTPException(400, detail=enc_m1.error or enc_m2.error or "Failed to read encoders")
    current_m1 = enc_m1.response.get("encoder")
    current_m2 = enc_m2.response.get("encoder")
    if current_m1 is None or current_m2 is None:
        raise HTTPException(400, detail="Encoder read returned no value")

    azimuth = normalise_azimuth(body.azimuth_deg)
    cfg.az_zero_count = int(round(current_m1 - azimuth * cfg.az_counts_per_degree))
    cfg.alt_zero_count = 0
    cfg.alt_zero_count = int(current_m2 - altitude_to_encoder_counts(body.altitude_deg, cfg))

    await _service(request).refresh()
    return {
        "az_zero_count": cfg.az_zero_count,
        "alt_zero_count": cfg.alt_zero_count,
        "reported_azimuth_deg": azimuth,
        "reported_altitude_deg": body.altitude_deg,
    }


@router.get("/api/telescope/config", response_model=TelescopeConfig)
async def telescope_config(request: Request):
    cfg = request.app.state.config.mount
    observer = request.app.state.config.observer
    return TelescopeConfig(
        beam_fwhm_deg=request.app.state.fwhm_deg,
        goto_speed_qpps=cfg.goto_speed_qpps,
        goto_accel_qpps2=cfg.goto_accel_qpps2,
        goto_decel_qpps2=cfg.goto_decel_qpps2,
        observer_latitude_deg=observer.latitude_deg,
        observer_longitude_deg=observer.longitude_deg,
        pointing_limit_altaz=[point.model_dump() for point in cfg.pointing_limit_altaz],
    )


@router.post("/api/telescope/goto_radec", response_model=CommandResult, dependencies=[Depends(require_control)])
async def goto_radec(body: RaDecRequest, request: Request):
    antenna = request.app.state.antenna
    alt, az = await asyncio.to_thread(radec_to_altaz, body.ra_deg, body.dec_deg, antenna)
    if alt < 0 and not _is_simulated(request):
        raise HTTPException(status_code=400, detail=f"Target is below the horizon (alt={alt:.1f}°)")
    return await _execute_goto_altaz(
        alt, az,
        body.speed_qpps, body.accel_qpps2, body.decel_qpps2,
        request,
    )


@router.post("/api/telescope/home/elevation", dependencies=[Depends(require_lan_admin)])
async def home_elevation(request: Request):
    """Drive M2 downward until the end stop cuts current to zero, then zero the encoder."""
    client = _service(request).client
    homing_speed = 20          # 20/127 ≈ 16 % — slow enough not to slam the stop
    timeout_s    = 90.0
    threshold_a  = 0.10        # amps; below this counts as "motor stopped"
    consecutive_needed = 5     # 5 × 100 ms = 500 ms of near-zero current to confirm

    start_result = await asyncio.to_thread(client.execute, "backward_m2", {"speed": homing_speed})
    if not start_result.ok:
        raise HTTPException(400, detail=f"Could not start elevation homing: {start_result.error}")

    # Brief pause so the motor has time to draw current before we start polling.
    await asyncio.sleep(0.5)

    deadline    = time.monotonic() + timeout_s
    consecutive = 0

    while time.monotonic() < deadline:
        curr = await asyncio.to_thread(client.execute, "read_motor_currents", {})
        m2_a = curr.response.get("m2_current_a", 999.0)

        if m2_a < threshold_a:
            consecutive += 1
            if consecutive >= consecutive_needed:
                break
        else:
            consecutive = 0

        await asyncio.sleep(0.1)
    else:
        await asyncio.to_thread(client.stop_all)
        raise HTTPException(408, detail=f"Elevation homing timed out after {timeout_s:.0f} s — end stop not reached")

    await asyncio.to_thread(client.stop_all)

    zero_result = await asyncio.to_thread(client.execute, "set_encoder_m2", {"value": 0})
    if not zero_result.ok:
        raise HTTPException(400, detail=f"Homed but could not zero encoder: {zero_result.error}")

    return {"status": "ok", "message": "Elevation homed — encoder zeroed at end stop"}


@router.post("/api/telescope/home/azimuth", dependencies=[Depends(require_lan_admin)])
async def home_azimuth(request: Request):
    """Zero the azimuth encoder at whatever position the telescope is currently pointing."""
    client = _service(request).client
    result = await asyncio.to_thread(client.execute, "set_encoder_m1", {"value": 0})
    if not result.ok:
        raise HTTPException(400, detail=f"Failed to zero azimuth encoder: {result.error}")
    return {"status": "ok", "message": "Azimuth encoder zeroed at current position"}


@router.post("/api/telescope/home/altitude", dependencies=[Depends(require_lan_admin)])
async def home_altitude(request: Request):
    """Zero the M2 encoder register at the current position.

    Mirrors `home_azimuth`: we only touch the encoder count. The reported
    altitude is then whatever the configured calibration maps `counts = 0`
    to — any `alt_zero_count` offset from a prior `/sync` is preserved.
    """
    service = _service(request)
    result = await asyncio.to_thread(service.client.execute, "set_encoder_m2", {"value": 0})
    if not result.ok:
        raise HTTPException(400, detail=f"Failed to zero altitude encoder: {result.error}")
    # Force a fresh snapshot so the encoder readout updates immediately rather
    # than waiting up to one telemetry poll (≈200 ms locally, twice that in
    # gateway-client mode).
    await service.refresh()
    return {"status": "ok", "message": "Altitude encoder zeroed at current position"}


@router.websocket("/ws/roboclaw")
async def roboclaw_ws(ws: WebSocket):
    await ws.accept()
    service = ws.app.state.roboclaw_service
    q = service.subscribe()
    try:
        while True:
            state = await q.get()
            await ws.send_text(state.model_dump_json())
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        service.unsubscribe(q)

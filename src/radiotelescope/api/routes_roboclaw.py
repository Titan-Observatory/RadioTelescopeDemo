from __future__ import annotations

import asyncio
import hashlib
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect

from radiotelescope.api.dependencies import is_lan_admin, require_control, require_lan_admin
from radiotelescope.api.log_files import append_jsonl_with_rotation
from radiotelescope.geometry import normalise_azimuth, point_in_triangle, unwrap_azimuth
from radiotelescope.hardware.roboclaw import COMMANDS, OPERATOR_COMMAND_IDS, command_registry
from radiotelescope.models.state import (
    AltAzRequest,
    CommandInfo,
    CommandRequest,
    CommandResult,
    ElevationHomeRequest,
    HealthStatus,
    JogRequest,
    JogStopRequest,
    RaDecRequest,
    RoboClawTelemetry,
    TelescopeConfig,
)
from radiotelescope.pointing import radec_to_altaz
from radiotelescope.services.geometry import altitude_to_encoder_counts

router = APIRouter(tags=["roboclaw"])

_motion_audit_lock = asyncio.Lock()


def _session_fingerprint(request: Request) -> str | None:
    """Stable short identifier for the requesting session, if any.

    Reads the queue session cookie (configured at `queue.cookie_name`) and
    hashes it so the audit log doesn't store the raw bearer token. Falls
    back to None when no cookie is present.
    """
    cookie_name = request.app.state.config.queue.cookie_name
    raw = request.cookies.get(cookie_name)
    if not raw:
        return None
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _ip_fingerprint(request: Request) -> str | None:
    client = request.client
    if client is None:
        return None
    return hashlib.sha256(client.host.encode("utf-8")).hexdigest()[:12]


async def _audit_motion(
    request: Request,
    endpoint: str,
    *,
    accepted: bool,
    params: dict[str, Any] | None = None,
    reason: str | None = None,
) -> None:
    """Append a single JSONL audit record for a motion command.

    Records both accepted and rejected commands so an audit reader can see
    every attempted slew, who attempted it, and why anything was refused.
    Never raises — audit logging must never block a real motion command.
    """
    try:
        cfg = request.app.state.config
        log_path = Path(cfg.motion_log_path)
        max_bytes = cfg.motion_log_max_bytes
    except AttributeError:
        return  # config not wired up (e.g. some unit tests)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "endpoint": endpoint,
        "accepted": accepted,
        "reason": reason,
        "session_hash": _session_fingerprint(request),
        "ip_hash": _ip_fingerprint(request),
        "params": params or {},
    }
    try:
        async with _motion_audit_lock:
            await asyncio.to_thread(append_jsonl_with_rotation, log_path, entry, max_bytes)
    except Exception:
        pass  # never let audit failure interfere with motion semantics

GATEWAY_INTERNAL_COMMAND_IDS = {
    "read_encoders",
    "set_encoder_m2",
    "speed_accel_decel_position_m1m2",
}

JOG_COMMANDS: dict[str, str] = {
    "west": "forward_m1",
    "east": "backward_m1",
    "up": "forward_m2",
    "down": "backward_m2",
}
JOG_HEARTBEAT_TIMEOUT_S = 1.0


def _position_targets(command_id: str, args: dict[str, int | bool]) -> dict[str, int | None] | None:
    if command_id == "speed_accel_decel_position_m1":
        return {"m1": int(args["position"])}
    if command_id == "speed_accel_decel_position_m2":
        return {"m2": int(args["position"])}
    if command_id == "speed_accel_decel_position_m1m2":
        return {"m1": int(args["m1_position"]), "m2": int(args["m2_position"])}
    return None


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


def _is_disconnected(request: Request) -> bool:
    # Only the explicit "no hardware wired up" state bypasses safety gates.
    # Transient errors and remote-gateway failures (mode="error") still enforce.
    return _service(request).client.connection.mode == "disconnected"


def _enforce_pointing_limits(altitude_deg: float, azimuth_deg: float, request: Request) -> None:
    if _is_disconnected(request):
        return  # no physical hardware to protect
    if not _inside_pointing_limits(altitude_deg, azimuth_deg, request):
        raise HTTPException(
            status_code=400,
            detail=f"Target is outside configured pointing limits (alt={altitude_deg:.1f} deg, az={azimuth_deg:.1f} deg)",
        )


def _shortest_az_delta(from_az: float, to_az: float) -> float:
    """Signed shortest-arc azimuth delta in degrees, range (-180, 180]."""
    d = (to_az - from_az) % 360.0
    return d if d <= 180.0 else d - 360.0


def _enforce_max_slew(target_altitude_deg: float, target_azimuth_deg: float, request: Request) -> None:
    """Reject single goto commands that would slew further than the configured cap.

    Uses max(|Δalt|, shortest-arc |Δaz|) as the travel metric, which maps directly
    to per-axis mount motion (each axis moves independently). Skips the check when
    hardware is disconnected or when no current-position baseline exists yet.
    """
    cfg = request.app.state.config.mount
    cap = cfg.max_slew_deg_per_command
    if cap <= 0 or _is_disconnected(request):
        return
    current = _service(request).latest
    if current.altitude_deg is None or current.azimuth_deg is None:
        return  # no baseline yet — the first command after startup establishes it
    dalt = abs(target_altitude_deg - current.altitude_deg)
    daz = abs(_shortest_az_delta(current.azimuth_deg, target_azimuth_deg))
    travel = max(dalt, daz)
    if travel > cap:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Requested slew of {travel:.1f}° exceeds the per-command cap of {cap:.1f}° "
                f"(current alt={current.altitude_deg:.1f}° az={current.azimuth_deg:.1f}°, "
                f"target alt={target_altitude_deg:.1f}° az={target_azimuth_deg:.1f}°)"
            ),
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
    gateway_internal = (
        command_id in GATEWAY_INTERNAL_COMMAND_IDS
        and request.app.state.config.hardware.mode == "gateway-server"
        and is_lan_admin(request)
    )
    if command_id not in OPERATOR_COMMAND_IDS and not gateway_internal:
        raise HTTPException(status_code=404, detail=f"Command is not available from the web controller: {command_id}")

    service = _service(request)
    result = await service.execute(command_id, body.args)
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.error or "RoboClaw command failed")
    targets = _position_targets(command_id, body.args)
    if targets is not None:
        service.set_position_target(**targets)
    elif spec.kind == "motion":
        service.set_position_target()
    return result


@router.post("/api/roboclaw/stop", response_model=dict[str, CommandResult], dependencies=[Depends(require_control)])
async def stop(request: Request):
    service = _service(request)
    service.set_position_target()
    return await service.stop_all()


@router.post("/api/telescope/jog", dependencies=[Depends(require_control)])
async def jog(body: JogRequest, request: Request):
    audit_params = {"direction": body.direction, "speed": body.speed, "seq": body.seq}
    service = _service(request)
    if not service.accept_jog_sequence(body.token, body.seq):
        await _audit_motion(request, "jog", accepted=False, params=audit_params, reason="stale sequence")
        return {"ok": True, "accepted": False, "stale": True}

    service.set_position_target()
    command_id = JOG_COMMANDS[body.direction]
    result = await service.execute(command_id, {"speed": body.speed})
    if not result.ok:
        await _audit_motion(
            request, "jog", accepted=False, params=audit_params,
            reason=result.error or "Jog command failed",
        )
        raise HTTPException(status_code=400, detail=result.error or "Jog command failed")

    if not service.is_current_jog_sequence(body.token, body.seq):
        await _audit_motion(request, "jog", accepted=False, params=audit_params, reason="superseded mid-flight")
        return {"ok": True, "accepted": False, "stale": True}

    service.arm_jog_watchdog(body.token, body.seq, JOG_HEARTBEAT_TIMEOUT_S)
    await _audit_motion(request, "jog", accepted=True, params=audit_params)
    return {"ok": True, "accepted": True, "command_id": command_id, "seq": body.seq}


@router.post("/api/telescope/jog/stop", response_model=dict[str, CommandResult], dependencies=[Depends(require_control)])
async def stop_jog(body: JogStopRequest, request: Request):
    service = _service(request)
    if not service.accept_jog_sequence(body.token, body.seq):
        return {}
    if not service.can_stop_active_jog(body.token, body.seq):
        return {}
    service.clear_jog_watchdog(body.token, body.seq)
    service.set_position_target()
    return await service.stop_all()


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
    _enforce_max_slew(altitude_deg, azimuth, request)
    m1_position = round(cfg.az_zero_count + azimuth * cfg.az_counts_per_degree)
    m2_position = altitude_to_encoder_counts(altitude_deg, cfg)
    stored_m1, stored_m2 = _service(request).stored_qpps
    az_speed  = _resolve(speed_qpps, stored_m1, cfg.goto_speed_qpps)
    alt_speed = _resolve(speed_qpps, stored_m2, cfg.goto_speed_qpps)
    az_accel,  az_decel  = _ramps(az_speed,  accel_qpps2, decel_qpps2)
    alt_accel, alt_decel = _ramps(alt_speed, accel_qpps2, decel_qpps2)

    service = _service(request)
    result = await service.execute(
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
    service.set_position_target(m1=m1_position, m2=m2_position)
    return result


@router.post("/api/telescope/goto", response_model=CommandResult, dependencies=[Depends(require_control)])
async def goto_alt_az(body: AltAzRequest, request: Request):
    audit_params = {"altitude_deg": body.altitude_deg, "azimuth_deg": body.azimuth_deg}
    try:
        result = await _execute_goto_altaz(
            body.altitude_deg, body.azimuth_deg,
            body.speed_qpps, body.accel_qpps2, body.decel_qpps2,
            request,
        )
    except HTTPException as exc:
        await _audit_motion(request, "goto", accepted=False, params=audit_params, reason=str(exc.detail))
        raise
    await _audit_motion(request, "goto", accepted=True, params=audit_params)
    return result


@router.post("/api/telescope/sync", dependencies=[Depends(require_lan_admin)])
async def sync_alt_az(body: AltAzRequest, request: Request):
    """Recalibrate the alt/az offsets so the current encoder positions are reported as the given alt/az.

    Doesn't move the dish or touch the encoders — just shifts the zero references
    in memory. The change is non-persistent (lost on restart).
    """
    cfg = request.app.state.config.mount
    service = _service(request)

    enc_m1 = await service.execute("read_encoder_m1", {})
    enc_m2 = await service.execute("read_encoder_m2", {})
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

    await service.refresh()
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
    audit_params = {"ra_deg": body.ra_deg, "dec_deg": body.dec_deg}
    try:
        antenna = request.app.state.antenna
        alt, az = await asyncio.to_thread(radec_to_altaz, body.ra_deg, body.dec_deg, antenna)
        if alt < 0 and not _is_disconnected(request):
            raise HTTPException(status_code=400, detail=f"Target is below the horizon (alt={alt:.1f}°)")
        audit_params["resolved_altitude_deg"] = alt
        audit_params["resolved_azimuth_deg"] = az
        result = await _execute_goto_altaz(
            alt, az,
            body.speed_qpps, body.accel_qpps2, body.decel_qpps2,
            request,
        )
    except HTTPException as exc:
        await _audit_motion(request, "goto_radec", accepted=False, params=audit_params, reason=str(exc.detail))
        raise
    await _audit_motion(request, "goto_radec", accepted=True, params=audit_params)
    return result


@router.post("/api/telescope/home/elevation", dependencies=[Depends(require_lan_admin)])
async def home_elevation(request: Request, body: ElevationHomeRequest | None = None):
    """Drive M2 downward until encoder counts stop decreasing, then zero it."""
    service = _service(request)
    service.set_position_target()
    poll_s = 0.1
    timeout_s = 90.0
    min_homing_s = 0.75
    consecutive_needed = 5
    min_decrease_counts = 1

    speed = body.speed if body is not None else ElevationHomeRequest().speed
    start_result = await service.execute("backward_m2", {"speed": speed})
    if not start_result.ok:
        raise HTTPException(400, detail=f"Could not start elevation homing: {start_result.error}")

    started_at = time.monotonic()
    deadline = started_at + timeout_s
    consecutive_stalled = 0
    previous_encoder: int | None = None

    try:
        while time.monotonic() < deadline:
            await asyncio.sleep(poll_s)
            encoders = await service.execute("read_encoders", {})
            if not encoders.ok:
                raise HTTPException(400, detail=f"Could not read elevation encoder: {encoders.error}")
            current_encoder = encoders.response.get("m2_encoder")
            if not isinstance(current_encoder, int):
                raise HTTPException(400, detail="Could not read elevation encoder")

            if previous_encoder is None:
                previous_encoder = current_encoder
                continue

            if current_encoder <= previous_encoder - min_decrease_counts:
                consecutive_stalled = 0
            else:
                consecutive_stalled += 1
                if (
                    consecutive_stalled >= consecutive_needed
                    and time.monotonic() - started_at >= min_homing_s
                ):
                    break

            previous_encoder = current_encoder
        else:
            raise HTTPException(408, detail=f"Elevation homing timed out after {timeout_s:.0f} s; encoder kept decreasing")
    finally:
        await service.execute("forward_m2", {"speed": 0})

    zero_result = await service.execute("set_encoder_m2", {"value": 0})
    if not zero_result.ok:
        raise HTTPException(400, detail=f"Homed but could not zero encoder: {zero_result.error}")

    await service.refresh()
    return {"status": "ok", "message": "Elevation homed; encoder zeroed where counts stopped decreasing"}


@router.post("/api/telescope/home/azimuth", dependencies=[Depends(require_lan_admin)])
async def home_azimuth(request: Request):
    """Zero the azimuth encoder at whatever position the telescope is currently pointing."""
    service = _service(request)
    result = await service.execute("set_encoder_m1", {"value": 0})
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
    result = await service.execute("set_encoder_m2", {"value": 0})
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

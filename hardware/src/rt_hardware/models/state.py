from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


ConnectionMode = Literal["serial", "disconnected", "error"]
LnaState = Literal["on", "off", "unknown", "fault"]
ArgType = Literal["u8", "u16", "s16", "u32", "s32", "bool"]
ObservationMode = Literal["hydrogen_line", "goes"]
# Acquisition ladder for the GOES downlink, in order: nothing → RF power seen
# → demod locked on the carrier → frame sync on the CCSDS ASM → decoded
# products flowing. "fault"/"unavailable" mirror SpectrumService semantics.
GoesStage = Literal["idle", "searching", "signal", "frames", "data", "fault", "unavailable"]
GoesProductKind = Literal["image", "text", "binary"]


class ConnectionStatus(BaseModel):
    mode: ConnectionMode
    port: str
    baudrate: int
    address: int
    connected: bool
    message: str | None = None


class MotorSnapshot(BaseModel):
    command: int = 0
    pwm: int | None = None
    current_a: float | None = None
    encoder: int | None = None
    encoder_status: int | None = None
    speed_qpps: int | None = None
    raw_speed_qpps: int | None = None
    average_speed_qpps: int | None = None
    speed_error_qpps: int | None = None
    position_error: int | None = None


class HostStats(BaseModel):
    cpu_temp_c: float | None = None
    load_1m: float | None = None
    load_5m: float | None = None
    load_15m: float | None = None
    cpu_count: int | None = None
    memory_total_mb: float | None = None
    memory_available_mb: float | None = None
    memory_used_percent: float | None = None
    disk_total_gb: float | None = None
    disk_free_gb: float | None = None
    disk_used_percent: float | None = None
    uptime_s: float | None = None


class PollStats(BaseModel):
    target_hz: float
    actual_hz: float | None = None
    last_tick_age_s: float | None = None


class LnaStatus(BaseModel):
    state: LnaState = "unknown"
    label: str = "Unknown"
    detail: str | None = None


class RoboClawTelemetry(BaseModel):
    connection: ConnectionStatus
    timestamp: float
    poll: PollStats | None = None
    firmware: str | None = None
    main_battery_v: float | None = None
    logic_battery_v: float | None = None
    temperature_c: float | None = None
    temperature_2_c: float | None = None
    status: int | None = None
    status_flags: list[str] = Field(default_factory=list)
    buffer_depths: dict[str, int | None] = Field(default_factory=dict)
    encoder_modes: dict[str, int | None] = Field(default_factory=dict)
    motors: dict[str, MotorSnapshot] = Field(default_factory=dict)
    host: HostStats = Field(default_factory=HostStats)
    last_error: str | None = None
    altitude_deg: float | None = None
    azimuth_deg: float | None = None
    ra_deg: float | None = None
    dec_deg: float | None = None


class CommandArg(BaseModel):
    name: str
    type: ArgType
    label: str
    min: int | None = None
    max: int | None = None
    default: int | bool | None = None


class CommandInfo(BaseModel):
    id: str
    name: str
    group: str
    description: str
    command: int
    kind: Literal["read", "write", "motion", "config"]
    dangerous: bool = False
    args: list[CommandArg] = Field(default_factory=list)


class CommandRequest(BaseModel):
    args: dict[str, int | bool] = Field(default_factory=dict)


class JogRequest(BaseModel):
    token: str = Field(min_length=8, max_length=80)
    seq: int = Field(ge=0)
    direction: Literal["west", "east", "up", "down"]
    speed: int = Field(ge=0, le=127)


class JogStopRequest(BaseModel):
    token: str = Field(min_length=8, max_length=80)
    seq: int = Field(ge=0)


class ElevationHomeRequest(BaseModel):
    speed: int = Field(default=108, ge=1, le=127)


class AltAzPoint(BaseModel):
    altitude_deg: float = Field(ge=0, le=90)
    azimuth_deg: float = Field(ge=0, le=360)


class HardSafetyLimits(BaseModel):
    altitude_min_deg: float
    altitude_max_deg: float
    azimuth_min_deg: float
    azimuth_max_deg: float


class _MotionParams(BaseModel):
    """Common optional motion overrides for goto requests.

    Each field is optional so callers can rely on per-axis defaults resolved
    from the controller's stored velocity-PID QPPS plus the mount config.
    """
    speed_qpps: int | None = Field(default=None, ge=0)
    accel_qpps2: int | None = Field(default=None, ge=0)
    decel_qpps2: int | None = Field(default=None, ge=0)


class AltAzRequest(AltAzPoint, _MotionParams):
    pass


class CommandResult(BaseModel):
    command_id: str
    ok: bool
    response: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class TelescopeConfig(BaseModel):
    beam_fwhm_deg: float
    goto_speed_qpps: int
    goto_accel_qpps2: int
    goto_decel_qpps2: int
    observer_latitude_deg: float
    observer_longitude_deg: float
    hard_safety_limits: HardSafetyLimits


class RaDecRequest(_MotionParams):
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)


class SkyOverlay(BaseModel):
    id: str
    label: str
    ra_deg: float
    dec_deg: float
    color: str = "#ffffff"


class HealthStatus(BaseModel):
    status: str = "ok"
    connection: ConnectionStatus


class VelocityPid(BaseModel):
    p: int = Field(ge=0, le=4_294_967_295)
    i: int = Field(ge=0, le=4_294_967_295)
    d: int = Field(ge=0, le=4_294_967_295)
    qpps: int = Field(ge=0, le=4_294_967_295)


class PositionPid(BaseModel):
    p: int = Field(ge=0, le=4_294_967_295)
    i: int = Field(ge=0, le=4_294_967_295)
    d: int = Field(ge=0, le=4_294_967_295)
    i_max: int = Field(ge=0, le=4_294_967_295)
    deadzone: int = Field(ge=0, le=4_294_967_295)
    min: int = Field(ge=-2_147_483_648, le=2_147_483_647)
    max: int = Field(ge=-2_147_483_648, le=2_147_483_647)


class PidBundle(BaseModel):
    vel_m1: VelocityPid
    vel_m2: VelocityPid
    pos_m1: PositionPid
    pos_m2: PositionPid


class GoesSatelliteInfo(BaseModel):
    """A geostationary satellite from the config catalog, with look angles
    computed for the configured observer location."""
    id: str
    name: str
    longitude_deg: float
    azimuth_deg: float
    elevation_deg: float
    range_km: float
    visible: bool
    is_target: bool = False


class ObservationInfo(BaseModel):
    """Which observation mode the hardware service booted in.

    The frontend fetches this once to decide which panel set to render. The
    GOES fields are only populated in GOES mode.
    """
    mode: ObservationMode
    downlink_freq_mhz: float | None = None
    symbol_rate_baud: float | None = None
    target_satellite_id: str | None = None
    satellites: list[GoesSatelliteInfo] = Field(default_factory=list)


class GoesProduct(BaseModel):
    """One decoded product file indexed from goesproc's output directory."""
    id: str
    kind: GoesProductKind
    name: str
    # Directory path relative to the product store root — goesproc groups
    # output by handler (e.g. "images/goes19/2026-06-12"), which gives the
    # UI a meaningful category label for free.
    group: str | None = None
    size_bytes: int
    created_at: float
    media_type: str
    # First few hundred characters for text products so the explorer can show
    # them inline without a second request.
    preview: str | None = None


class PidWriteRequest(BaseModel):
    vel_m1: VelocityPid | None = None
    vel_m2: VelocityPid | None = None
    pos_m1: PositionPid | None = None
    pos_m2: PositionPid | None = None

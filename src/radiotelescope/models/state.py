from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


ConnectionMode = Literal["serial", "disconnected", "error"]
LnaState = Literal["on", "off", "unknown", "fault"]
ArgType = Literal["u8", "u16", "s16", "u32", "s32", "bool"]


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
    pointing_limit_altaz: list[AltAzPoint] = Field(default_factory=list)


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

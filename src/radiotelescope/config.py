from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# The pointing-limit triangle uses the same alt/az shape as `AltAzPoint` from
# the response models. Re-export under the historical name to preserve config
# imports while keeping a single source of truth for the field validators.
from radiotelescope.models.state import AltAzPoint as AltAzLimitPoint


class RoboClawConfig(BaseModel):
    port: str = "/dev/ttyACM0"
    baudrate: int = Field(default=38400, gt=0)
    # Packet Serial uses a one-byte address. BasicMicro may show the default
    # as decimal 128, which is 0x80 in this config, not 0x128.
    address: int = Field(default=0x80, ge=0x80, le=0x87)
    timeout_s: float = Field(default=0.25, gt=0)
    connect_mode: Literal["auto", "serial", "simulated"] = "auto"


class TelemetryConfig(BaseModel):
    update_rate_hz: int = Field(default=5, ge=1, le=50)


class ObserverConfig(BaseModel):
    name: str = "Radio Telescope"
    latitude_deg: float = Field(default=51.5, ge=-90, le=90)
    longitude_deg: float = Field(default=-0.1, ge=-180, le=180)
    altitude_m: float = Field(default=0.0)
    dish_diameter_m: float = Field(default=2.286, gt=0)
    observing_freq_hz: float = Field(default=1.42e9, gt=0)
    beam_fwhm_deg: float | None = None


class AltitudeCalibrationPoint(BaseModel):
    counts: int
    alt_deg: float


class AltitudeCalibrationConfig(BaseModel):
    """Empirical (counts → altitude) calibration for the elevation axis.

    Provide 2+ measurement points (counts, alt_deg). Two points fit a line; 3+
    fit a quadratic that passes through all of them. Used in place of the
    linear `alt_counts_per_degree` whenever this block is present.
    """
    points: list[AltitudeCalibrationPoint]

    @field_validator("points")
    @classmethod
    def _enough_points(cls, value: list[AltitudeCalibrationPoint]) -> list[AltitudeCalibrationPoint]:
        if len(value) < 2:
            raise ValueError("altitude calibration needs at least 2 points")
        counts_seen = [p.counts for p in value]
        if len(set(counts_seen)) != len(counts_seen):
            raise ValueError("altitude calibration points must have unique counts")
        return value


class MountConfig(BaseModel):
    # Negative values invert the corresponding axis (use when the motor's encoder
    # counts up in the opposite direction from increasing degrees).
    az_counts_per_degree: float = Field(default=1000.0)
    alt_counts_per_degree: float = Field(default=1000.0)

    @field_validator("az_counts_per_degree", "alt_counts_per_degree")
    @classmethod
    def _nonzero_counts(cls, value: float) -> float:
        if value == 0:
            raise ValueError("counts_per_degree must be nonzero")
        return value
    az_zero_count: int = 0
    alt_zero_count: int = 0
    # Fallback values used only if the controller's stored velocity-PID QPPS
    # cannot be read at startup. In normal operation those values come from the
    # RoboClaw itself (cached on RoboClawService.start). Accel/decel default to
    # the resolved speed (≈1 s ramp) unless explicitly overridden per request.
    goto_speed_qpps: int = Field(default=10_000, ge=0)
    goto_accel_qpps2: int = Field(default=25_000, ge=0)
    goto_decel_qpps2: int = Field(default=25_000, ge=0)
    pointing_limit_altaz: list[AltAzLimitPoint] = Field(default_factory=list)
    altitude_calibration: AltitudeCalibrationConfig | None = None

    @field_validator("pointing_limit_altaz")
    @classmethod
    def validate_pointing_limit_altaz(cls, value: list[AltAzLimitPoint]) -> list[AltAzLimitPoint]:
        if len(value) not in (0, 3):
            raise ValueError("pointing_limit_altaz must be empty or contain exactly 3 alt/az points")
        return value


class CameraConfig(BaseModel):
    enabled: bool = True
    device: int = Field(default=0, ge=0)
    fps: int = Field(default=15, ge=1, le=60)
    width: int = Field(default=1280, ge=160, le=4096)
    height: int = Field(default=720, ge=120, le=2160)
    label: str = "Cam A"


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    allowed_clients: list[str] = Field(default_factory=lambda: ["10.0.27.1", "10.0.27.2"])
    trusted_proxies: list[str] = Field(default_factory=lambda: ["127.0.0.1", "::1"])
    # When True, only IPs in `allowed_clients` (plus loopback) may reach the
    # server at all. Use for LAN-only deployments. When False, every IP can
    # connect and per-endpoint authorization is delegated to the queue/session
    # layer (`require_control` + `is_lan_admin` admin override).
    lan_only: bool = False


class QueueConfig(BaseModel):
    enabled: bool = True
    max_session_seconds: int = Field(default=600, ge=10)
    idle_timeout_seconds: int = Field(default=60, ge=5)
    max_queue_size: int = Field(default=100, ge=1)
    cookie_secret: str = Field(default="change-me-in-config", min_length=8)
    cookie_name: str = "rt_session"


class AuthConfig(BaseModel):
    enabled: bool = False
    passwords_file: str = "passwords.txt"
    secret_key: str = Field(default="change-me-in-config", min_length=8)
    max_attempts: int = Field(default=5, ge=1)
    lockout_minutes: int = Field(default=15, ge=1)


class TurnstileConfig(BaseModel):
    enabled: bool = True
    site_key: str = ""
    secret_key: str = ""


class SDRConfig(BaseModel):
    enabled: bool = True
    # Airspy Mini tunes 24 MHz – 1.7 GHz; the hydrogen line at 1420.405 MHz
    # sits comfortably inside it.
    center_freq_hz: float = Field(default=1.4204e9, gt=0)
    # Airspy Mini supports 3 Msps and 6 Msps only; Airspy R2 adds 2.5/10 Msps.
    sample_rate_hz: float = Field(default=3.0e6, gt=0)
    fft_size: int = Field(default=2048, ge=64)
    # Airspy "overall" gain is a 0-21 linearity index (not dB). ``None``
    # enables AGC. Field name kept as ``gain_db`` for config back-compat.
    gain_db: float | None = None
    # Enable Airspy's 4.5 V bias tee to power an inline LNA over the coax.
    # Only turn this on when the connected RF chain is safe to bias.
    lna_bias_tee_enabled: bool = False
    # Rolling integration: number of FFT frames averaged exponentially before
    # publishing. Larger = smoother but slower to react.
    integration_frames: int = Field(default=32, ge=1, le=4096)
    # Frames-per-second of WebSocket publications (FFTs are computed faster
    # internally; this throttles the rate sent to clients).
    publish_rate_hz: float = Field(default=5.0, gt=0)


class HardwareConfig(BaseModel):
    """Selects where motor + SDR hardware lives relative to this process.

    - ``local`` (default): hardware is attached to this box; run everything
      in one app. Today's behaviour.
    - ``gateway-server``: this box owns the hardware but the web UI runs
      elsewhere. Mounts hardware routes only; skips web UI, queue, and the
      spectrum DSP pipeline (raw IQ is streamed instead).
    - ``gateway-client``: this box runs the web UI and DSP but talks to a
      remote ``gateway-server`` over the LAN for motor + SDR.
    """
    mode: Literal["local", "gateway-server", "gateway-client"] = "local"
    gateway_host: str = "localhost"
    gateway_port: int = 8000

    @property
    def base_url(self) -> str:
        return f"http://{self.gateway_host}:{self.gateway_port}"

    @property
    def ws_base_url(self) -> str:
        return f"ws://{self.gateway_host}:{self.gateway_port}"


class GeneralConfig(BaseModel):
    log_level: str = "INFO"


class AppConfig(BaseModel):
    general: GeneralConfig = Field(default_factory=GeneralConfig)
    hardware: HardwareConfig = Field(default_factory=HardwareConfig)
    roboclaw: RoboClawConfig = Field(default_factory=RoboClawConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    mount: MountConfig = Field(default_factory=MountConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    observer: ObserverConfig = Field(default_factory=ObserverConfig)
    camera: CameraConfig = Field(default_factory=CameraConfig)
    sdr: SDRConfig = Field(default_factory=SDRConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)
    turnstile: TurnstileConfig = Field(default_factory=TurnstileConfig)
    feedback_log_path: str = "feedback.jsonl"
    events_log_path: str = "events.jsonl"
    auth: AuthConfig = Field(default_factory=AuthConfig)


def load_config(path: Path | str = "config.toml") -> AppConfig:
    path = Path(path)
    if not path.exists():
        # `config.toml` is gitignored — only the `config.example.toml` template
        # ships in the repo. Point the user at the obvious next step instead of
        # letting `tomllib` raise a bare FileNotFoundError.
        example = path.with_name("config.example.toml")
        hint = f" Copy `{example.name}` to `{path.name}` and edit it." if example.exists() else ""
        raise FileNotFoundError(f"Config file not found: {path}.{hint}")
    with path.open("rb") as f:
        raw = tomllib.load(f)
    return AppConfig.model_validate(raw)

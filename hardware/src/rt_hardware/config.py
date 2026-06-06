from __future__ import annotations

import os
import re
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

# The pointing-limit triangle uses the same alt/az shape as `AltAzPoint` from
# the response models. Re-export under the historical name to preserve config
# imports while keeping a single source of truth for the field validators.
from rt_hardware.models.state import AltAzPoint as AltAzLimitPoint


class RoboClawConfig(BaseModel):
    port: str = "/dev/ttyACM0"
    baudrate: int = Field(default=38400, gt=0)
    # Packet Serial uses a one-byte address. BasicMicro may show the default
    # as decimal 128, which is 0x80 in this config, not 0x128.
    address: int = Field(default=0x80, ge=0x80, le=0x87)
    timeout_s: float = Field(default=0.25, gt=0)
    connect_mode: Literal["auto", "serial"] = "auto"


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
    goto_speed_qpps: int = Field(default=10_000, ge=0)
    goto_accel_qpps2: int = Field(default=25_000, ge=0)
    goto_decel_qpps2: int = Field(default=25_000, ge=0)
    goto_arrival_tolerance_counts: int = Field(default=1, ge=0)
    pointing_limit_altaz: list[AltAzLimitPoint] = Field(default_factory=list)
    altitude_calibration: AltitudeCalibrationConfig | None = None
    max_slew_deg_per_command: float = Field(default=45.0, ge=0, le=360)
    home_elevation_on_boot: bool = False

    @field_validator("pointing_limit_altaz")
    @classmethod
    def validate_pointing_limit_altaz(cls, value: list[AltAzLimitPoint]) -> list[AltAzLimitPoint]:
        if len(value) != 0 and len(value) < 3:
            raise ValueError("pointing_limit_altaz must be empty or contain at least 3 alt/az points")
        return value


class CameraConfig(BaseModel):
    enabled: bool = True
    device: int = Field(default=0, ge=0)
    fps: int = Field(default=15, ge=1, le=60)
    width: int = Field(default=1280, ge=160, le=4096)
    height: int = Field(default=720, ge=120, le=2160)
    label: str = "Cam A"


class ServerConfig(BaseModel):
    """Where the hardware service listens. Always trusted-network; no auth."""
    host: str = "0.0.0.0"
    port: int = 8001


class SDRConfig(BaseModel):
    enabled: bool = True
    center_freq_hz: float = Field(default=1.4204e9, gt=0)
    sample_rate_hz: float = Field(default=3.0e6, gt=0)
    fft_size: int = Field(default=8192, ge=64)
    gain_db: float | None = None
    lna_bias_tee_enabled: bool = False
    publish_rate_hz: float = Field(default=5.0, gt=0)
    # EMA time constant for the displayed spectrum. The Python consumer
    # blends each averaged spectrum from the GNU Radio flowgraph into a
    # rolling exponential window of this length. Display responsiveness
    # (settling time) ≈ this value; per-bin σ ≈ 1/√(integration_seconds × B).
    integration_seconds: float = Field(default=15.0, gt=0)
    # Path to the IPC socket the GNU Radio subprocess publishes spectra on.
    # Defaults to the per-process tmp socket; override in containerised
    # deployments if /tmp is read-only or shared across services.
    pipeline_ipc_path: str = "ipc:///tmp/rt-spectrum.sock"

    # Baseline-correction knobs applied at flowgraph build time. baseline_scale
    # multiplies the stored baseline before division; baseline_offset_db is an
    # additive dB shift on the output. Defaults are no-ops.
    baseline_scale: float = Field(default=1.0, ge=0.1, le=10.0)
    baseline_offset_db: float = Field(default=0.0, ge=-30.0, le=30.0)
    # Width (in bins) of the median spur-reject applied to the displayed
    # spectrum. Removes narrowband SDR birdies / RFI that don't divide out of
    # the baseline cleanly, while leaving the broad hydrogen line (hundreds of
    # bins wide) untouched. Forced odd; 0 or 1 disables it.
    spur_median_bins: int = Field(default=5, ge=0, le=51)

    @property
    def integration_frames(self) -> int:
        """Number of published spectra (at publish_rate_hz) inside one EMA window.

        Preserved as a derived field so the existing JSON frame shape and
        `/api/spectrum/status` payload continue to carry the same key.
        """
        return max(1, round(self.integration_seconds * self.publish_rate_hz))


class GeneralConfig(BaseModel):
    log_level: str = "INFO"


class AppConfig(BaseModel):
    general: GeneralConfig = Field(default_factory=GeneralConfig)
    roboclaw: RoboClawConfig = Field(default_factory=RoboClawConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    mount: MountConfig = Field(default_factory=MountConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    observer: ObserverConfig = Field(default_factory=ObserverConfig)
    camera: CameraConfig = Field(default_factory=CameraConfig)
    sdr: SDRConfig = Field(default_factory=SDRConfig)


_ENV_VAR_RE = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}")


def _expand_env_vars(text: str) -> str:
    def _expand_line(line: str) -> str:
        if line.lstrip().startswith("#"):
            return line
        return _ENV_VAR_RE.sub(replace, line)

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        default = match.group(2)
        value = os.environ.get(name)
        if value is not None:
            return value
        if default is not None:
            return default
        msg = f"Config references ${{{name}}} but the environment variable is unset and no `:-default` was provided"
        print(msg, flush=True)
        raise KeyError(msg)
    return "\n".join(_expand_line(line) for line in text.splitlines())


def load_config(path: Path | str = "config.toml") -> AppConfig:
    path = Path(path)
    if not path.exists():
        example = path.with_name("config.example.toml")
        hint = f" Copy `{example.name}` to `{path.name}` and edit it." if example.exists() else ""
        raise FileNotFoundError(f"Config file not found: {path}.{hint}")
    text = path.read_text(encoding="utf-8")
    expanded = _expand_env_vars(text)
    raw = tomllib.loads(expanded)
    return AppConfig.model_validate(raw)

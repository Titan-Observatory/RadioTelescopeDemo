from __future__ import annotations

import os
import re
import tomllib
from pathlib import Path

from pydantic import BaseModel, Field


class GeneralConfig(BaseModel):
    log_level: str = "INFO"


class ServerConfig(BaseModel):
    host: str = "0.0.0.0"
    port: int = 8000
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    allowed_clients: list[str] = Field(default_factory=lambda: ["10.0.27.1", "10.0.27.2"])
    trusted_proxies: list[str] = Field(default_factory=lambda: ["127.0.0.1", "::1"])
    lan_only: bool = False

    @property
    def public_exposure(self) -> bool:
        return not self.lan_only and self.host in {"0.0.0.0", "::"}


class RateLimitConfig(BaseModel):
    enabled: bool = True
    queue_join_per_minute: int = Field(default=10, ge=1)
    feedback_per_minute: int = Field(default=5, ge=1)
    events_per_minute: int = Field(default=120, ge=1)
    camera_stream_per_minute: int = Field(default=12, ge=1)
    websocket_connect_per_minute: int = Field(default=30, ge=1)
    motion_per_minute: int = Field(default=20, ge=1)


class QueueConfig(BaseModel):
    enabled: bool = True
    max_session_seconds: int = Field(default=600, ge=10)
    idle_timeout_seconds: int = Field(default=60, ge=5)
    max_queue_size: int = Field(default=100, ge=1)
    cookie_secret: str = Field(default="change-me-in-config", min_length=8)
    cookie_name: str = "rt_session"
    max_sessions_per_ip: int = Field(default=3, ge=1)
    join_cooldown_seconds: int = Field(default=5, ge=0)


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


class AppConfig(BaseModel):
    general: GeneralConfig = Field(default_factory=GeneralConfig)
    server: ServerConfig = Field(default_factory=ServerConfig)
    rate_limit: RateLimitConfig = Field(default_factory=RateLimitConfig)
    queue: QueueConfig = Field(default_factory=QueueConfig)
    turnstile: TurnstileConfig = Field(default_factory=TurnstileConfig)
    auth: AuthConfig = Field(default_factory=AuthConfig)

    # URL of the rt-hardware service to proxy to. Use the Docker service name
    # in compose deployments; an IP/host in bare-metal LAN deployments.
    hardware_url: str = "http://hardware:8001"

    # Loki push endpoint. Empty string disables all Loki pushes.
    loki_url: str = ""

    gtag_id: str = ""
    gtag_debug: bool = False

    feedback_log_path: str = "feedback.jsonl"
    feedback_log_max_bytes: int = Field(default=1_048_576, ge=1)
    events_log_path: str = "events.jsonl"
    events_log_max_bytes: int = Field(default=5_242_880, ge=1)
    motion_log_path: str = "motion.jsonl"
    motion_log_max_bytes: int = Field(default=5_242_880, ge=1)
    telescope_status_path: str = "telescope_status.json"
    auth_log_path: str = "auth_events.jsonl"
    auth_log_max_bytes: int = Field(default=5_242_880, ge=1)


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
    # Allow HARDWARE_URL env var to override the toml setting — convenient for
    # Docker Compose where the toml ships read-only but the URL depends on the
    # deployment.
    if "HARDWARE_URL" in os.environ:
        raw["hardware_url"] = os.environ["HARDWARE_URL"]
    if "LOKI_URL" in os.environ:
        raw["loki_url"] = os.environ["LOKI_URL"]
    if "GTAG_ID" in os.environ:
        raw["gtag_id"] = os.environ["GTAG_ID"]
    if "GTAG_DEBUG" in os.environ:
        raw["gtag_debug"] = _parse_bool_env("GTAG_DEBUG", os.environ["GTAG_DEBUG"])
    return AppConfig.model_validate(raw)


def _parse_bool_env(name: str, value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be a boolean value")


def public_exposure_errors(cfg: AppConfig) -> list[str]:
    """Return config problems that make an internet-facing bind unsafe."""
    if not cfg.server.public_exposure:
        return []

    errors: list[str] = []
    if not cfg.queue.enabled:
        errors.append("queue.enabled must be true for public exposure")
    if _placeholder_secret(cfg.queue.cookie_secret):
        errors.append("queue.cookie_secret must be a generated production secret")
    if not cfg.auth.enabled:
        if not cfg.turnstile.enabled:
            errors.append("turnstile.enabled must be true for public queue joins")
        if not cfg.turnstile.site_key or _turnstile_test_key(cfg.turnstile.site_key):
            errors.append("turnstile.site_key must be a production site key")
        if not cfg.turnstile.secret_key or _turnstile_test_key(cfg.turnstile.secret_key):
            errors.append("turnstile.secret_key must be a production secret key")
    if cfg.server.cors_origins == ["*"] or "*" in cfg.server.cors_origins:
        errors.append("server.cors_origins must list the production origin, not '*'")
    if not cfg.server.trusted_proxies:
        errors.append("server.trusted_proxies must list the immediate reverse proxy IPs")
    if cfg.auth.enabled and _placeholder_secret(cfg.auth.secret_key):
        errors.append("auth.secret_key must be a generated production secret when auth is enabled")
    return errors


def _placeholder_secret(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith("change-me") or "change-me" in lowered


def _turnstile_test_key(value: str) -> bool:
    return value.startswith("1x00000000000000000000")

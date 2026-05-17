"""Remote hardware adapters for gateway-client mode.

When `hardware.mode = "gateway-client"`, this process runs the FastAPI app
and web UI but the motors live on another box ("gateway-server") on the LAN.
``RemoteRoboClawClient`` implements the same ``RoboClawClient`` protocol the
local serial driver does so the services don't know the difference.

The SDR no longer needs a remote adapter — the Pi runs its own
``SpectrumService`` and the host subscribes to ``/ws/spectrum`` via
``SpectrumBridge`` instead. See plan ``swift-wobbling-hammock.md``.

No auth: this is intended for a closed, hardwired LAN. See plan
``make-it-a-hardware-precious-swan.md`` for context.
"""
from __future__ import annotations

import logging

import httpx

from radiotelescope.config import HardwareConfig
from radiotelescope.models.state import (
    CommandResult,
    ConnectionStatus,
    RoboClawTelemetry,
)

logger = logging.getLogger(__name__)


# ─── RoboClaw ───────────────────────────────────────────────────────────────

# We keep snapshots cheap: the host's `RoboClawService` polls at 5 Hz, so
# each tick does one HTTP GET to /api/roboclaw/status. The latest snapshot's
# `connection` block backs the `connection` property between polls.
_DEFAULT_CONNECTION = ConnectionStatus(
    mode="error",
    port="<remote>",
    baudrate=0,
    address=0,
    connected=False,
    message="No telemetry received from gateway yet",
)


class RemoteRoboClawClient:
    """HTTP-backed implementation of the `RoboClawClient` protocol."""

    def __init__(self, hardware_cfg: HardwareConfig, timeout_s: float = 5.0) -> None:
        self._cfg = hardware_cfg
        self._http = httpx.Client(base_url=hardware_cfg.base_url, timeout=timeout_s)
        self._connection: ConnectionStatus = _DEFAULT_CONNECTION

    @property
    def connection(self) -> ConnectionStatus:
        return self._connection

    def execute(
        self,
        command_id: str,
        args: dict[str, int | bool] | None = None,
    ) -> CommandResult:
        try:
            r = self._http.post(
                f"/api/roboclaw/commands/{command_id}",
                json={"args": args or {}},
            )
        except httpx.HTTPError as exc:
            return CommandResult(command_id=command_id, ok=False, error=f"gateway unreachable: {exc}")
        if r.status_code >= 400:
            # FastAPI returns {"detail": "..."} on HTTPException; surface that.
            detail = _try_detail(r)
            return CommandResult(command_id=command_id, ok=False, error=detail or r.text)
        try:
            return CommandResult.model_validate(r.json())
        except Exception as exc:
            return CommandResult(command_id=command_id, ok=False, error=f"bad gateway response: {exc}")

    def snapshot(self) -> RoboClawTelemetry:
        try:
            r = self._http.get("/api/roboclaw/status")
            r.raise_for_status()
            snap = RoboClawTelemetry.model_validate(r.json())
            self._connection = snap.connection
            return snap
        except Exception as exc:
            self._connection = ConnectionStatus(
                **{**_DEFAULT_CONNECTION.model_dump(), "message": f"gateway poll failed: {exc}"}
            )
            # Return a minimal stub so the service loop keeps spinning rather than
            # crashing — the connection.mode='error' surfaces clearly in the UI.
            import time as _time
            return RoboClawTelemetry(connection=self._connection, timestamp=_time.time())

    def stop_all(self) -> dict[str, CommandResult]:
        try:
            r = self._http.post("/api/roboclaw/stop")
            r.raise_for_status()
            raw = r.json()
            return {k: CommandResult.model_validate(v) for k, v in raw.items()}
        except Exception as exc:
            err = CommandResult(command_id="stop_all", ok=False, error=f"gateway stop failed: {exc}")
            return {"m1": err, "m2": err}

    def close(self) -> None:
        try:
            self._http.close()
        except Exception:
            pass


def _try_detail(r: httpx.Response) -> str | None:
    try:
        body = r.json()
    except Exception:
        return None
    if isinstance(body, dict):
        detail = body.get("detail")
        return detail if isinstance(detail, str) else None
    return None


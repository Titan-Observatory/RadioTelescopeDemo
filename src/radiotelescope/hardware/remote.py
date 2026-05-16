"""Remote hardware adapters for gateway-client mode.

When `hardware.mode = "gateway-client"`, this process runs the full FastAPI
app, DSP pipeline, and web UI, but the motors and the SDR live on another box
("gateway-server") on the LAN. The two classes here implement the same
interfaces as the local hardware (`RoboClawClient` protocol, `SDRReceiver`)
so the services and routes don't know the difference.

No auth: this is intended for a closed, hardwired LAN. See plan
`make-it-a-hardware-precious-swan.md` for context.
"""
from __future__ import annotations

import asyncio
import logging
from typing import AsyncIterator

import httpx
import numpy as np

from radiotelescope.config import HardwareConfig, SDRConfig
from radiotelescope.models.state import (
    CommandResult,
    ConnectionStatus,
    LnaStatus,
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


# ─── SDR ────────────────────────────────────────────────────────────────────


class RemoteSDRReceiver:
    """Mirrors `SDRReceiver`: opens a WS to the gateway's /ws/iq, yields chunks.

    The wire format is raw `complex64` I/Q samples (8 bytes/sample,
    ``8 * fft_size`` bytes per frame), matching what the gateway-server's
    Airspy stream produces. No conversion is needed beyond a ``frombuffer``.
    """

    def __init__(self, hardware_cfg: HardwareConfig, sdr_cfg: SDRConfig) -> None:
        self._hw = hardware_cfg
        self._cfg = sdr_cfg
        self._ws = None  # websockets.WebSocketClientProtocol
        self.mode: str = "uninitialised"
        self._lna_status = LnaStatus(state="unknown", label="Unknown", detail="Gateway not connected yet")

    @property
    def config(self) -> SDRConfig:
        return self._cfg

    @property
    def lna_status(self) -> LnaStatus:
        return self._lna_status

    async def open(self) -> None:
        if not self._cfg.enabled:
            self.mode = "disabled"
            self._lna_status = LnaStatus(state="off", label="Off", detail="SDR disabled")
            return
        try:
            import websockets  # local import keeps the dep optional at module load
            self._ws = await websockets.connect(
                f"{self._hw.ws_base_url}/ws/iq",
                max_size=None,  # IQ frames are larger than the 1 MiB default
                ping_interval=20,
                ping_timeout=20,
            )
            self.mode = "remote"
            await self._refresh_lna_status()
            logger.info("Connected to gateway IQ stream at %s/ws/iq", self._hw.ws_base_url)
        except Exception as exc:
            logger.warning("Could not open gateway IQ stream (%s); spectrum will be empty", exc)
            self._ws = None
            self.mode = "disconnected"
            self._lna_status = LnaStatus(state="fault", label="Issue", detail=f"Gateway IQ disconnected: {exc}")

    async def close(self) -> None:
        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

    async def stream(self) -> AsyncIterator[np.ndarray]:
        if self._ws is None:
            return
        try:
            async for message in self._ws:
                if isinstance(message, str):
                    continue
                yield _bytes_to_complex64(message)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Gateway IQ stream dropped: %s", exc)
            self._ws = None
            self.mode = "disconnected"
            self._lna_status = LnaStatus(state="fault", label="Issue", detail=f"Gateway IQ stream dropped: {exc}")

    async def _refresh_lna_status(self) -> None:
        try:
            async with httpx.AsyncClient(base_url=self._hw.base_url, timeout=5.0) as client:
                r = await client.get("/api/iq/status")
                r.raise_for_status()
                raw = r.json().get("lna")
            self._lna_status = LnaStatus.model_validate(raw)
        except Exception as exc:
            self._lna_status = LnaStatus(state="unknown", label="Unknown", detail=f"Gateway LNA status unavailable: {exc}")


def _bytes_to_complex64(raw: bytes) -> np.ndarray:
    """Decode the gateway IQ wire format (raw little-endian complex64)."""
    return np.frombuffer(raw, dtype=np.complex64)

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

import katpoint

from rt_hardware.config import MountConfig
from rt_hardware.hardware.roboclaw import RoboClawClient
from rt_hardware.models.state import PollStats, RoboClawTelemetry
from rt_hardware.pointing import altaz_to_radec
from rt_hardware.services._pubsub import Broadcaster
from rt_hardware.services.geometry import encoder_counts_to_altitude

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PositionTarget:
    m1: int | None = None
    m2: int | None = None
    m1_stopped: bool = False
    m2_stopped: bool = False
    m1_last_delta: int | None = None
    m2_last_delta: int | None = None


class RoboClawService:
    def __init__(
        self,
        client: RoboClawClient,
        update_rate_hz: int,
        mount_cfg: MountConfig | None = None,
        antenna: katpoint.Antenna | None = None,
    ) -> None:
        self._client = client
        self._rate = update_rate_hz
        self._mount_cfg = mount_cfg
        self._antenna = antenna
        self._broadcaster: Broadcaster[RoboClawTelemetry] = Broadcaster()
        self._task: asyncio.Task | None = None
        self._latest: RoboClawTelemetry | None = None
        self._tick_times: deque[float] = deque(maxlen=20)
        self._stored_m1_qpps: int | None = None
        self._stored_m2_qpps: int | None = None
        self._position_target: PositionTarget | None = None
        self._jog_sequences: dict[str, int] = {}
        self._active_jog: tuple[str, int] | None = None
        self._jog_watchdog_task: asyncio.Task | None = None
        self._io_lock = asyncio.Lock()

    @property
    def client(self) -> RoboClawClient:
        return self._client

    @property
    def latest(self) -> RoboClawTelemetry:
        if self._latest is None:
            self._latest = self._client.snapshot()
        return self._latest

    async def start(self) -> None:
        await self.refresh_stored_qpps()
        self._task = asyncio.create_task(self._poll_loop())
        logger.info("RoboClaw telemetry service started at %d Hz", self._rate)

    @property
    def stored_qpps(self) -> tuple[int | None, int | None]:
        """(m1, m2) velocity-PID QPPS as stored on the controller, or None if unread."""
        return (self._stored_m1_qpps, self._stored_m2_qpps)

    def set_position_target(self, *, m1: int | None = None, m2: int | None = None) -> None:
        """Track the active position command so polling can stop it on arrival."""
        if m1 is None and m2 is None:
            self._position_target = None
            return
        self._position_target = PositionTarget(m1=m1, m2=m2)

    async def execute(self, command_id: str, args: dict[str, int | bool] | None = None):
        async with self._io_lock:
            return await asyncio.to_thread(self._client.execute, command_id, args or {})

    async def stop_all(self):
        async with self._io_lock:
            return await asyncio.to_thread(self._client.stop_all)

    async def snapshot(self) -> RoboClawTelemetry:
        async with self._io_lock:
            return await asyncio.to_thread(self._client.snapshot)

    def accept_jog_sequence(self, token: str, seq: int) -> bool:
        """Record a jog sequence if it is newer than any prior packet."""
        latest = self._jog_sequences.get(token, -1)
        if seq <= latest:
            return False
        if token not in self._jog_sequences and len(self._jog_sequences) >= 256:
            self._jog_sequences.pop(next(iter(self._jog_sequences)))
        self._jog_sequences[token] = seq
        return True

    def is_current_jog_sequence(self, token: str, seq: int) -> bool:
        return self._jog_sequences.get(token) == seq

    def arm_jog_watchdog(self, token: str, seq: int, timeout_s: float) -> None:
        self._active_jog = (token, seq)
        if self._jog_watchdog_task is not None:
            self._jog_watchdog_task.cancel()
        self._jog_watchdog_task = asyncio.create_task(self._expire_jog_after(token, seq, timeout_s))

    def clear_jog_watchdog(self, token: str, seq: int) -> None:
        if self._active_jog is not None and self._active_jog[0] == token and self._active_jog[1] <= seq:
            self._active_jog = None
        if self._jog_watchdog_task is not None and self._active_jog is None:
            self._jog_watchdog_task.cancel()
            self._jog_watchdog_task = None

    def can_stop_active_jog(self, token: str, seq: int) -> bool:
        return self._active_jog is not None and self._active_jog[0] == token and self._active_jog[1] <= seq

    @property
    def has_active_jog(self) -> bool:
        """True while a jog watchdog is armed for any token."""
        return self._active_jog is not None

    async def _expire_jog_after(self, token: str, seq: int, timeout_s: float) -> None:
        try:
            await asyncio.sleep(timeout_s)
            if self._active_jog != (token, seq):
                return
            self._active_jog = None
            result = await self.stop_all()
            failed = [item.error or item.command_id for item in result.values() if not item.ok]
            if failed:
                logger.warning("Failed to stop expired jog %s/%s: %s", token, seq, "; ".join(failed))
            else:
                logger.warning("Stopped motors after jog heartbeat timeout token=%s seq=%s", token, seq)
        except asyncio.CancelledError:
            pass

    async def refresh_stored_qpps(self) -> None:
        """Read each axis's velocity-PID QPPS from the controller and cache it."""
        try:
            m1 = await self.execute("read_m1_velocity_pid", {})
            m2 = await self.execute("read_m2_velocity_pid", {})
        except Exception as exc:
            logger.warning("Could not read stored QPPS from controller: %s", exc)
            return
        if m1.ok:
            self._stored_m1_qpps = int(m1.response.get("qpps")) if m1.response.get("qpps") is not None else None
        if m2.ok:
            self._stored_m2_qpps = int(m2.response.get("qpps")) if m2.response.get("qpps") is not None else None
        logger.info("Stored QPPS read from controller: m1=%s m2=%s", self._stored_m1_qpps, self._stored_m2_qpps)

    async def stop(self) -> None:
        if self._jog_watchdog_task is not None:
            self._jog_watchdog_task.cancel()
            try:
                await self._jog_watchdog_task
            except asyncio.CancelledError:
                pass
            self._jog_watchdog_task = None
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._client.close()
        logger.info("RoboClaw telemetry service stopped")

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[RoboClawTelemetry]:
        q = self._broadcaster.subscribe(maxsize)
        if self._latest is not None:
            q.put_nowait(self._latest)
        return q

    def unsubscribe(self, q: asyncio.Queue[RoboClawTelemetry]) -> None:
        self._broadcaster.unsubscribe(q)

    async def run_blocking(self, func: Callable[[], RoboClawTelemetry]) -> RoboClawTelemetry:
        return await asyncio.to_thread(func)

    def _poll_stats(self) -> PollStats:
        now = time.monotonic()
        actual_hz: float | None = None
        last_age: float | None = None
        if len(self._tick_times) >= 2:
            span = self._tick_times[-1] - self._tick_times[0]
            if span > 0:
                actual_hz = (len(self._tick_times) - 1) / span
        if self._tick_times:
            last_age = max(0.0, now - self._tick_times[-1])
        return PollStats(target_hz=float(self._rate), actual_hz=actual_hz, last_tick_age_s=last_age)

    async def refresh(self) -> RoboClawTelemetry:
        """Take a fresh hardware snapshot, update cached state, and notify subscribers."""
        snap = await self.snapshot()
        self._tick_times.append(time.monotonic())
        updates: dict = {"poll": self._poll_stats()}

        if self._mount_cfg is not None:
            m1 = snap.motors.get("m1")
            m2 = snap.motors.get("m2")
            cfg = self._mount_cfg
            az = (
                (m1.encoder - cfg.az_zero_count) / cfg.az_counts_per_degree
                if m1 and m1.encoder is not None
                else None
            )
            alt = (
                encoder_counts_to_altitude(m2.encoder, cfg)
                if m2 and m2.encoder is not None
                else None
            )
            updates["azimuth_deg"] = az
            updates["altitude_deg"] = alt

            if self._antenna is not None and alt is not None and az is not None:
                try:
                    ra, dec = altaz_to_radec(alt, az, self._antenna)
                    updates["ra_deg"] = ra
                    updates["dec_deg"] = dec
                except Exception:
                    logger.debug("altaz_to_radec failed", exc_info=True)

        self._latest = snap.model_copy(update=updates) if updates else snap
        await self._stop_if_position_target_reached(self._latest)
        self._broadcaster.publish(self._latest)
        return self._latest

    async def _stop_if_position_target_reached(self, snap: RoboClawTelemetry) -> None:
        target = self._position_target
        if target is None:
            return
        tolerance = self._mount_cfg.goto_arrival_tolerance_counts if self._mount_cfg is not None else 1
        m1_delta = _motor_target_delta(snap, "m1", target.m1)
        m2_delta = _motor_target_delta(snap, "m2", target.m2)
        reached_m1 = not target.m1_stopped and _axis_target_reached(m1_delta, target.m1_last_delta, tolerance)
        reached_m2 = not target.m2_stopped and _axis_target_reached(m2_delta, target.m2_last_delta, tolerance)
        if not reached_m1 and not reached_m2:
            self._position_target = PositionTarget(
                m1=target.m1,
                m2=target.m2,
                m1_stopped=target.m1_stopped,
                m2_stopped=target.m2_stopped,
                m1_last_delta=m1_delta if not target.m1_stopped else target.m1_last_delta,
                m2_last_delta=m2_delta if not target.m2_stopped else target.m2_last_delta,
            )
            return

        failed: list[str] = []
        if reached_m1:
            result = await self.execute("forward_m1", {"speed": 0})
            if not result.ok:
                failed.append(result.error or result.command_id)
        if reached_m2:
            result = await self.execute("forward_m2", {"speed": 0})
            if not result.ok:
                failed.append(result.error or result.command_id)
        if failed:
            logger.warning("Failed to stop reached target axis for %s: %s", target, "; ".join(failed))
            return

        target = PositionTarget(
            m1=target.m1,
            m2=target.m2,
            m1_stopped=target.m1_stopped or reached_m1,
            m2_stopped=target.m2_stopped or reached_m2,
            m1_last_delta=m1_delta,
            m2_last_delta=m2_delta,
        )
        if (target.m1 is None or target.m1_stopped) and (target.m2 is None or target.m2_stopped):
            self._position_target = None
        else:
            self._position_target = target
        logger.info("Stopped reached target axis m1=%s m2=%s", reached_m1, reached_m2)

    async def _poll_loop(self) -> None:
        interval = 1.0 / self._rate
        while True:
            await self.refresh()
            await asyncio.sleep(interval)


def _motor_target_delta(snap: RoboClawTelemetry, motor_id: str, encoder_target: int | None) -> int | None:
    if encoder_target is None:
        return None
    motor = snap.motors.get(motor_id)
    if motor is None or motor.encoder is None:
        return None
    return motor.encoder - encoder_target


def _axis_target_reached(delta: int | None, last_delta: int | None, tolerance: int) -> bool:
    if delta is None:
        return False
    if abs(delta) <= tolerance:
        return True
    return last_delta is not None and (last_delta < 0 < delta or last_delta > 0 > delta)

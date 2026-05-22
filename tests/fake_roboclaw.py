"""In-memory RoboClaw stand-in for tests.

This is the former `SimulatedRoboClaw` from production code. It lives in tests/
because production ships only the real serial driver plus a NullRoboClaw stub —
no fake hardware path is exposed to end users.
"""

from __future__ import annotations

import random
import time
from typing import Any, Literal

from radiotelescope.config import RoboClawConfig
from radiotelescope.hardware.roboclaw import (
    CommandSpec,
    ResponseType,
    _get_spec,
    _response_specs,
    _validate_args,
    build_snapshot,
)
from radiotelescope.models.state import CommandResult, ConnectionStatus, RoboClawTelemetry


class SimulatedRoboClaw:
    def __init__(self, config: RoboClawConfig, mode: Literal["disconnected", "error"] = "disconnected", message: str | None = None) -> None:
        self._cfg = config
        self._connection = ConnectionStatus(
            mode=mode,
            port=config.port,
            baudrate=config.baudrate,
            address=config.address,
            connected=False,
            message=message or "Using simulated RoboClaw (tests only)",
        )
        self._started = time.time()
        self._firmware = "Simulated RoboClaw 4.1.34"
        self._main_battery_tenths = 124
        self._logic_battery_tenths = 50
        self._temperature_tenths = 311
        self._temperature_2_tenths = 305
        self._status = 0
        self._encoders = {"m1": 0, "m2": 0}
        self._speeds = {"m1": 0, "m2": 0}
        self._commands = {"m1": 0, "m2": 0}
        self._pwms = {"m1": 0, "m2": 0}

    @property
    def connection(self) -> ConnectionStatus:
        return self._connection

    def execute(self, command_id: str, args: dict[str, int | bool] | None = None) -> CommandResult:
        spec = _get_spec(command_id)
        values = _validate_args(spec, args or {})
        self._apply_simulated_command(spec, values)
        if command_id in ("read_encoder_m1", "read_encoder_m2", "read_encoders"):
            self._tick()
        return CommandResult(command_id=command_id, ok=True, response=self._simulated_response(spec))

    def snapshot(self) -> RoboClawTelemetry:
        self._tick()
        return build_snapshot(self, self.connection)

    def stop_all(self) -> dict[str, CommandResult]:
        return {
            "forward_m1": self.execute("forward_m1", {"speed": 0}),
            "forward_m2": self.execute("forward_m2", {"speed": 0}),
        }

    def close(self) -> None:
        return None

    def _tick(self) -> None:
        elapsed = time.time() - self._started
        for channel in ("m1", "m2"):
            self._encoders[channel] = max(0, self._encoders[channel] + int(self._speeds[channel] / 50))
        self._main_battery_tenths = 124 + round(random.uniform(-1, 1))
        self._temperature_tenths = 310 + int((elapsed % 20) / 2)

    def _apply_simulated_command(self, spec: CommandSpec, args: dict[str, int | bool]) -> None:
        if spec.id == "reset_encoders":
            self._encoders = {"m1": 0, "m2": 0}
        elif spec.id == "set_encoder_m1":
            self._encoders["m1"] = int(args["value"])
        elif spec.id == "set_encoder_m2":
            self._encoders["m2"] = int(args["value"])
        elif spec.id in ("forward_m1", "backward_m1"):
            value = int(args["speed"])
            sign = -1 if spec.id.startswith("backward") else 1
            self._commands["m1"] = sign * value
            self._speeds["m1"] = sign * value * 100
            self._pwms["m1"] = sign * round(value * 32767 / 127)
        elif spec.id in ("forward_m2", "backward_m2"):
            value = int(args["speed"])
            sign = -1 if spec.id.startswith("backward") else 1
            self._commands["m2"] = sign * value
            self._speeds["m2"] = sign * value * 100
            self._pwms["m2"] = sign * round(value * 32767 / 127)
        elif spec.id == "duty_m1":
            self._set_duty("m1", int(args["duty"]))
        elif spec.id == "duty_m2":
            self._set_duty("m2", int(args["duty"]))
        elif spec.id == "duty_m1m2":
            self._set_duty("m1", int(args["m1_duty"]))
            self._set_duty("m2", int(args["m2_duty"]))
        elif spec.id == "speed_m1":
            self._set_speed("m1", int(args["speed"]))
        elif spec.id == "speed_m2":
            self._set_speed("m2", int(args["speed"]))
        elif spec.id == "speed_m1m2":
            self._set_speed("m1", int(args["m1_speed"]))
            self._set_speed("m2", int(args["m2_speed"]))
        elif spec.id == "speed_accel_decel_position_m1":
            self._move_to_position("m1", int(args["position"]), int(args["speed"]))
        elif spec.id == "speed_accel_decel_position_m2":
            self._move_to_position("m2", int(args["position"]), int(args["speed"]))
        elif spec.id == "speed_accel_decel_position_m1m2":
            self._move_to_position("m1", int(args["m1_position"]), int(args["m1_speed"]))
            self._move_to_position("m2", int(args["m2_position"]), int(args["m2_speed"]))

    def _set_duty(self, channel: Literal["m1", "m2"], duty: int) -> None:
        self._pwms[channel] = duty
        self._commands[channel] = duty
        self._speeds[channel] = round(duty / 32767 * 12700)

    def _set_speed(self, channel: Literal["m1", "m2"], speed: int) -> None:
        self._speeds[channel] = speed
        self._commands[channel] = speed
        self._pwms[channel] = max(-32767, min(32767, round(speed / 12700 * 32767)))

    def _move_to_position(self, channel: Literal["m1", "m2"], position: int, speed: int) -> None:
        current = self._encoders[channel]
        direction = 1 if position >= current else -1
        self._encoders[channel] = position
        self._speeds[channel] = 0
        self._commands[channel] = position
        self._pwms[channel] = direction * max(0, min(32767, round(speed / 12700 * 32767)))

    def _simulated_response(self, spec: CommandSpec) -> dict[str, Any]:
        data: dict[str, Any] = {}
        for response in _response_specs(spec):
            data[response.name] = self._simulated_value(response.name, response.type, response.scale, response.precision)
        return data or {"ack": True}

    def _simulated_value(self, name: str, type_: ResponseType, scale: float, precision: int | None) -> Any:
        raw: Any
        if type_ == "string":
            raw = self._firmware
        elif name in ("voltage_v", "main_battery_v"):
            raw = self._main_battery_tenths
        elif name == "temperature_c":
            raw = self._temperature_tenths
        elif name in ("status", "settings", "config"):
            raw = self._status
        elif name in ("m1", "m1_encoder", "encoder"):
            raw = self._encoders["m1"]
        elif name == "m2" or name == "m2_encoder":
            raw = self._encoders["m2"]
        elif "current" in name:
            raw = abs(self._pwms["m1" if name.startswith("m1") else "m2"]) // 600
        elif "pwm" in name:
            raw = self._pwms["m1" if name.startswith("m1") else "m2"]
        elif "speed" in name:
            raw = self._speeds["m1" if name.startswith("m1") else "m2"]
        elif "error" in name:
            raw = 0
        elif "mode" in name:
            raw = 0
        else:
            raw = 0
        if scale != 1.0 and isinstance(raw, int):
            value = raw * scale
            return round(value, precision) if precision is not None else value
        return raw

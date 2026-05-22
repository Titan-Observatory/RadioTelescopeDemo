from __future__ import annotations

import logging
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from radiotelescope.config import RoboClawConfig
from radiotelescope.hardware.host_stats import read_host_stats
from radiotelescope.models.state import CommandArg, CommandInfo, CommandResult, ConnectionStatus, RoboClawTelemetry

logger = logging.getLogger(__name__)

ACK = b"\xff"

ValueType = Literal["u8", "u16", "s16", "u32", "s32", "bool"]
ResponseType = Literal["ack", "u8", "u16", "s16", "u32", "s32", "string"]


class RoboClawError(RuntimeError):
    pass


@dataclass(frozen=True)
class ArgSpec:
    name: str
    type: ValueType
    label: str
    min: int | None = None
    max: int | None = None
    default: int | bool | None = None

    def to_model(self) -> CommandArg:
        return CommandArg(
            name=self.name,
            type=self.type,
            label=self.label,
            min=self.min,
            max=self.max,
            default=self.default,
        )


@dataclass(frozen=True)
class ResponseSpec:
    name: str
    type: ResponseType
    scale: float = 1.0
    precision: int | None = None


@dataclass(frozen=True)
class CommandSpec:
    id: str
    name: str
    group: str
    description: str
    command: int
    kind: Literal["read", "write", "motion", "config"]
    args: tuple[ArgSpec, ...] = ()
    response: tuple[ResponseSpec, ...] = ()
    dangerous: bool = False

    def to_model(self) -> CommandInfo:
        return CommandInfo(
            id=self.id,
            name=self.name,
            group=self.group,
            description=self.description,
            command=self.command,
            kind=self.kind,
            dangerous=self.dangerous,
            args=[arg.to_model() for arg in self.args],
        )


class RoboClawClient(Protocol):
    @property
    def connection(self) -> ConnectionStatus:
        ...

    def execute(self, command_id: str, args: dict[str, int | bool] | None = None) -> CommandResult:
        ...

    def snapshot(self) -> RoboClawTelemetry:
        ...

    def stop_all(self) -> dict[str, CommandResult]:
        ...

    def close(self) -> None:
        ...


def _arg(name: str, type_: ValueType, label: str, min_: int, max_: int, default: int | bool = 0) -> ArgSpec:
    return ArgSpec(name=name, type=type_, label=label, min=min_, max=max_, default=default)


def _resp(name: str, type_: ResponseType, scale: float = 1.0, precision: int | None = None) -> ResponseSpec:
    return ResponseSpec(name=name, type=type_, scale=scale, precision=precision)


COMMANDS: dict[str, CommandSpec] = {
    "forward_m1": CommandSpec("forward_m1", "Forward M1", "Motion", "Drive M1 forward, speed 0-127.", 0, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "backward_m1": CommandSpec("backward_m1", "Backward M1", "Motion", "Drive M1 backward, speed 0-127.", 1, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "forward_m2": CommandSpec("forward_m2", "Forward M2", "Motion", "Drive M2 forward, speed 0-127.", 4, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "backward_m2": CommandSpec("backward_m2", "Backward M2", "Motion", "Drive M2 backward, speed 0-127.", 5, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "forward_backward_m1": CommandSpec("forward_backward_m1", "Forward/Backward M1", "Motion", "7-bit bidirectional M1 control. 64 stops.", 6, "motion", (_arg("value", "u8", "Value", 0, 127, 64),)),
    "forward_backward_m2": CommandSpec("forward_backward_m2", "Forward/Backward M2", "Motion", "7-bit bidirectional M2 control. 64 stops.", 7, "motion", (_arg("value", "u8", "Value", 0, 127, 64),)),
    "mixed_forward": CommandSpec("mixed_forward", "Mixed Forward", "Mixed", "Drive mixed-mode forward.", 8, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "mixed_backward": CommandSpec("mixed_backward", "Mixed Backward", "Mixed", "Drive mixed-mode backward.", 9, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "mixed_turn_right": CommandSpec("mixed_turn_right", "Mixed Turn Right", "Mixed", "Turn right in mixed mode.", 10, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "mixed_turn_left": CommandSpec("mixed_turn_left", "Mixed Turn Left", "Mixed", "Turn left in mixed mode.", 11, "motion", (_arg("speed", "u8", "Speed", 0, 127, 0),)),
    "mixed_forward_backward": CommandSpec("mixed_forward_backward", "Mixed Forward/Backward", "Mixed", "7-bit mixed forward/backward. 64 stops.", 12, "motion", (_arg("value", "u8", "Value", 0, 127, 64),)),
    "mixed_left_right": CommandSpec("mixed_left_right", "Mixed Left/Right", "Mixed", "7-bit mixed left/right. 64 stops.", 13, "motion", (_arg("value", "u8", "Value", 0, 127, 64),)),
    "set_serial_timeout": CommandSpec("set_serial_timeout", "Set Serial Timeout", "Configuration", "Set serial timeout in 100 ms units.", 14, "config", (_arg("timeout", "u8", "Timeout", 0, 255, 10),), dangerous=True),
    "read_serial_timeout": CommandSpec("read_serial_timeout", "Read Serial Timeout", "Configuration", "Read serial timeout in 100 ms units.", 15, "read", response=(_resp("timeout", "u8"),)),
    "read_encoder_m1": CommandSpec("read_encoder_m1", "Read Encoder M1", "Encoders", "Read M1 encoder count and status.", 16, "read", response=(_resp("encoder", "u32"), _resp("status", "u8"))),
    "read_encoder_m2": CommandSpec("read_encoder_m2", "Read Encoder M2", "Encoders", "Read M2 encoder count and status.", 17, "read", response=(_resp("encoder", "u32"), _resp("status", "u8"))),
    "read_speed_m1": CommandSpec("read_speed_m1", "Read Speed M1", "Encoders", "Read M1 speed in encoder counts per second.", 18, "read", response=(_resp("speed_qpps", "s32"), _resp("status", "u8"))),
    "read_speed_m2": CommandSpec("read_speed_m2", "Read Speed M2", "Encoders", "Read M2 speed in encoder counts per second.", 19, "read", response=(_resp("speed_qpps", "s32"), _resp("status", "u8"))),
    "reset_encoders": CommandSpec("reset_encoders", "Reset Encoders", "Encoders", "Reset both quadrature encoder registers.", 20, "write", dangerous=True),
    "read_firmware": CommandSpec("read_firmware", "Read Firmware", "Status", "Read RoboClaw firmware string.", 21, "read", response=(_resp("firmware", "string"),)),
    "set_encoder_m1": CommandSpec("set_encoder_m1", "Set Encoder M1", "Encoders", "Set M1 quadrature encoder register.", 22, "write", (_arg("value", "u32", "Value", 0, 4_294_967_295, 0),), dangerous=True),
    "set_encoder_m2": CommandSpec("set_encoder_m2", "Set Encoder M2", "Encoders", "Set M2 quadrature encoder register.", 23, "write", (_arg("value", "u32", "Value", 0, 4_294_967_295, 0),), dangerous=True),
    "read_main_battery_voltage": CommandSpec("read_main_battery_voltage", "Read Main Battery", "Power", "Read main battery voltage.", 24, "read", response=(_resp("voltage_v", "u16", 0.1, 1),)),
    "read_logic_battery_voltage": CommandSpec("read_logic_battery_voltage", "Read Logic Battery", "Power", "Read logic battery voltage.", 25, "read", response=(_resp("voltage_v", "u16", 0.1, 1),)),
    "set_min_logic_voltage": CommandSpec("set_min_logic_voltage", "Set Min Logic Voltage", "Configuration", "Set minimum logic voltage in tenths of a volt.", 26, "config", (_arg("voltage_tenths", "u16", "Voltage x10", 0, 65535, 55),), dangerous=True),
    "set_max_logic_voltage": CommandSpec("set_max_logic_voltage", "Set Max Logic Voltage", "Configuration", "Set maximum logic voltage in tenths of a volt.", 27, "config", (_arg("voltage_tenths", "u16", "Voltage x10", 0, 65535, 300),), dangerous=True),
    "set_m1_velocity_pid": CommandSpec("set_m1_velocity_pid", "Set M1 Velocity PID", "PID", "Set M1 velocity PID constants and QPPS.", 28, "config", (_arg("p", "u32", "P", 0, 4_294_967_295, 0), _arg("i", "u32", "I", 0, 4_294_967_295, 0), _arg("d", "u32", "D", 0, 4_294_967_295, 0), _arg("qpps", "u32", "QPPS", 0, 4_294_967_295, 0)), dangerous=True),
    "set_m2_velocity_pid": CommandSpec("set_m2_velocity_pid", "Set M2 Velocity PID", "PID", "Set M2 velocity PID constants and QPPS.", 29, "config", (_arg("p", "u32", "P", 0, 4_294_967_295, 0), _arg("i", "u32", "I", 0, 4_294_967_295, 0), _arg("d", "u32", "D", 0, 4_294_967_295, 0), _arg("qpps", "u32", "QPPS", 0, 4_294_967_295, 0)), dangerous=True),
    "duty_m1": CommandSpec("duty_m1", "Duty M1", "Duty", "Set M1 signed duty, -32767 to 32767.", 32, "motion", (_arg("duty", "s16", "Duty", -32767, 32767, 0),)),
    "duty_m2": CommandSpec("duty_m2", "Duty M2", "Duty", "Set M2 signed duty, -32767 to 32767.", 33, "motion", (_arg("duty", "s16", "Duty", -32767, 32767, 0),)),
    "duty_m1m2": CommandSpec("duty_m1m2", "Duty M1/M2", "Duty", "Set both signed motor duties.", 34, "motion", (_arg("m1_duty", "s16", "M1 duty", -32767, 32767, 0), _arg("m2_duty", "s16", "M2 duty", -32767, 32767, 0))),
    "speed_m1": CommandSpec("speed_m1", "Speed M1", "Speed", "Set M1 signed speed in QPPS.", 35, "motion", (_arg("speed", "s32", "Speed", -2_147_483_648, 2_147_483_647, 0),)),
    "speed_m2": CommandSpec("speed_m2", "Speed M2", "Speed", "Set M2 signed speed in QPPS.", 36, "motion", (_arg("speed", "s32", "Speed", -2_147_483_648, 2_147_483_647, 0),)),
    "speed_m1m2": CommandSpec("speed_m1m2", "Speed M1/M2", "Speed", "Set both signed motor speeds in QPPS.", 37, "motion", (_arg("m1_speed", "s32", "M1 speed", -2_147_483_648, 2_147_483_647, 0), _arg("m2_speed", "s32", "M2 speed", -2_147_483_648, 2_147_483_647, 0))),
    "speed_distance_m1": CommandSpec("speed_distance_m1", "Speed Distance M1", "Positioning", "Run M1 for distance at speed.", 41, "motion", (_arg("speed", "u32", "Speed", 0, 4_294_967_295, 0), _arg("distance", "u32", "Distance", 0, 4_294_967_295, 0), _arg("buffer", "u8", "Buffer", 0, 1, 1))),
    "speed_distance_m2": CommandSpec("speed_distance_m2", "Speed Distance M2", "Positioning", "Run M2 for distance at speed.", 42, "motion", (_arg("speed", "u32", "Speed", 0, 4_294_967_295, 0), _arg("distance", "u32", "Distance", 0, 4_294_967_295, 0), _arg("buffer", "u8", "Buffer", 0, 1, 1))),
    "speed_distance_m1m2": CommandSpec("speed_distance_m1m2", "Speed Distance M1/M2", "Positioning", "Run both motors for distances at speeds.", 43, "motion", (_arg("m1_speed", "u32", "M1 speed", 0, 4_294_967_295, 0), _arg("m1_distance", "u32", "M1 distance", 0, 4_294_967_295, 0), _arg("m2_speed", "u32", "M2 speed", 0, 4_294_967_295, 0), _arg("m2_distance", "u32", "M2 distance", 0, 4_294_967_295, 0), _arg("buffer", "u8", "Buffer", 0, 1, 1))),
    "read_buffers": CommandSpec("read_buffers", "Read Buffers", "Status", "Read M1/M2 command buffer depths.", 47, "read", response=(_resp("m1", "u8"), _resp("m2", "u8"))),
    "read_motor_pwms": CommandSpec("read_motor_pwms", "Read Motor PWMs", "Motors", "Read current motor PWM outputs.", 48, "read", response=(_resp("m1_pwm", "s16"), _resp("m2_pwm", "s16"))),
    "read_motor_currents": CommandSpec("read_motor_currents", "Read Motor Currents", "Motors", "Read motor currents in amps.", 49, "read", response=(_resp("m1_current_a", "s16", 0.01, 2), _resp("m2_current_a", "s16", 0.01, 2))),
    "read_m1_velocity_pid": CommandSpec("read_m1_velocity_pid", "Read M1 Velocity PID", "PID", "Read M1 velocity PID constants.", 55, "read", response=(_resp("p", "u32"), _resp("i", "u32"), _resp("d", "u32"), _resp("qpps", "u32"))),
    "read_m2_velocity_pid": CommandSpec("read_m2_velocity_pid", "Read M2 Velocity PID", "PID", "Read M2 velocity PID constants.", 56, "read", response=(_resp("p", "u32"), _resp("i", "u32"), _resp("d", "u32"), _resp("qpps", "u32"))),
    "set_main_battery_voltage_limits": CommandSpec("set_main_battery_voltage_limits", "Set Main Battery Limits", "Configuration", "Set min/max main battery limits in tenths of a volt.", 57, "config", (_arg("min_tenths", "u16", "Min x10", 0, 65535, 60), _arg("max_tenths", "u16", "Max x10", 0, 65535, 300)), dangerous=True),
    "set_logic_battery_voltage_limits": CommandSpec("set_logic_battery_voltage_limits", "Set Logic Battery Limits", "Configuration", "Set min/max logic battery limits in tenths of a volt.", 58, "config", (_arg("min_tenths", "u16", "Min x10", 0, 65535, 55), _arg("max_tenths", "u16", "Max x10", 0, 65535, 300)), dangerous=True),
    "read_main_battery_voltage_limits": CommandSpec("read_main_battery_voltage_limits", "Read Main Battery Limits", "Configuration", "Read main battery voltage limits.", 59, "read", response=(_resp("min_v", "u16", 0.1, 1), _resp("max_v", "u16", 0.1, 1))),
    "read_logic_battery_voltage_limits": CommandSpec("read_logic_battery_voltage_limits", "Read Logic Battery Limits", "Configuration", "Read logic battery voltage limits.", 60, "read", response=(_resp("min_v", "u16", 0.1, 1), _resp("max_v", "u16", 0.1, 1))),
    "set_m1_position_pid": CommandSpec("set_m1_position_pid", "Set M1 Position PID", "PID", "Set M1 position PID constants.", 61, "config", (_arg("p", "u32", "P", 0, 4_294_967_295, 0), _arg("i", "u32", "I", 0, 4_294_967_295, 0), _arg("d", "u32", "D", 0, 4_294_967_295, 0), _arg("i_max", "u32", "I max", 0, 4_294_967_295, 0), _arg("deadzone", "u32", "Deadzone", 0, 4_294_967_295, 0), _arg("min", "s32", "Min", -2_147_483_648, 2_147_483_647, 0), _arg("max", "s32", "Max", -2_147_483_648, 2_147_483_647, 0)), dangerous=True),
    "set_m2_position_pid": CommandSpec("set_m2_position_pid", "Set M2 Position PID", "PID", "Set M2 position PID constants.", 62, "config", (_arg("p", "u32", "P", 0, 4_294_967_295, 0), _arg("i", "u32", "I", 0, 4_294_967_295, 0), _arg("d", "u32", "D", 0, 4_294_967_295, 0), _arg("i_max", "u32", "I max", 0, 4_294_967_295, 0), _arg("deadzone", "u32", "Deadzone", 0, 4_294_967_295, 0), _arg("min", "s32", "Min", -2_147_483_648, 2_147_483_647, 0), _arg("max", "s32", "Max", -2_147_483_648, 2_147_483_647, 0)), dangerous=True),
    "read_m1_position_pid": CommandSpec("read_m1_position_pid", "Read M1 Position PID", "PID", "Read M1 position PID constants.", 63, "read", response=(_resp("p", "u32"), _resp("i", "u32"), _resp("d", "u32"), _resp("i_max", "u32"), _resp("deadzone", "u32"), _resp("min", "s32"), _resp("max", "s32"))),
    "read_m2_position_pid": CommandSpec("read_m2_position_pid", "Read M2 Position PID", "PID", "Read M2 position PID constants.", 64, "read", response=(_resp("p", "u32"), _resp("i", "u32"), _resp("d", "u32"), _resp("i_max", "u32"), _resp("deadzone", "u32"), _resp("min", "s32"), _resp("max", "s32"))),
    "speed_accel_decel_position_m1": CommandSpec("speed_accel_decel_position_m1", "M1 Position", "Positioning", "Move M1 to absolute encoder position with speed, accel, and decel.", 65, "motion", (_arg("accel", "u32", "Acceleration", 0, 4_294_967_295, 0), _arg("speed", "u32", "Speed", 0, 4_294_967_295, 0), _arg("decel", "u32", "Deceleration", 0, 4_294_967_295, 0), _arg("position", "s32", "Position", -2_147_483_648, 2_147_483_647, 0), _arg("buffer", "u8", "Buffer", 0, 1, 0))),
    "speed_accel_decel_position_m2": CommandSpec("speed_accel_decel_position_m2", "M2 Position", "Positioning", "Move M2 to absolute encoder position with speed, accel, and decel.", 66, "motion", (_arg("accel", "u32", "Acceleration", 0, 4_294_967_295, 0), _arg("speed", "u32", "Speed", 0, 4_294_967_295, 0), _arg("decel", "u32", "Deceleration", 0, 4_294_967_295, 0), _arg("position", "s32", "Position", -2_147_483_648, 2_147_483_647, 0), _arg("buffer", "u8", "Buffer", 0, 1, 0))),
    "speed_accel_decel_position_m1m2": CommandSpec("speed_accel_decel_position_m1m2", "M1/M2 Position", "Positioning", "Move both motors to absolute encoder positions with speed, accel, and decel.", 67, "motion", (_arg("m1_accel", "u32", "M1 acceleration", 0, 4_294_967_295, 0), _arg("m1_speed", "u32", "M1 speed", 0, 4_294_967_295, 0), _arg("m1_decel", "u32", "M1 deceleration", 0, 4_294_967_295, 0), _arg("m1_position", "s32", "M1 position", -2_147_483_648, 2_147_483_647, 0), _arg("m2_accel", "u32", "M2 acceleration", 0, 4_294_967_295, 0), _arg("m2_speed", "u32", "M2 speed", 0, 4_294_967_295, 0), _arg("m2_decel", "u32", "M2 deceleration", 0, 4_294_967_295, 0), _arg("m2_position", "s32", "M2 position", -2_147_483_648, 2_147_483_647, 0), _arg("buffer", "u8", "Buffer", 0, 1, 0))),
    "set_m1_default_duty_accel": CommandSpec("set_m1_default_duty_accel", "Set M1 Default Duty Accel", "Configuration", "Set default duty acceleration for M1.", 68, "config", (_arg("accel", "u32", "Acceleration", 0, 4_294_967_295, 0),), dangerous=True),
    "set_m2_default_duty_accel": CommandSpec("set_m2_default_duty_accel", "Set M2 Default Duty Accel", "Configuration", "Set default duty acceleration for M2.", 69, "config", (_arg("accel", "u32", "Acceleration", 0, 4_294_967_295, 0),), dangerous=True),
    "set_pin_modes": CommandSpec("set_pin_modes", "Set S3/S4/S5 Modes", "Configuration", "Set S3, S4, and S5 modes.", 74, "config", (_arg("s3", "u8", "S3", 0, 255, 0), _arg("s4", "u8", "S4", 0, 255, 0), _arg("s5", "u8", "S5", 0, 255, 0)), dangerous=True),
    "read_pin_modes": CommandSpec("read_pin_modes", "Read S3/S4/S5 Modes", "Configuration", "Read S3, S4, and S5 modes.", 75, "read", response=(_resp("s3", "u8"), _resp("s4", "u8"), _resp("s5", "u8"))),
    "read_encoders": CommandSpec("read_encoders", "Read Encoders", "Encoders", "Read both encoder counts.", 78, "read", response=(_resp("m1_encoder", "u32"), _resp("m2_encoder", "u32"))),
    "read_raw_speeds": CommandSpec("read_raw_speeds", "Read Raw Speeds", "Motors", "Read raw speeds for both motors.", 79, "read", response=(_resp("m1_speed", "s32"), _resp("m2_speed", "s32"))),
    "restore_defaults": CommandSpec("restore_defaults", "Restore Defaults", "Danger Zone", "Restore controller defaults.", 80, "config", dangerous=True),
    "read_default_duty_accels": CommandSpec("read_default_duty_accels", "Read Default Duty Accels", "Configuration", "Read default duty accelerations.", 81, "read", response=(_resp("m1_accel", "u32"), _resp("m2_accel", "u32"))),
    "read_temperature": CommandSpec("read_temperature", "Read Temperature", "Status", "Read board temperature.", 82, "read", response=(_resp("temperature_c", "u16", 0.1, 1))),
    "read_temperature_2": CommandSpec("read_temperature_2", "Read Temperature 2", "Status", "Read second temperature sensor when available.", 83, "read", response=(_resp("temperature_c", "u16", 0.1, 1))),
    "read_status": CommandSpec("read_status", "Read Status", "Status", "Read RoboClaw status/error bitfield.", 90, "read", response=(_resp("status", "u32"),)),
    "read_encoder_modes": CommandSpec("read_encoder_modes", "Read Encoder Modes", "Configuration", "Read encoder mode bytes.", 91, "read", response=(_resp("m1_mode", "u8"), _resp("m2_mode", "u8"))),
    "set_m1_encoder_mode": CommandSpec("set_m1_encoder_mode", "Set M1 Encoder Mode", "Configuration", "Set M1 encoder mode byte.", 92, "config", (_arg("mode", "u8", "Mode", 0, 255, 0),), dangerous=True),
    "set_m2_encoder_mode": CommandSpec("set_m2_encoder_mode", "Set M2 Encoder Mode", "Configuration", "Set M2 encoder mode byte.", 93, "config", (_arg("mode", "u8", "Mode", 0, 255, 0),), dangerous=True),
    "write_settings": CommandSpec("write_settings", "Write Settings", "Danger Zone", "Write settings to EEPROM.", 94, "config", dangerous=True),
    "read_settings": CommandSpec("read_settings", "Read Settings", "Configuration", "Read settings from EEPROM.", 95, "read", response=(_resp("settings", "u16"),)),
    "set_standard_config": CommandSpec("set_standard_config", "Set Standard Config", "Configuration", "Set standard config bitfield.", 98, "config", (_arg("config", "u16", "Config", 0, 65535, 0),), dangerous=True),
    "read_standard_config": CommandSpec("read_standard_config", "Read Standard Config", "Configuration", "Read standard config bitfield.", 99, "read", response=(_resp("config", "u16"),)),
    "read_average_speeds": CommandSpec("read_average_speeds", "Read Average Speeds", "Motors", "Read average speeds for both motors.", 108, "read", response=(_resp("m1_speed", "s32"), _resp("m2_speed", "s32"))),
    "read_speed_errors": CommandSpec("read_speed_errors", "Read Speed Errors", "Motors", "Read closed-loop speed errors.", 111, "read", response=(_resp("m1_error", "s16"), _resp("m2_error", "s16"))),
    "read_position_errors": CommandSpec("read_position_errors", "Read Position Errors", "Positioning", "Read closed-loop position errors.", 114, "read", response=(_resp("m1_error", "s16"), _resp("m2_error", "s16"))),
}

OPERATOR_COMMAND_IDS = {
    "forward_m1",
    "backward_m1",
    "forward_m2",
    "backward_m2",
    "duty_m1",
    "duty_m2",
    "duty_m1m2",
    "speed_m1",
    "speed_m2",
    "speed_m1m2",
    "set_m1_default_duty_accel",
    "set_m2_default_duty_accel",
    "read_default_duty_accels",
    "reset_encoders",
    "read_m1_position_pid",
    "read_m2_position_pid",
    "set_m1_position_pid",
    "set_m2_position_pid",
    "read_m1_velocity_pid",
    "read_m2_velocity_pid",
    "set_m1_velocity_pid",
    "set_m2_velocity_pid",
}


STATUS_FLAGS = {
    0x000001: "M1 overcurrent",
    0x000002: "M2 overcurrent",
    0x000004: "Emergency stop",
    0x000008: "Temperature error",
    0x000010: "Temperature 2 error",
    0x000020: "Main battery high",
    0x000040: "Logic battery high",
    0x000080: "Logic battery low",
    0x000100: "M1 driver fault",
    0x000200: "M2 driver fault",
    0x000400: "Main battery high warning",
    0x000800: "Main battery low warning",
    0x001000: "Temperature warning",
    0x002000: "Temperature 2 warning",
    0x004000: "M1 home",
    0x008000: "M2 home",
}


def command_registry() -> list[CommandInfo]:
    commands = [COMMANDS[command_id] for command_id in OPERATOR_COMMAND_IDS]
    return [spec.to_model() for spec in sorted(commands, key=lambda item: (item.group, item.command, item.id))]


class SerialRoboClaw:
    def __init__(self, config: RoboClawConfig) -> None:
        self._cfg = config
        self._lock = threading.Lock()
        try:
            import serial
        except ImportError as exc:
            raise RoboClawError("pyserial is required for serial RoboClaw mode") from exc

        self._serial = serial.Serial(
            port=config.port,
            baudrate=config.baudrate,
            timeout=config.timeout_s,
            write_timeout=config.timeout_s,
        )
        self._connection = ConnectionStatus(
            mode="serial",
            port=config.port,
            baudrate=config.baudrate,
            address=config.address,
            connected=True,
        )

    @property
    def connection(self) -> ConnectionStatus:
        return self._connection

    def execute(self, command_id: str, args: dict[str, int | bool] | None = None) -> CommandResult:
        spec = _get_spec(command_id)
        try:
            payload = _encode_args(spec, args or {})
            with self._lock:
                self._write_packet(spec.command, payload)
                response = self._read_response(spec)
            return CommandResult(command_id=command_id, ok=True, response=response)
        except Exception as exc:
            logger.warning("RoboClaw command %s failed: %s", command_id, exc)
            return CommandResult(command_id=command_id, ok=False, error=str(exc))

    def snapshot(self) -> RoboClawTelemetry:
        return build_snapshot(self, self.connection)

    def stop_all(self) -> dict[str, CommandResult]:
        return {
            "forward_m1": self.execute("forward_m1", {"speed": 0}),
            "forward_m2": self.execute("forward_m2", {"speed": 0}),
        }

    def close(self) -> None:
        self._serial.close()

    def _write_packet(self, command: int, payload: bytes = b"") -> None:
        header = bytes([self._cfg.address, command]) + payload
        crc = crc16(header)
        reset_input_buffer = getattr(self._serial, "reset_input_buffer", None)
        if reset_input_buffer is not None:
            reset_input_buffer()
        self._serial.write(header + crc.to_bytes(2, "big"))

    def _read_response(self, spec: CommandSpec) -> dict[str, Any]:
        if not spec.response:
            ack = self._serial.read(1)
            if ack != ACK:
                raise RoboClawError(f"missing ACK for command {spec.command}; received {ack!r}")
            return {"ack": True}

        response_spec = _response_specs(spec)
        if response_spec[0].type == "string":
            data = self._read_string()
            # RoboClaw includes the null terminator in the CRC for string responses
            crc_payload = data + b"\x00"
        else:
            data_len = sum(_response_type_size(item.type) for item in response_spec)
            data = self._read_exact(data_len)
            crc_payload = data

        received_crc = int.from_bytes(self._read_exact(2), "big")
        calculated_crc = crc16(bytes([self._cfg.address, spec.command]) + crc_payload)
        if received_crc != calculated_crc:
            raise RoboClawError(f"CRC mismatch for command {spec.command}")
        return _decode_response(spec, data)

    def _read_string(self) -> bytes:
        data = bytearray()
        while True:
            byte = self._read_exact(1)
            if byte == b"\x00":
                break
            data.extend(byte)
            if len(data) > 256:
                raise RoboClawError("string response exceeded 256 bytes")
        return bytes(data)

    def _read_exact(self, length: int) -> bytes:
        deadline = time.monotonic() + self._cfg.timeout_s
        chunks = bytearray()
        while len(chunks) < length:
            remaining_time = deadline - time.monotonic()
            if remaining_time <= 0:
                break
            read_size = length - len(chunks)
            data = self._serial.read(read_size)
            if data:
                chunks.extend(data)
                continue
            time.sleep(min(0.005, remaining_time))
        data = bytes(chunks)
        if len(data) != length:
            raise RoboClawError(f"serial timeout reading {length} bytes; received {len(data)}")
        return data


class NullRoboClaw:
    """Stand-in client used when no serial RoboClaw is reachable.

    Every command fails with ok=False; snapshot returns an empty telemetry
    payload carrying the disconnected ConnectionStatus. The rest of the app
    treats this as "no hardware to talk to" — telemetry is null, commands
    refuse, and routes that gate on connectedness bypass safety checks they
    cannot enforce without real motors (see routes_roboclaw).
    """

    def __init__(self, config: RoboClawConfig, *, mode: Literal["disconnected", "error"] = "disconnected", message: str | None = None) -> None:
        self._connection = ConnectionStatus(
            mode=mode,
            port=config.port,
            baudrate=config.baudrate,
            address=config.address,
            connected=False,
            message=message or "RoboClaw not connected",
        )

    @property
    def connection(self) -> ConnectionStatus:
        return self._connection

    def execute(self, command_id: str, args: dict[str, int | bool] | None = None) -> CommandResult:
        return CommandResult(command_id=command_id, ok=False, error="RoboClaw not connected")

    def snapshot(self) -> RoboClawTelemetry:
        return RoboClawTelemetry(connection=self._connection, timestamp=time.time())

    def stop_all(self) -> dict[str, CommandResult]:
        return {}

    def close(self) -> None:
        return None


def make_client(config: RoboClawConfig) -> RoboClawClient:
    try:
        return SerialRoboClaw(config)
    except Exception as exc:
        mode = "error" if config.connect_mode == "serial" else "disconnected"
        return NullRoboClaw(config, mode=mode, message=f"Serial connection failed: {exc}")


def build_snapshot(client: RoboClawClient, connection: ConnectionStatus) -> RoboClawTelemetry:
    errors: list[str] = []

    def read(command_id: str, *, critical: bool = True) -> dict[str, Any]:
        result = client.execute(command_id, {})
        if not result.ok:
            if critical:
                errors.append(f"{command_id}: {result.error}")
            else:
                logger.debug("Optional RoboClaw telemetry command %s failed: %s", command_id, result.error)
            return {}
        return result.response

    firmware = read("read_firmware").get("firmware")
    main_voltage = read("read_main_battery_voltage").get("voltage_v")
    logic_voltage = read("read_logic_battery_voltage").get("voltage_v")
    currents = read("read_motor_currents")
    pwms = read("read_motor_pwms")
    enc1 = read("read_encoder_m1")
    enc2 = read("read_encoder_m2")
    speed1 = read("read_speed_m1")
    speed2 = read("read_speed_m2")
    raw_speeds = read("read_raw_speeds")
    avg_speeds = read("read_average_speeds")
    speed_errors = read("read_speed_errors", critical=False)
    position_errors = read("read_position_errors", critical=False)
    buffers = read("read_buffers")
    encoder_modes = read("read_encoder_modes")
    temp = read("read_temperature").get("temperature_c")
    temp2 = read("read_temperature_2").get("temperature_c")
    status = read("read_status").get("status")

    return RoboClawTelemetry(
        connection=connection,
        timestamp=time.time(),
        firmware=firmware,
        main_battery_v=main_voltage,
        logic_battery_v=logic_voltage,
        temperature_c=temp,
        temperature_2_c=temp2,
        status=status,
        status_flags=_status_flags(status),
        buffer_depths={"m1": buffers.get("m1"), "m2": buffers.get("m2")},
        encoder_modes={"m1": encoder_modes.get("m1_mode"), "m2": encoder_modes.get("m2_mode")},
        motors={
            "m1": {
                "command": 0,
                "pwm": pwms.get("m1_pwm"),
                "current_a": currents.get("m1_current_a"),
                "encoder": enc1.get("encoder"),
                "encoder_status": enc1.get("status"),
                "speed_qpps": speed1.get("speed_qpps"),
                "raw_speed_qpps": raw_speeds.get("m1_speed"),
                "average_speed_qpps": avg_speeds.get("m1_speed"),
                "speed_error_qpps": speed_errors.get("m1_error"),
                "position_error": position_errors.get("m1_error"),
            },
            "m2": {
                "command": 0,
                "pwm": pwms.get("m2_pwm"),
                "current_a": currents.get("m2_current_a"),
                "encoder": enc2.get("encoder"),
                "encoder_status": enc2.get("status"),
                "speed_qpps": speed2.get("speed_qpps"),
                "raw_speed_qpps": raw_speeds.get("m2_speed"),
                "average_speed_qpps": avg_speeds.get("m2_speed"),
                "speed_error_qpps": speed_errors.get("m2_error"),
                "position_error": position_errors.get("m2_error"),
            },
        },
        host=read_host_stats(),
        last_error="; ".join(errors) if errors else None,
    )


def crc16(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = (crc << 1) ^ 0x1021
            else:
                crc <<= 1
            crc &= 0xFFFF
    return crc


def _get_spec(command_id: str) -> CommandSpec:
    try:
        return COMMANDS[command_id]
    except KeyError as exc:
        raise RoboClawError(f"unknown command: {command_id}") from exc


def _encode_args(spec: CommandSpec, args: dict[str, int | bool]) -> bytes:
    values = _validate_args(spec, args)
    return b"".join(_pack_value(arg.type, values[arg.name]) for arg in spec.args)


def _validate_args(spec: CommandSpec, args: dict[str, int | bool]) -> dict[str, int | bool]:
    values: dict[str, int | bool] = {}
    for arg in spec.args:
        value = args.get(arg.name, arg.default)
        if value is None:
            raise RoboClawError(f"missing required argument: {arg.name}")
        if arg.type == "bool":
            values[arg.name] = bool(value)
            continue
        if isinstance(value, bool):
            raise RoboClawError(f"{arg.name} must be an integer")
        int_value = int(value)
        if arg.min is not None and int_value < arg.min:
            raise RoboClawError(f"{arg.name} must be >= {arg.min}")
        if arg.max is not None and int_value > arg.max:
            raise RoboClawError(f"{arg.name} must be <= {arg.max}")
        values[arg.name] = int_value
    return values


def _pack_value(type_: ValueType, value: int | bool) -> bytes:
    if type_ == "u8":
        return struct.pack(">B", int(value))
    if type_ == "u16":
        return struct.pack(">H", int(value))
    if type_ == "s16":
        return struct.pack(">h", int(value))
    if type_ == "u32":
        return struct.pack(">I", int(value))
    if type_ == "s32":
        return struct.pack(">i", int(value))
    if type_ == "bool":
        return struct.pack(">B", 1 if value else 0)
    raise RoboClawError(f"unsupported argument type {type_}")


def _decode_response(spec: CommandSpec, data: bytes) -> dict[str, Any]:
    response: dict[str, Any] = {}
    offset = 0
    for item in _response_specs(spec):
        if item.type == "string":
            value: Any = data.decode("ascii", errors="replace")
            offset = len(data)
        else:
            size = _response_type_size(item.type)
            value = _unpack_value(item.type, data[offset:offset + size])
            offset += size
            if item.scale != 1.0:
                value = value * item.scale
                if item.precision is not None:
                    value = round(value, item.precision)
        response[item.name] = value
    return response


def _response_type_size(type_: ResponseType) -> int:
    return {"u8": 1, "u16": 2, "s16": 2, "u32": 4, "s32": 4}[type_]


def _response_specs(spec: CommandSpec) -> tuple[ResponseSpec, ...]:
    if isinstance(spec.response, ResponseSpec):
        return (spec.response,)
    return spec.response


def _unpack_value(type_: ResponseType, data: bytes) -> int:
    if type_ == "u8":
        return struct.unpack(">B", data)[0]
    if type_ == "u16":
        return struct.unpack(">H", data)[0]
    if type_ == "s16":
        return struct.unpack(">h", data)[0]
    if type_ == "u32":
        return struct.unpack(">I", data)[0]
    if type_ == "s32":
        return struct.unpack(">i", data)[0]
    raise RoboClawError(f"unsupported response type {type_}")


def _status_flags(status: int | None) -> list[str]:
    if status is None:
        return []
    return [label for bit, label in STATUS_FLAGS.items() if status & bit]

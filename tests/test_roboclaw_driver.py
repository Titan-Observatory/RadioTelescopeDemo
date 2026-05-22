from __future__ import annotations

import sys
import types

import pytest

from radiotelescope.config import RoboClawConfig
from radiotelescope.hardware.roboclaw import (
    ACK,
    COMMANDS,
    SerialRoboClaw,
    command_registry,
    crc16,
)


class FakeSerial:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.writes: list[bytes] = []
        self.reads: list[bytes] = [ACK]
        self.reset_count = 0
        self.closed = False

    def write(self, data: bytes) -> None:
        self.writes.append(data)

    def read(self, size: int) -> bytes:
        if not self.reads:
            return b""
        data = self.reads.pop(0)
        if len(data) <= size:
            return data
        self.reads.insert(0, data[size:])
        return data[:size]

    def close(self) -> None:
        self.closed = True

    def reset_input_buffer(self) -> None:
        self.reset_count += 1


@pytest.fixture
def fake_serial(monkeypatch):
    created: list[FakeSerial] = []

    def factory(**kwargs):
        serial = FakeSerial(**kwargs)
        created.append(serial)
        return serial

    monkeypatch.setitem(sys.modules, "serial", types.SimpleNamespace(Serial=factory))
    return created


def test_crc16_is_stable_for_packet_bytes():
    assert crc16(bytes([0x80, 0, 64])) == 0x739E


def test_serial_command_writes_packet_and_crc(fake_serial):
    client = SerialRoboClaw(RoboClawConfig(port="COM3", address=0x80))

    result = client.execute("forward_m1", {"speed": 64})

    assert result.ok
    packet = fake_serial[0].writes[-1]
    assert packet[:3] == bytes([0x80, COMMANDS["forward_m1"].command, 64])
    assert int.from_bytes(packet[-2:], "big") == crc16(packet[:-2])


def test_serial_read_validates_response_crc(fake_serial):
    client = SerialRoboClaw(RoboClawConfig(port="COM3", address=0x80))
    payload = (124).to_bytes(2, "big")
    crc = crc16(bytes([0x80, COMMANDS["read_main_battery_voltage"].command]) + payload)
    fake_serial[0].reads = [payload, crc.to_bytes(2, "big")]

    result = client.execute("read_main_battery_voltage")

    assert result.ok
    assert result.response["voltage_v"] == 12.4


def test_serial_read_accumulates_split_response_chunks(fake_serial):
    client = SerialRoboClaw(RoboClawConfig(port="COM3", address=0x80, timeout_s=0.1))
    payload = (124).to_bytes(2, "big")
    crc = crc16(bytes([0x80, COMMANDS["read_main_battery_voltage"].command]) + payload)
    fake_serial[0].reads = [payload[:1], payload[1:], crc.to_bytes(2, "big")[:1], crc.to_bytes(2, "big")[1:]]

    result = client.execute("read_main_battery_voltage")

    assert result.ok
    assert result.response["voltage_v"] == 12.4


def test_serial_command_clears_stale_input_before_write(fake_serial):
    client = SerialRoboClaw(RoboClawConfig(port="COM3", address=0x80))

    result = client.execute("forward_m1", {"speed": 64})

    assert result.ok
    assert fake_serial[0].reset_count == 1


def test_serial_m1m2_position_command_writes_documented_packet_order(fake_serial):
    client = SerialRoboClaw(RoboClawConfig(port="COM3", address=0x80))

    result = client.execute(
        "speed_accel_decel_position_m1m2",
        {
            "m1_accel": 100,
            "m1_speed": 200,
            "m1_decel": 300,
            "m1_position": 400,
            "m2_accel": 500,
            "m2_speed": 600,
            "m2_decel": 700,
            "m2_position": 800,
            "buffer": 1,
        },
    )

    assert result.ok
    packet = fake_serial[0].writes[-1]
    assert packet[:2] == bytes([0x80, COMMANDS["speed_accel_decel_position_m1m2"].command])
    assert packet[2:-2] == (
        (100).to_bytes(4, "big")
        + (200).to_bytes(4, "big")
        + (300).to_bytes(4, "big")
        + (400).to_bytes(4, "big", signed=True)
        + (500).to_bytes(4, "big")
        + (600).to_bytes(4, "big")
        + (700).to_bytes(4, "big")
        + (800).to_bytes(4, "big", signed=True)
        + b"\x01"
    )
    assert int.from_bytes(packet[-2:], "big") == crc16(packet[:-2])


def test_serial_ack_failure_returns_error(fake_serial):
    client = SerialRoboClaw(RoboClawConfig(port="COM3", address=0x80))
    fake_serial[0].reads = [b"\x00"]

    result = client.execute("forward_m1", {"speed": 10})

    assert not result.ok
    assert "missing ACK" in (result.error or "")


def test_command_registry_excludes_major_configuration_commands():
    registry = {command.id: command for command in command_registry()}

    assert "set_m1_default_duty_accel" in registry
    assert "set_m2_default_duty_accel" in registry
    assert "write_settings" not in registry
    assert "restore_defaults" not in registry
    assert "set_standard_config" not in registry


def test_simulator_updates_motion_and_snapshot():
    from tests.fake_roboclaw import SimulatedRoboClaw

    sim = SimulatedRoboClaw(RoboClawConfig(connect_mode="auto"))

    result = sim.execute("forward_m1", {"speed": 30})
    snapshot = sim.snapshot()

    assert result.ok
    assert snapshot.connection.mode == "disconnected"
    assert snapshot.motors["m1"].pwm is not None
    assert snapshot.firmware

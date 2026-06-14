from __future__ import annotations

import time

import pytest

from rt_hardware.models.state import CommandResult, ConnectionStatus, RoboClawTelemetry
from rt_hardware.services.roboclaw import RoboClawService


class FakeRoboClaw:
    def __init__(self, *, m1_encoder: int, m2_encoder: int) -> None:
        self._m1_encoder = m1_encoder
        self._m2_encoder = m2_encoder
        self.commands: list[tuple[str, dict[str, int | bool]]] = []
        self.connection = ConnectionStatus(
            mode="disconnected",
            port="SIM",
            baudrate=38400,
            address=128,
            connected=False,
        )

    def execute(self, command_id: str, args: dict[str, int | bool] | None = None) -> CommandResult:
        self.commands.append((command_id, args or {}))
        return CommandResult(command_id=command_id, ok=True, response={"ack": True})

    def snapshot(self) -> RoboClawTelemetry:
        return RoboClawTelemetry(
            connection=self.connection,
            timestamp=time.time(),
            motors={
                "m1": {"encoder": self._m1_encoder},
                "m2": {"encoder": self._m2_encoder},
            },
        )

    def stop_all(self) -> dict[str, CommandResult]:
        return {
            "forward_m1": CommandResult(command_id="forward_m1", ok=True, response={"ack": True}),
            "forward_m2": CommandResult(command_id="forward_m2", ok=True, response={"ack": True}),
        }

    def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_service_stops_once_when_position_target_is_reached():
    client = FakeRoboClaw(m1_encoder=100, m2_encoder=200)
    service = RoboClawService(client, update_rate_hz=5)
    service.set_position_target(m1=100, m2=200)

    await service.refresh()
    await service.refresh()

    assert client.commands == [
        ("forward_m1", {"speed": 0}),
        ("forward_m2", {"speed": 0}),
    ]


@pytest.mark.asyncio
async def test_service_stops_each_axis_when_it_reaches_position_target():
    client = FakeRoboClaw(m1_encoder=100, m2_encoder=199)
    service = RoboClawService(client, update_rate_hz=5)
    service.set_position_target(m1=100, m2=200)

    await service.refresh()
    client._m2_encoder = 200
    await service.refresh()

    assert client.commands == [
        ("forward_m1", {"speed": 0}),
        ("forward_m2", {"speed": 0}),
    ]


@pytest.mark.asyncio
async def test_service_stops_axis_when_it_crosses_position_target_between_polls():
    client = FakeRoboClaw(m1_encoder=95, m2_encoder=200)
    service = RoboClawService(client, update_rate_hz=5)
    service.set_position_target(m1=100)

    await service.refresh()
    client._m1_encoder = 105
    await service.refresh()

    assert client.commands == [("forward_m1", {"speed": 0})]


@pytest.mark.asyncio
async def test_service_does_not_stop_before_position_target_is_reached():
    client = FakeRoboClaw(m1_encoder=99, m2_encoder=200)
    service = RoboClawService(client, update_rate_hz=5)
    service.set_position_target(m1=101, m2=202)

    await service.refresh()

    assert client.commands == []

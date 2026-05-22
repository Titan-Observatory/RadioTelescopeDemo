from __future__ import annotations

import time

import pytest

from radiotelescope.models.state import CommandResult, ConnectionStatus, RoboClawTelemetry
from radiotelescope.services.roboclaw import RoboClawService


class FakeRoboClaw:
    def __init__(self, *, m1_encoder: int, m2_encoder: int) -> None:
        self._m1_encoder = m1_encoder
        self._m2_encoder = m2_encoder
        self.stop_count = 0
        self.connection = ConnectionStatus(
            mode="disconnected",
            port="SIM",
            baudrate=38400,
            address=128,
            connected=False,
        )

    def execute(self, command_id: str, args: dict[str, int | bool] | None = None) -> CommandResult:
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
        self.stop_count += 1
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

    assert client.stop_count == 1


@pytest.mark.asyncio
async def test_service_does_not_stop_before_position_target_is_reached():
    client = FakeRoboClaw(m1_encoder=99, m2_encoder=200)
    service = RoboClawService(client, update_rate_hz=5)
    service.set_position_target(m1=101, m2=200)

    await service.refresh()

    assert client.stop_count == 0

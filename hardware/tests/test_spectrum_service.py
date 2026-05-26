from __future__ import annotations

import asyncio
from typing import cast

import pytest

from rt_hardware.config import SDRConfig
from rt_hardware.services._pubsub import Broadcaster
from rt_hardware.services.spectrum import SpectrumService


@pytest.mark.asyncio
async def test_reconnect_skips_when_internal_respawn_is_pending(tmp_path):
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)
    service._proc = None
    service._mode = "fault"

    async def pending_respawn():
        await asyncio.sleep(60)

    service._proc_task = asyncio.create_task(pending_respawn())
    try:
        mode = await service.reconnect()
    finally:
        service._proc_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await service._proc_task
        service._proc_task = None

    assert mode == "fault"
    assert service._proc is None


@pytest.mark.asyncio
async def test_relaunch_in_place_reuses_existing_process(tmp_path):
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)
    proc = object()
    service._proc = cast("subprocess.Popen[bytes]", proc)

    assert await service._relaunch_in_place() is proc

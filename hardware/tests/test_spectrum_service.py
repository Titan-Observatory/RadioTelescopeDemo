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


@pytest.mark.asyncio
async def test_ensure_running_skips_when_consumer_is_in_backoff(tmp_path):
    """A new subscribe while the consumer is mid-backoff must not spawn a
    second subprocess. Two Soapy sources fighting for the Airspy is the
    failure mode that manifested as ping-pong "no spectrum received within
    startup grace period" restarts in production.
    """
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)

    spawn_calls = 0

    async def fake_spawn():
        nonlocal spawn_calls
        spawn_calls += 1

    service._spawn_subprocess_locked = fake_spawn  # type: ignore[assignment]

    # Simulate the state right after _reap_dead_proc: subprocess is gone but
    # the consumer task is still alive, sleeping out its backoff before the
    # next _relaunch_in_place.
    service._proc = None

    async def pending_backoff():
        await asyncio.sleep(60)

    service._proc_task = asyncio.create_task(pending_backoff())
    try:
        await service._ensure_running()
    finally:
        service._proc_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await service._proc_task
        service._proc_task = None

    assert spawn_calls == 0
    assert service._proc is None

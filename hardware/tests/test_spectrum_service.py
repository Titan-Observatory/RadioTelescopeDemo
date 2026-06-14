from __future__ import annotations

import asyncio
import json
from typing import cast

import numpy as np
import pytest

from rt_hardware.config import SDRConfig
from rt_hardware.services import spectrum as spectrum_module
from rt_hardware.services._pubsub import Broadcaster
from rt_hardware.services.spectrum import SpectrumService


@pytest.fixture
def baseline_paths(tmp_path, monkeypatch):
    """Point the module-level baseline file paths at a temp dir."""
    cache = tmp_path / "spectrum_baseline.json"
    f32 = tmp_path / "spectrum_baseline.f32"
    tmp = tmp_path / "spectrum_baseline.f32.tmp"
    monkeypatch.setattr(spectrum_module, "BASELINE_CACHE", cache)
    monkeypatch.setattr(spectrum_module, "BASELINE_F32", f32)
    monkeypatch.setattr(spectrum_module, "BASELINE_F32_TMP", tmp)
    return cache, f32, tmp


# ── Lifecycle (unchanged behaviour) ──────────────────────────────────────


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


@pytest.mark.asyncio
async def test_reconnect_is_noop_while_capturing(tmp_path):
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)
    service._capturing = True
    # Should return immediately without touching the lifecycle lock.
    assert await service.reconnect() == "airspy"


# ── Forwarder behaviour ──────────────────────────────────────────────────


def test_publish_frame_forwards_db_spectrum_verbatim(tmp_path):
    # Wide display window disables the H I crop so this stays a pure-forwarder
    # check (crop behaviour is exercised separately below).
    service = SpectrumService(
        SDRConfig(fft_size=64, display_half_width_mhz=10.0, spur_reject_enabled=False),
        tmp_path / "config.toml",
    )
    power_db = np.linspace(-5.0, 5.0, 64).astype(np.float32)

    service._publish_frame(power_db)

    latest = service.latest
    assert latest is not None
    # Pure forwarder (RFI reject off): no linear power, no in-service dB
    # recomputation — the frame is forwarded verbatim.
    assert "power_linear" not in latest
    assert latest["power_db"] == pytest.approx(power_db.round(3).tolist())
    assert latest["baseline_corrected"] is False


def test_publish_frame_crops_to_display_window(tmp_path):
    # 3 Msps over 64 bins spans 1418.9–1421.9 MHz; a ±0.75 MHz window around the
    # 1420.4058 MHz line covers only the middle ~32 bins. The published frame
    # must be cropped to that slice, power and frequency axes staying aligned.
    cfg = SDRConfig(
        fft_size=64, center_freq_hz=1.4204e9, sample_rate_hz=3.0e6,
        display_half_width_mhz=0.75, spur_reject_enabled=False,
    )
    service = SpectrumService(cfg, tmp_path / "config.toml")
    start, stop = service._display_slice
    assert 0 < start < stop < cfg.fft_size  # a genuine interior crop

    power_db = np.linspace(-5.0, 5.0, 64).astype(np.float32)
    service._publish_frame(power_db)

    latest = service.latest
    assert latest is not None
    assert len(latest["power_db"]) == stop - start
    assert len(latest["freqs_mhz"]) == stop - start
    assert latest["power_db"] == pytest.approx(power_db[start:stop].round(3).tolist())
    # Every published frequency lies inside the displayed window.
    assert min(latest["freqs_mhz"]) >= 1420.4058 - 0.75
    assert max(latest["freqs_mhz"]) <= 1420.4058 + 0.75


def test_publish_frame_keeps_full_span_when_line_out_of_band(tmp_path):
    # Tuned far from the H I line: the window falls outside the captured band,
    # so the crop degrades to the full axis rather than an empty spectrum.
    cfg = SDRConfig(
        fft_size=64, center_freq_hz=1.3e9, sample_rate_hz=3.0e6,
        display_half_width_mhz=0.75,
    )
    service = SpectrumService(cfg, tmp_path / "config.toml")
    assert service._display_slice == (0, cfg.fft_size)

    service._publish_frame(np.zeros(64, dtype=np.float32))
    latest = service.latest
    assert latest is not None
    assert len(latest["power_db"]) == 64


# ── RFI sigma-clip (median/MAD) ──────────────────────────────────────────


# 1 MHz over 1024 bins ≈ 977 Hz/bin, so a single bin ≈ 1 kHz wide.
_BIN_HZ = 1.0e6 / 1024


def test_clean_rfi_removes_obvious_spike():
    from rt_hardware.services.spectrum import _clean_rfi

    rng = np.random.default_rng(0)
    spectrum = rng.normal(0.0, 0.1, 1024).astype(np.float32)  # flat dB noise floor
    spectrum[400:404] += 12.0  # an obvious ~4 kHz birdie, well above the noise

    out = _clean_rfi(spectrum, _BIN_HZ, sigma=6.0, max_width_khz=50.0)

    # Bridged back down to the surrounding floor (near 0), not left as a spike.
    assert np.max(np.abs(out[400:404])) < 0.5
    # Bins away from the spur are untouched.
    assert out[200] == pytest.approx(spectrum[200], abs=1e-4)


def test_clean_rfi_preserves_broad_hydrogen_line():
    from rt_hardware.services.spectrum import _clean_rfi

    # A gentle ~275 kHz-wide bump like the 21 cm line: far wider than the width
    # gate and gradual enough that MAD never flags it.
    x = np.arange(1024)
    spectrum = (4.0 * np.exp(-0.5 * ((x - 512) / 70.0) ** 2)).astype(np.float32)

    out = _clean_rfi(spectrum, _BIN_HZ, sigma=6.0, max_width_khz=50.0)

    assert out == pytest.approx(spectrum, abs=1e-3)


def test_clean_rfi_does_not_mutate_input():
    from rt_hardware.services.spectrum import _clean_rfi

    spectrum = np.zeros(1024, dtype=np.float32)
    spectrum[500] = 20.0
    before = spectrum.copy()

    _clean_rfi(spectrum, _BIN_HZ, sigma=6.0, max_width_khz=50.0)

    assert np.array_equal(spectrum, before)


def test_publish_frame_sigma_clips_rfi(tmp_path):
    # End to end: a birdie in the raw dB frame is gone from the published trace.
    service = SpectrumService(
        SDRConfig(fft_size=2048, sample_rate_hz=2.0e6, display_half_width_mhz=10.0,
                  spur_sigma=6.0),
        tmp_path / "config.toml",
    )
    rng = np.random.default_rng(1)
    power_db = rng.normal(0.0, 0.1, 2048).astype(np.float32)
    power_db[1000:1010] += 15.0  # narrowband spur

    service._publish_frame(power_db)

    latest = service.latest
    assert latest is not None
    assert max(latest["power_db"][1000:1010]) < 1.0  # spur removed


def test_publish_frame_keeps_rfi_when_reject_disabled(tmp_path):
    service = SpectrumService(
        SDRConfig(fft_size=2048, sample_rate_hz=2.0e6, display_half_width_mhz=10.0,
                  spur_reject_enabled=False),
        tmp_path / "config.toml",
    )
    power_db = np.zeros(2048, dtype=np.float32)
    power_db[1000:1010] = 15.0

    service._publish_frame(power_db)

    latest = service.latest
    assert latest is not None
    assert latest["power_db"][1005] == pytest.approx(15.0, abs=1e-3)  # untouched


def test_publish_frame_reports_baseline_corrected_from_active_flag(tmp_path):
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    service._baseline_active = True
    service._publish_frame(np.zeros(64, dtype=np.float32))

    latest = service.latest
    assert latest is not None
    assert latest["baseline_corrected"] is True


# ── Baseline capture / clear orchestration ───────────────────────────────


@pytest.mark.asyncio
async def test_capture_baseline_writes_sidecar_and_commits_f32(tmp_path, baseline_paths, monkeypatch):
    cache, f32, tmp = baseline_paths
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    Broadcaster.subscribe(service)

    power = np.arange(1, 65, dtype=np.float32)

    async def fake_capture() -> bool:
        spectrum_module.BASELINE_F32_TMP.write_bytes(power.tobytes())
        return True

    async def noop() -> None:
        return None

    monkeypatch.setattr(service, "_run_capture_subprocess", fake_capture)
    monkeypatch.setattr(service, "_kill_subprocess_locked", noop)
    monkeypatch.setattr(service, "_spawn_subprocess_locked", noop)

    baseline = await service.capture_baseline()

    assert baseline is not None
    assert baseline["power_linear"] == pytest.approx(power.tolist())
    assert baseline["power_db"] == pytest.approx((10.0 * np.log10(power)).round(3).tolist())
    assert baseline["capture_samples"] == service._cfg.integration_frames
    # The .f32 is committed (renamed off the temp) and the JSON sidecar written.
    assert f32.exists()
    assert not tmp.exists()
    assert json.loads(cache.read_text())["power_linear"] == pytest.approx(power.tolist())


@pytest.mark.asyncio
async def test_capture_baseline_returns_none_when_capture_fails(tmp_path, baseline_paths, monkeypatch):
    cache, _f32, _tmp = baseline_paths
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    Broadcaster.subscribe(service)

    async def failing_capture() -> bool:
        return False

    async def noop() -> None:
        return None

    monkeypatch.setattr(service, "_run_capture_subprocess", failing_capture)
    monkeypatch.setattr(service, "_kill_subprocess_locked", noop)
    monkeypatch.setattr(service, "_spawn_subprocess_locked", noop)

    assert await service.capture_baseline() is None
    assert not cache.exists()


@pytest.mark.asyncio
async def test_clear_baseline_removes_files(tmp_path, baseline_paths, monkeypatch):
    cache, f32, _tmp = baseline_paths
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    cache.write_text("{}")
    f32.write_bytes(b"\x00\x00\x00\x00")

    async def fake_reconnect() -> str:
        return "idle"

    monkeypatch.setattr(service, "reconnect", fake_reconnect)

    await service.clear_baseline()

    assert not cache.exists()
    assert not f32.exists()


# ── Baseline file validation in the launch command ───────────────────────


def _write_baseline(cache, f32, *, center_mhz: float, sample_mhz: float, bins: int) -> None:
    power = np.ones(bins, dtype=np.float32)
    f32.write_bytes(power.tobytes())
    cache.write_text(json.dumps({
        "center_freq_mhz": center_mhz,
        "sample_rate_mhz": sample_mhz,
        "power_linear": power.tolist(),
    }))


def test_pipeline_cmd_uses_matching_baseline(tmp_path, baseline_paths):
    cache, f32, _tmp = baseline_paths
    cfg = SDRConfig(fft_size=64, center_freq_hz=1.4204e9, sample_rate_hz=3.0e6)
    service = SpectrumService(cfg, tmp_path / "config.toml")
    _write_baseline(cache, f32, center_mhz=1420.4, sample_mhz=3.0, bins=64)

    cmd = service._pipeline_cmd()

    assert "--baseline" in cmd
    assert service._baseline_active is True


def test_pipeline_cmd_drops_stale_baseline(tmp_path, baseline_paths):
    cache, f32, _tmp = baseline_paths
    cfg = SDRConfig(fft_size=64, center_freq_hz=1.4204e9, sample_rate_hz=3.0e6)
    service = SpectrumService(cfg, tmp_path / "config.toml")
    # Same bins, but a different centre frequency → mismatched, must be dropped.
    _write_baseline(cache, f32, center_mhz=1300.0, sample_mhz=3.0, bins=64)

    cmd = service._pipeline_cmd()

    assert "--baseline" not in cmd
    assert service._baseline_active is False
    assert not f32.exists()
    assert not cache.exists()

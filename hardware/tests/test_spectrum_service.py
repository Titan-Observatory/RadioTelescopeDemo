from __future__ import annotations

import asyncio
from typing import cast

import numpy as np
import pytest

from rt_hardware.config import SDRConfig
from rt_hardware.services import spectrum as spectrum_module
from rt_hardware.services._pubsub import Broadcaster
from rt_hardware.services.spectrum import SpectrumService


@pytest.fixture
def baseline_paths(tmp_path, monkeypatch):
    """Point the module-level baseline file path at a temp dir."""
    f32 = tmp_path / "spectrum_baseline.f32"
    monkeypatch.setattr(spectrum_module, "BASELINE_F32", f32)
    return f32


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
async def test_ensure_started_does_not_bounce_running_pipeline(tmp_path):
    """The WS subscribe path must not kill a running/warming pipeline — that was
    the bridge reconnect → RTL-restart loop. ensure_started leaves _proc alone."""
    service = SpectrumService(SDRConfig(), tmp_path / "config.toml")
    Broadcaster.subscribe(service)
    proc = object()
    service._proc = cast("subprocess.Popen[bytes]", proc)

    killed = False

    async def fake_kill() -> None:
        nonlocal killed
        killed = True

    service._kill_subprocess_locked = fake_kill  # type: ignore[assignment]

    await service.ensure_started()

    assert killed is False
    assert service._proc is proc


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
    assert latest["rfi_bands"] == []
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


# ── RFI flagging (median/MAD) ────────────────────────────────────────────


# 1 MHz over 1024 bins ≈ 977 Hz/bin, so a single bin ≈ 1 kHz wide.
_BIN_HZ = 1.0e6 / 1024


def _freqs_for(n: int, bin_hz: float = _BIN_HZ) -> list[float]:
    """An ascending MHz axis spanning ``n`` bins at ``bin_hz`` spacing."""
    return [(1420.0e6 + i * bin_hz) / 1e6 for i in range(n)]


def test_flag_rfi_flags_obvious_spike():
    from rt_hardware.services.spectrum_rfi import flag_rfi

    rng = np.random.default_rng(0)
    spectrum = rng.normal(0.0, 0.1, 1024).astype(np.float32)  # flat dB noise floor
    spectrum[400:404] += 12.0  # an obvious ~4 kHz birdie, well above the noise
    freqs = _freqs_for(1024)

    bands = flag_rfi(spectrum, freqs, _BIN_HZ, sigma=6.0, max_width_khz=50.0)

    # Exactly one band, bracketing the spur's bin centres (± half a bin).
    assert len(bands) == 1
    lo, hi = bands[0]
    assert lo <= freqs[400] and hi >= freqs[403]
    assert lo < hi


def test_flag_rfi_flags_broad_hydrogen_line_shape():
    from rt_hardware.services.spectrum_rfi import flag_rfi

    # A gentle ~275 kHz-wide bump like the 21 cm line: far wider than the
    # narrow-spur gate, but still surfaced as a band for the frontend label path.
    x = np.arange(1024)
    spectrum = (4.0 * np.exp(-0.5 * ((x - 512) / 70.0) ** 2)).astype(np.float32)
    freqs = _freqs_for(1024)

    bands = flag_rfi(spectrum, freqs, _BIN_HZ, sigma=6.0, max_width_khz=50.0)

    assert len(bands) == 1
    lo, hi = bands[0]
    assert lo <= freqs[512] <= hi
    assert (hi - lo) * 1e3 > 50.0


def test_flag_rfi_does_not_mutate_input():
    from rt_hardware.services.spectrum_rfi import flag_rfi

    spectrum = np.zeros(1024, dtype=np.float32)
    spectrum[500] = 20.0
    before = spectrum.copy()

    flag_rfi(spectrum, _freqs_for(1024), _BIN_HZ, sigma=6.0, max_width_khz=50.0)

    assert np.array_equal(spectrum, before)


def test_publish_frame_flags_rfi_without_altering_trace(tmp_path):
    # End to end: a birdie stays in the published trace, but its frequency is
    # reported as an RFI band for the frontend to shade.
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
    # The spur is preserved in the trace — not removed or bridged.
    assert max(latest["power_db"][1000:1010]) > 10.0
    # …and flagged as a band covering the spur frequency.
    spur_freq = latest["freqs_mhz"][1005]
    assert any(lo <= spur_freq <= hi for lo, hi in latest["rfi_bands"])


def test_publish_frame_no_rfi_bands_when_reject_disabled(tmp_path):
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
    assert latest["rfi_bands"] == []  # flagging off → nothing reported


def test_publish_frame_reports_baseline_corrected_from_active_flag(tmp_path):
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    service._baseline_active = True
    service._publish_frame(np.zeros(64, dtype=np.float32))

    latest = service.latest
    assert latest is not None
    assert latest["baseline_corrected"] is True


# ── Baseline capture / clear orchestration ───────────────────────────────


async def _feed_capture_window(service, power_db, *, max_polls: int = 200):
    """Wait for capture_baseline to install its accumulator, then feed it a full
    window of identical frames — standing in for the ZMQ consumer loop."""
    for _ in range(max_polls):
        if service._capture_state is not None:
            break
        await asyncio.sleep(0)
    state = service._capture_state
    assert state is not None, "capture never installed its accumulator"
    # warmup + target frames so `done` fires regardless of the warmup window.
    initial_warmup = state.warmup
    for _ in range(initial_warmup + state.target):
        state.feed(power_db)
    return state, initial_warmup


@pytest.mark.asyncio
async def test_capture_baseline_integrates_live_frames(tmp_path, baseline_paths, monkeypatch):
    f32 = baseline_paths
    # 0.8 s @ 5 Hz → integration_frames = 4, a short window to integrate.
    service = SpectrumService(
        SDRConfig(fft_size=64, integration_seconds=0.8, publish_rate_hz=5.0),
        tmp_path / "config.toml",
    )
    Broadcaster.subscribe(service)

    reconnects = 0

    async def noop_reconnect() -> str:
        nonlocal reconnects
        reconnects += 1
        return "running"

    async def noop_ensure() -> None:
        return None

    monkeypatch.setattr(service, "reconnect", noop_reconnect)
    monkeypatch.setattr(service, "_ensure_running", noop_ensure)
    # A warm, uncorrected, running pipeline → no warmup frames skipped.
    service._proc = cast("subprocess.Popen[bytes]", object())
    service._mode = "running"

    power_db = np.full(64, 100.0, dtype=np.float32)  # 100 dB → 1e10 linear
    feeder = asyncio.create_task(_feed_capture_window(service, power_db))
    baseline = await service.capture_baseline()
    state, initial_warmup = await feeder

    assert baseline is not None
    # Mean of identical frames = the frame: linear 10^(100/10) = 1e10, → 100 dB.
    assert baseline["power_linear"] == pytest.approx([1e10] * 64, rel=1e-6)
    assert baseline["power_db"] == pytest.approx([100.0] * 64, abs=1e-3)
    assert baseline["capture_samples"] == state.target == 4
    assert initial_warmup == 0
    assert reconnects == 1  # only the final respawn that applies the baseline
    assert service._baseline_power is not None
    assert f32.exists()  # .f32 written from memory for the next spawn


@pytest.mark.asyncio
async def test_capture_baseline_drops_existing_baseline_before_integrating(
    tmp_path, baseline_paths, monkeypatch,
):
    # A re-capture while a baseline is live must integrate *uncorrected* frames:
    # the service drops the old baseline, respawns raw, and discards one warmup
    # window before accumulating.
    f32 = baseline_paths
    service = SpectrumService(
        SDRConfig(fft_size=64, integration_seconds=0.8, publish_rate_hz=5.0),
        tmp_path / "config.toml",
    )
    Broadcaster.subscribe(service)
    service._baseline_active = True
    service._baseline_power = np.ones(64, dtype=np.float32)
    service._baseline_cfg_key = service._cfg_baseline_key()

    reconnects = 0

    async def counting_reconnect() -> str:
        nonlocal reconnects
        reconnects += 1
        return "running"

    monkeypatch.setattr(service, "reconnect", counting_reconnect)

    power_db = np.zeros(64, dtype=np.float32)  # 0 dB → 1.0 linear
    feeder = asyncio.create_task(_feed_capture_window(service, power_db))
    baseline = await service.capture_baseline()
    state, initial_warmup = await feeder

    assert baseline is not None
    # A full settling window is discarded before accumulation begins.
    assert state.target == service._cfg.integration_frames
    assert initial_warmup == state.target
    assert baseline["capture_samples"] == state.target
    # One reconnect to restart the integration (raw), one to apply the new baseline.
    assert reconnects == 2
    assert service._baseline_power is not None
    assert f32.exists()


@pytest.mark.asyncio
async def test_capture_baseline_times_out_when_no_frames(tmp_path, baseline_paths, monkeypatch):
    service = SpectrumService(
        SDRConfig(fft_size=64, integration_seconds=0.01, publish_rate_hz=5.0),
        tmp_path / "config.toml",
    )
    Broadcaster.subscribe(service)

    async def noop_reconnect() -> str:
        return "running"

    async def noop_ensure() -> None:
        return None

    monkeypatch.setattr(service, "reconnect", noop_reconnect)
    monkeypatch.setattr(service, "_ensure_running", noop_ensure)
    # Shrink the deadline so the timeout fires fast with no frames fed.
    service.subprocess_start_timeout_s = 0.05
    service.baseline_capture_grace_s = 0.05
    service._proc = cast("subprocess.Popen[bytes]", object())
    service._mode = "running"

    assert await service.capture_baseline() is None
    # Flag is cleared so a later capture can run.
    assert service._capturing is False
    assert service._capture_state is None


@pytest.mark.asyncio
async def test_idle_close_drops_baseline_for_next_session(tmp_path, baseline_paths, monkeypatch):
    # When the viewing session ends (idle, no subscribers), the in-memory
    # baseline must be forgotten so a new connection starts uncorrected.
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    service.idle_close_delay_s = 0.0
    service._baseline_power = np.ones(64, dtype=np.float32)
    service._baseline_cfg_key = service._cfg_baseline_key()

    async def noop() -> None:
        return None

    monkeypatch.setattr(service, "_kill_subprocess_locked", noop)

    # No subscribers → the idle-close should tear down and drop the baseline.
    await service._close_after_idle()

    assert service._baseline_power is None
    assert service._baseline_cfg_key is None


@pytest.mark.asyncio
async def test_idle_close_keeps_baseline_while_subscribed(tmp_path, baseline_paths):
    # A still-active session (subscriber present) must NOT lose its baseline.
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    service.idle_close_delay_s = 0.0
    Broadcaster.subscribe(service)  # one live subscriber
    service._baseline_power = np.ones(64, dtype=np.float32)
    service._baseline_cfg_key = service._cfg_baseline_key()

    await service._close_after_idle()

    assert service._baseline_power is not None


@pytest.mark.asyncio
async def test_capture_baseline_raises_when_state_dir_readonly(tmp_path, baseline_paths, monkeypatch):
    # The Pi runs rt-hardware from a read-only checkout; without RT_STATE_DIR the
    # service can't write its .f32. Capture must fail up front with an actionable
    # error and must NOT tear down the live pipeline for a doomed run.
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    Broadcaster.subscribe(service)

    killed = False

    async def fake_kill() -> None:
        nonlocal killed
        killed = True

    monkeypatch.setattr(service, "_kill_subprocess_locked", fake_kill)
    monkeypatch.setattr(service, "_state_dir_write_error", lambda: "read-only filesystem")

    with pytest.raises(spectrum_module.BaselineCaptureError, match="read-only filesystem"):
        await service.capture_baseline()
    assert killed is False


@pytest.mark.asyncio
async def test_clear_baseline_removes_files(tmp_path, baseline_paths, monkeypatch):
    f32 = baseline_paths
    service = SpectrumService(SDRConfig(fft_size=64), tmp_path / "config.toml")
    f32.write_bytes(b"\x00\x00\x00\x00")

    async def fake_reconnect() -> str:
        return "idle"

    monkeypatch.setattr(service, "reconnect", fake_reconnect)

    await service.clear_baseline()

    assert not f32.exists()


# ── Baseline in-memory validation in the launch command ──────────────────


def test_pipeline_cmd_uses_in_memory_baseline(tmp_path, baseline_paths):
    f32 = baseline_paths
    cfg = SDRConfig(fft_size=64, center_freq_hz=1.4204e9, sample_rate_hz=3.0e6)
    service = SpectrumService(cfg, tmp_path / "config.toml")
    service._baseline_power = np.ones(64, dtype=np.float32)
    service._baseline_cfg_key = service._cfg_baseline_key()

    cmd = service._pipeline_cmd()

    assert "--baseline" in cmd
    assert service._baseline_active is True
    assert f32.exists()  # written from memory for the subprocess


def test_pipeline_cmd_drops_baseline_when_config_changed(tmp_path, baseline_paths):
    f32 = baseline_paths
    cfg = SDRConfig(fft_size=64, center_freq_hz=1.4204e9, sample_rate_hz=3.0e6)
    service = SpectrumService(cfg, tmp_path / "config.toml")
    # Baseline was captured at a different centre frequency.
    service._baseline_power = np.ones(64, dtype=np.float32)
    service._baseline_cfg_key = (1.3e9, cfg.sample_rate_hz, cfg.fft_size)

    cmd = service._pipeline_cmd()

    assert "--baseline" not in cmd
    assert service._baseline_active is False


def test_pipeline_cmd_no_baseline_when_none_captured(tmp_path, baseline_paths):
    cfg = SDRConfig(fft_size=64, center_freq_hz=1.4204e9, sample_rate_hz=3.0e6)
    service = SpectrumService(cfg, tmp_path / "config.toml")

    cmd = service._pipeline_cmd()

    assert "--baseline" not in cmd
    assert service._baseline_active is False

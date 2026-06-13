"""Spectrum service.

Forwards baseline-corrected power spectra from a GNU Radio subprocess
([rt_hardware.sdr_pipeline]) to WebSocket subscribers. The subprocess owns the
*entire* DSP path — FFT, integration (rolling EMA), baseline division and the dB
conversion — so this service does no per-frame numpy work: it just receives one
dB ``float32[fft_size]`` vector per message over ZeroMQ and packages it into a
JSON frame.

This service owns the subprocess lifecycle (lazy spawn on first subscriber,
idle-close after the last leaves) and orchestrates baseline capture: it stops
the live flowgraph, runs a one-shot capture flowgraph that writes the baseline
to a local ``.f32`` file, then respawns the live flowgraph which divides by that
file. The captured baseline is also mirrored to a JSON sidecar so the HTTP API
and frontend can read it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from rt_hardware.config import SDRConfig
from rt_hardware.hardware.sdr import LnaController
from rt_hardware.models.state import LnaStatus
from rt_hardware.services._pubsub import Broadcaster

# Baseline cache lives next to where the server was launched so it survives
# restarts. Override the directory with RT_STATE_DIR when running in a container
# so the files land on a mounted volume rather than the ephemeral container FS.
# Two files: a JSON sidecar (read by the HTTP API / frontend) and a raw float32
# vector (read by the GNU Radio live flowgraph to divide against).
_STATE_DIR = Path(os.environ.get("RT_STATE_DIR", "."))
BASELINE_CACHE = _STATE_DIR / "spectrum_baseline.json"
BASELINE_F32 = _STATE_DIR / "spectrum_baseline.f32"
# Capture writes here first, then we atomically rename onto BASELINE_F32 so the
# live flowgraph never reads a half-written file.
BASELINE_F32_TMP = _STATE_DIR / "spectrum_baseline.f32.tmp"
POWER_FLOOR = 1e-12

# 21 cm neutral-hydrogen rest frequency (MHz). The frontend zooms its spectrum
# x-axis to a fixed window around this line; the service crops each published
# spectrum to the same window (see SpectrumService._compute_display_slice) so it
# isn't median-filtering / serialising bins the chart will clip. Mirrors
# HYDROGEN_LINE_MHZ in frontend/src/lib/astro.ts.
HYDROGEN_LINE_MHZ = 1420.4058

logger = logging.getLogger(__name__)


class SpectrumFrame(dict):
    """Plain dict so FastAPI's WebSocket can JSON-encode it cheaply."""


class SpectrumService(Broadcaster[SpectrumFrame]):
    """Subprocess manager + ZMQ forwarder for the spectrum pipeline.

    The GNU Radio subprocess is spawned on first subscribe and torn down 5 s
    after the last unsubscribe, so the dongle stays cool when nobody is
    watching.
    """

    name: str = "spectrum-service"
    idle_close_delay_s: float = 5.0
    subprocess_start_timeout_s: float = 10.0
    subprocess_kill_timeout_s: float = 2.0
    # Backoff schedule when the subprocess dies unexpectedly while subscribers
    # are still attached. Resets to the first value on every successful run.
    _backoff_schedule: tuple[float, ...] = (1.0, 2.0, 5.0, 15.0, 30.0)

    def __init__(self, cfg: SDRConfig, config_path: str | Path) -> None:
        super().__init__()
        self._cfg = cfg
        self._config_path = str(config_path)
        self._lna = LnaController(cfg)

        self._latest: SpectrumFrame | None = None
        self._frames_seen: int = 0
        self._publish_period_s: float = 1.0 / max(cfg.publish_rate_hz, 1e-3)
        # Full FFT frequency axis plus the cached crop to the displayed H I
        # window (indices + pre-built MHz list), refreshed on any layout change.
        self._rebuild_freq_axis()
        # Whether the live flowgraph was spawned with a baseline file present,
        # i.e. whether the frames it emits are baseline-corrected.
        self._baseline_active: bool = False

        self._proc: subprocess.Popen[bytes] | None = None
        self._proc_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._idle_close_task: asyncio.Task[None] | None = None
        self._lifecycle_lock = asyncio.Lock()
        self._baseline_capture_lock = asyncio.Lock()
        self._capturing: bool = False
        self._mode: str = "idle"
        self._fault_detail: str | None = None
        self._shutting_down: bool = False

    # ── Read-only properties ─────────────────────────────────────────────

    @property
    def latest(self) -> SpectrumFrame | None:
        return self._latest

    @property
    def frames_seen(self) -> int:
        return self._frames_seen

    @property
    def mode(self) -> str:
        """External mode string. Preserves the legacy `"airspy"` value when
        the pipeline is up so the frontend's auto-reconnect heuristic keeps
        recognising the SDR as healthy. Internal lifecycle states
        (`"starting"`, `"running"`) are folded into `"airspy"` once a
        subprocess exists; only true failure modes leak through. While a
        baseline capture is running we also report `"airspy"` so the frontend
        doesn't try to reconnect into the capture.
        """
        if self._shutting_down:
            return "idle"
        if self._capturing:
            return "airspy"
        if self.subscriber_count == 0 and self._proc is None:
            return "idle"
        if self._mode in ("starting", "running"):
            return "airspy"
        return self._mode

    @property
    def fault_detail(self) -> str | None:
        return self._fault_detail

    @property
    def pipeline_pid(self) -> int | None:
        proc = self._proc
        return proc.pid if proc is not None and proc.poll() is None else None

    # ── Live processing tuning ───────────────────────────────────────────

    def processing_snapshot(self) -> dict[str, Any]:
        """Current values of every knob the admin panel can drive.

        Every knob is now consumed at flowgraph build time, so applying any of
        them bounces the GNU Radio subprocess.
        """
        cfg = self._cfg
        return {
            "integration_seconds": float(cfg.integration_seconds),
            "baseline_scale": float(cfg.baseline_scale),
            "baseline_offset_db": float(cfg.baseline_offset_db),
            "gain_db": cfg.gain_db,
            "agc": cfg.gain_db is None,
            "center_freq_mhz": float(cfg.center_freq_hz) / 1e6,
            "sample_rate_msps": float(cfg.sample_rate_hz) / 1e6,
            "fft_size": int(cfg.fft_size),
            "publish_rate_hz": float(cfg.publish_rate_hz),
            # Derived (echoed so the UI can show effective values).
            "integration_frames": int(cfg.integration_frames),
            "freq_resolution_hz": float(cfg.sample_rate_hz) / float(cfg.fft_size),
        }

    async def apply_processing(
        self,
        *,
        integration_seconds: float | None = None,
        baseline_scale: float | None = None,
        baseline_offset_db: float | None = None,
        gain_db: float | None = None,
        agc: bool | None = None,
        center_freq_mhz: float | None = None,
        sample_rate_msps: float | None = None,
        fft_size: int | None = None,
        publish_rate_hz: float | None = None,
    ) -> dict[str, Any]:
        """Mutate in-memory ``SDRConfig`` and bounce the flowgraph to apply it.

        Every knob is a flowgraph-build parameter now (integration window, gain,
        tuning, baseline scale/offset), so any change restarts the GNU Radio
        subprocess via ``reconnect()``. Changes that alter the FFT layout
        (centre / sample rate / fft size) invalidate the captured baseline, so
        we drop it. Changes are NOT persisted to disk — restart the service to
        fall back to ``config.toml``.
        """
        cfg = self._cfg
        changed = False
        axis_changed = False

        if integration_seconds is not None:
            if integration_seconds <= 0:
                raise ValueError("integration_seconds must be > 0")
            cfg.integration_seconds = float(integration_seconds)
            changed = True
        if baseline_scale is not None:
            if baseline_scale <= 0:
                raise ValueError("baseline_scale must be > 0")
            cfg.baseline_scale = float(baseline_scale)
            changed = True
        if baseline_offset_db is not None:
            cfg.baseline_offset_db = float(baseline_offset_db)
            changed = True
        if agc is True:
            cfg.gain_db = None
            changed = True
        elif gain_db is not None:
            cfg.gain_db = float(gain_db)
            changed = True
        if center_freq_mhz is not None:
            if center_freq_mhz <= 0:
                raise ValueError("center_freq_mhz must be > 0")
            cfg.center_freq_hz = float(center_freq_mhz) * 1e6
            changed = True
            axis_changed = True
        if sample_rate_msps is not None:
            if sample_rate_msps <= 0:
                raise ValueError("sample_rate_msps must be > 0")
            cfg.sample_rate_hz = float(sample_rate_msps) * 1e6
            changed = True
            axis_changed = True
        if fft_size is not None:
            if fft_size < 64:
                raise ValueError("fft_size must be ≥ 64")
            cfg.fft_size = int(fft_size)
            changed = True
            axis_changed = True
        if publish_rate_hz is not None:
            if publish_rate_hz <= 0:
                raise ValueError("publish_rate_hz must be > 0")
            cfg.publish_rate_hz = float(publish_rate_hz)
            self._publish_period_s = 1.0 / max(cfg.publish_rate_hz, 1e-3)
            changed = True

        if axis_changed:
            self._rebuild_freq_axis()
            # The baseline is keyed off the FFT layout; an axis change makes the
            # stored vector the wrong length, so drop it. The single reconnect
            # below respawns the flowgraph without it.
            self._delete_baseline_files()

        restarted = False
        if changed:
            await self.reconnect()
            restarted = True

        result = self.processing_snapshot()
        result["restarted"] = restarted
        result["live_applied"] = False
        return result

    @property
    def lna_status(self) -> LnaStatus:
        return self._lna.status

    async def apply_configured_bias_tee(self) -> LnaStatus:
        """Apply ``cfg.lna_bias_tee_enabled`` to the dongle.

        Called once at service startup, before any subprocess is spawned,
        so ``airspy_gpio`` has exclusive USB access to the Airspy.
        """
        if not self._cfg.lna_bias_tee_enabled:
            return self._lna.status
        return await self._lna.set(self._cfg.lna_bias_tee_enabled)

    # ── Frequency axis ───────────────────────────────────────────────────

    def _build_freq_axis(self) -> np.ndarray:
        """FFT-shifted frequency axis in MHz, centred on `center_freq_hz`."""
        bin_hz = self._cfg.sample_rate_hz / self._cfg.fft_size
        k = np.arange(self._cfg.fft_size, dtype=np.float64) - self._cfg.fft_size / 2.0
        return ((self._cfg.center_freq_hz + k * bin_hz) / 1e6).astype(np.float32)

    def _compute_display_slice(self) -> tuple[int, int]:
        """``[start, stop)`` FFT-bin range inside the displayed H I window.

        The frontend only ever shows ``HYDROGEN_LINE_MHZ ± display_half_width_mhz``,
        so cropping the published spectrum to this slice avoids median-filtering
        and JSON-encoding bins the chart will clip. The axis is monotonically
        increasing, so a pair of ``searchsorted`` calls locate the edges. Falls
        back to the full axis when the rest line sits outside the captured band
        (a mistuned SDR) so we never publish an empty spectrum.
        """
        freqs = self._freqs_mhz
        half = float(self._cfg.display_half_width_mhz)
        start = int(np.searchsorted(freqs, HYDROGEN_LINE_MHZ - half, side="left"))
        stop = int(np.searchsorted(freqs, HYDROGEN_LINE_MHZ + half, side="right"))
        if stop - start < 2:
            return 0, int(freqs.size)
        return start, stop

    def _rebuild_freq_axis(self) -> None:
        """Recompute the frequency axis and the cached display crop.

        Called at init and on any FFT-layout change. ``_freqs_mhz`` stays the
        *full* axis (the baseline sidecar is full-width); the crop slice and the
        pre-built MHz list it produces are what every published frame reuses, so
        we never rebuild that Python list per frame.
        """
        self._freqs_mhz = self._build_freq_axis()
        self._display_slice: tuple[int, int] = self._compute_display_slice()
        start, stop = self._display_slice
        self._freqs_mhz_display_list: list[float] = self._freqs_mhz[start:stop].tolist()

    # ── Public lifecycle entry points ────────────────────────────────────

    async def start(self) -> None:
        # Lazy — subprocess doesn't spawn until someone subscribes.
        logger.info("%s ready (lazy — pipeline spawns on first subscriber)", self.name)

    async def stop(self) -> None:
        self._shutting_down = True
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            await self._kill_subprocess_locked()
        logger.info("%s stopped", self.name)

    async def reconnect(self) -> str:
        """Kill and respawn the GNU Radio subprocess.

        Lets the operator power-cycle the dongle, apply a flowgraph parameter,
        or recover from a stuck Soapy state without bouncing uvicorn. If nobody
        is currently subscribed the subprocess stays down — the next viewer will
        spawn it lazily. No-op while a baseline capture owns the dongle.
        """
        if self._capturing:
            return self.mode
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            if self._capturing:
                return self.mode
            proc_task = self._proc_task
            if (
                proc_task is not None
                and not proc_task.done()
                and self._proc is None
                and self.subscriber_count > 0
                and not self._shutting_down
            ):
                logger.info(
                    "%s reconnect skipped; pipeline restart already pending (mode=%s)",
                    self.name,
                    self._mode,
                )
                return self.mode
            await self._kill_subprocess_locked()
            if self.subscriber_count > 0 and not self._shutting_down:
                await self._spawn_subprocess_locked()
        logger.info("%s reconnected (mode=%s)", self.name, self._mode)
        return self.mode

    # ── Broadcaster subscribe/unsubscribe with subprocess lifecycle ──────

    def subscribe(self, maxsize: int | None = None) -> asyncio.Queue[SpectrumFrame]:
        q = super().subscribe(maxsize)
        if self._latest is not None:
            # Replay the latest frame so the new subscriber sees something
            # immediately rather than waiting up to publish_period_s.
            q.put_nowait(self._latest)
        if not self._shutting_down:
            asyncio.create_task(self._ensure_running(), name=f"{self.name}-spawn")
        return q

    def unsubscribe(self, q: asyncio.Queue[SpectrumFrame]) -> None:
        super().unsubscribe(q)
        if self.subscriber_count == 0 and self._proc is not None and not self._shutting_down:
            if self._idle_close_task is None or self._idle_close_task.done():
                self._idle_close_task = asyncio.create_task(
                    self._close_after_idle(), name=f"{self.name}-idle-close",
                )

    # ── Integration reset ────────────────────────────────────────────────

    async def reset_integration(self) -> str:
        """Restart the flowgraph to flush its rolling EMA back to empty."""
        self._frames_seen = 0
        return await self.reconnect()

    # ── Baseline capture / load / clear ──────────────────────────────────

    async def capture_baseline(self) -> dict[str, Any] | None:
        """Capture a fresh baseline by running a one-shot capture flowgraph.

        Stops the live flowgraph (freeing the Airspy), runs a capture flowgraph
        that integrates one ``integration_seconds`` window and writes a baseline
        ``.f32``, persists the JSON sidecar, then respawns the live flowgraph so
        it divides by the new baseline. Bounded by a timeout so the request can
        never hang; returns ``None`` (→ HTTP 409) if no spectrum could be
        captured (pipeline unavailable, dongle busy, etc.).
        """
        async with self._baseline_capture_lock:
            await self._cancel_idle_close()
            async with self._lifecycle_lock:
                if self._shutting_down:
                    return None
                self._capturing = True
                # Keep `mode` reading healthy so the frontend doesn't fire a
                # reconnect into the capture while the live stream is paused.
                self._mode = "starting"
                baseline: dict[str, Any] | None = None
                try:
                    await self._kill_subprocess_locked()
                    if await self._run_capture_subprocess():
                        baseline = self._persist_baseline_from_capture()
                finally:
                    self._capturing = False
                    if self.subscriber_count > 0 and not self._shutting_down:
                        await self._spawn_subprocess_locked()
                    else:
                        self._mode = "idle"
            return baseline

    def load_baseline(self) -> dict[str, Any] | None:
        """Return the persisted baseline JSON sidecar, or ``None`` if absent."""
        if not BASELINE_CACHE.exists():
            return None
        try:
            return json.loads(BASELINE_CACHE.read_text())
        except Exception:
            logger.exception("Failed to read baseline from %s", BASELINE_CACHE)
            return None

    async def clear_baseline(self) -> None:
        """Delete the baseline and respawn the flowgraph so it stops dividing."""
        self._delete_baseline_files()
        if self._capturing or self._shutting_down:
            return
        await self.reconnect()

    def _delete_baseline_files(self) -> None:
        for path in (BASELINE_CACHE, BASELINE_F32, BASELINE_F32_TMP):
            try:
                path.unlink(missing_ok=True)
            except Exception:
                logger.exception("Failed to remove baseline file %s", path)

    async def _run_capture_subprocess(self) -> bool:
        """Run the one-shot capture flowgraph, writing BASELINE_F32_TMP.

        Returns True if the subprocess exited cleanly and a temp file exists.
        """
        try:
            BASELINE_F32_TMP.unlink(missing_ok=True)
        except Exception:
            logger.exception("Failed to clear stale capture temp %s", BASELINE_F32_TMP)

        cmd = [
            sys.executable, "-m", "rt_hardware.sdr_pipeline",
            "--config", self._config_path,
            "--capture-baseline", str(BASELINE_F32_TMP),
        ]
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            logger.error("%s baseline capture spawn failed: %s", self.name, exc)
            return False

        # Wait for the window to integrate, plus startup grace and slack.
        timeout_s = self._cfg.integration_seconds + self.subprocess_start_timeout_s + 5.0
        try:
            _, stderr = await asyncio.to_thread(proc.communicate, timeout=timeout_s)
        except subprocess.TimeoutExpired:
            logger.warning("%s baseline capture timed out after %.1fs; killing", self.name, timeout_s)
            proc.kill()
            await asyncio.to_thread(proc.wait)
            return False
        except Exception:
            logger.exception("%s baseline capture failed", self.name)
            return False

        if stderr:
            for line in stderr.decode("utf-8", errors="replace").splitlines():
                logger.info("[capture] %s", line)
        if proc.returncode != 0:
            logger.error("%s baseline capture exited with code %d", self.name, proc.returncode)
            return False
        return BASELINE_F32_TMP.exists()

    def _persist_baseline_from_capture(self) -> dict[str, Any] | None:
        """Read the captured .f32, write the JSON sidecar, commit the .f32."""
        try:
            power = np.fromfile(BASELINE_F32_TMP, dtype=np.float32)
        except Exception:
            logger.exception("Failed to read captured baseline %s", BASELINE_F32_TMP)
            return None
        fft_size = int(self._cfg.fft_size)
        if power.size != fft_size:
            logger.error(
                "Captured baseline has %d bins, expected %d", power.size, fft_size,
            )
            return None

        power = np.maximum(power, POWER_FLOOR)
        power_db = 10.0 * np.log10(power)
        cfg = self._cfg
        baseline = {
            "captured_at": time.time(),
            "center_freq_mhz": cfg.center_freq_hz / 1e6,
            "sample_rate_mhz": cfg.sample_rate_hz / 1e6,
            "integration_frames": int(cfg.integration_frames),
            "freqs_mhz": self._freqs_mhz.tolist(),
            "power_linear": power.astype(np.float32).tolist(),
            "power_db": power_db.astype(np.float32).round(3).tolist(),
            "capture_samples": int(cfg.integration_frames),
        }
        try:
            BASELINE_CACHE.write_text(json.dumps(baseline))
        except Exception:
            logger.exception("Failed to persist baseline to %s", BASELINE_CACHE)
            return None
        # Commit the raw vector for the live flowgraph last and atomically.
        try:
            os.replace(BASELINE_F32_TMP, BASELINE_F32)
        except Exception:
            logger.exception("Failed to commit baseline %s", BASELINE_F32)
            return None
        return baseline

    # ── Subprocess management ────────────────────────────────────────────

    def _pipeline_cmd(self) -> list[str]:
        """Build the live-pipeline launch command, including the baseline file
        when one has been captured *and* still matches the current FFT layout.
        Records whether the spawned flowgraph will be baseline-corrected."""
        cmd = [sys.executable, "-m", "rt_hardware.sdr_pipeline", "--config", self._config_path]
        if self._baseline_file_matches():
            cmd += ["--baseline", str(BASELINE_F32)]
            self._baseline_active = True
        else:
            # A stale baseline (e.g. config changed between runs) would silently
            # mis-divide; drop it rather than apply a mismatched correction.
            if BASELINE_F32.exists():
                self._delete_baseline_files()
            self._baseline_active = False
        return cmd

    def _baseline_file_matches(self) -> bool:
        """True if a captured baseline exists and matches the current config."""
        if not BASELINE_F32.exists():
            return False
        meta = self.load_baseline()
        if meta is None:
            # No metadata to validate against; the flowgraph still length-checks.
            return True
        cfg = self._cfg
        try:
            if int(len(meta.get("power_linear", []))) != int(cfg.fft_size):
                return False
            if abs(float(meta["center_freq_mhz"]) - cfg.center_freq_hz / 1e6) > 1e-6:
                return False
            if abs(float(meta["sample_rate_mhz"]) - cfg.sample_rate_hz / 1e6) > 1e-6:
                return False
        except Exception:
            return False
        return True

    async def _ensure_running(self) -> None:
        await self._cancel_idle_close()
        async with self._lifecycle_lock:
            if self._shutting_down or self.subscriber_count == 0 or self._capturing:
                return
            if self._proc is not None:
                return
            if self._proc_task is not None and not self._proc_task.done():
                # An existing consumer is mid-backoff between respawns; it will
                # relaunch the subprocess itself. Spawning here would create a
                # second consumer + subprocess racing for the same Airspy.
                return
            await self._spawn_subprocess_locked()

    async def _spawn_subprocess_locked(self) -> None:
        cmd = self._pipeline_cmd()
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                # Put the child in its own process group so a SIGTERM to the
                # parent doesn't propagate before we have a chance to drain
                # the ZMQ socket cleanly.
                start_new_session=True,
            )
        except FileNotFoundError as exc:
            self._mode = "unavailable"
            self._fault_detail = f"Could not exec {cmd[0]}: {exc}"
            logger.error("%s subprocess spawn failed: %s", self.name, exc)
            return
        self._proc = proc
        self._mode = "starting"
        self._fault_detail = None
        logger.info("%s spawned pipeline subprocess pid=%d", self.name, proc.pid)
        self._stderr_task = asyncio.create_task(
            self._pipe_stderr(proc), name=f"{self.name}-stderr",
        )
        self._proc_task = asyncio.create_task(
            self._consume_zmq(proc), name=f"{self.name}-consume",
        )

    async def _close_after_idle(self) -> None:
        try:
            await asyncio.sleep(self.idle_close_delay_s)
        except asyncio.CancelledError:
            return
        async with self._lifecycle_lock:
            if self.subscriber_count > 0 or self._proc is None or self._shutting_down:
                return
            await self._kill_subprocess_locked()
            logger.info("%s closed pipeline (idle, no subscribers)", self.name)

    async def _cancel_idle_close(self) -> None:
        task = self._idle_close_task
        self._idle_close_task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _kill_subprocess_locked(self) -> None:
        # Cancel the consumer task first so a fresh spawn doesn't race with
        # a still-running consumer holding the previous ZMQ socket.
        for attr in ("_proc_task", "_stderr_task"):
            task: asyncio.Task[None] | None = getattr(self, attr)
            setattr(self, attr, None)
            if task is None:
                continue
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                logger.exception("%s task %s raised during shutdown", self.name, attr)
        proc = self._proc
        self._proc = None
        self._mode = "idle"
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
            await asyncio.to_thread(proc.wait, self.subprocess_kill_timeout_s)
        except subprocess.TimeoutExpired:
            logger.warning("%s subprocess did not exit on SIGTERM; sending SIGKILL", self.name)
            proc.kill()
            try:
                await asyncio.to_thread(proc.wait, self.subprocess_kill_timeout_s)
            except subprocess.TimeoutExpired:
                logger.error("%s subprocess refused to die after SIGKILL", self.name)
        except Exception:
            logger.exception("%s subprocess termination failed", self.name)

    async def _pipe_stderr(self, proc: subprocess.Popen[bytes]) -> None:
        """Forward the subprocess's stderr line-by-line to our logger."""
        stderr = proc.stderr
        if stderr is None:
            return
        try:
            while True:
                line = await asyncio.to_thread(stderr.readline)
                if not line:
                    return
                # The subprocess already formats with timestamps/level; emit
                # at INFO so they're visible without DEBUG on the parent.
                logger.info("[pipeline] %s", line.decode("utf-8", errors="replace").rstrip())
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("%s stderr pipe failed", self.name)

    # ── ZMQ consumer (pure forwarder) ────────────────────────────────────

    async def _consume_zmq(self, proc: subprocess.Popen[bytes]) -> None:
        """Receive one dB Float32[fft_size] vector per message and forward it.

        Implements backoff-with-reset: a clean run drops the backoff index
        to 0; consecutive crashes step through `_backoff_schedule` so we
        don't hot-loop on a permanently-broken setup.

        This is the *one* consumer task for the service. On crash we relaunch
        the subprocess in place — never via `_spawn_subprocess_locked`, since
        that would spawn another consumer task and double them every cycle.
        """
        backoff_index = 0
        while not self._shutting_down and self.subscriber_count > 0:
            try:
                await self._run_zmq_loop(proc)
                # Subprocess exited cleanly (e.g. parent told it to stop).
                return
            except asyncio.CancelledError:
                raise
            except _PipelineDied as exc:
                self._mode = "fault"
                self._fault_detail = str(exc)
                logger.warning("%s pipeline died: %s", self.name, exc)
            except Exception as exc:
                self._mode = "fault"
                self._fault_detail = f"Consumer crashed: {exc}"
                logger.exception("%s ZMQ consumer crashed", self.name)

            # Reap the dead proc and tear down its stderr pipe so the next
            # iteration starts from a clean slate.
            await self._reap_dead_proc(proc)

            if self._shutting_down or self.subscriber_count == 0:
                return

            wait = self._backoff_schedule[min(backoff_index, len(self._backoff_schedule) - 1)]
            backoff_index += 1
            logger.info("%s respawning pipeline in %.1fs (attempt %d)", self.name, wait, backoff_index)
            try:
                await asyncio.sleep(wait)
            except asyncio.CancelledError:
                raise

            new_proc = await self._relaunch_in_place()
            if new_proc is None:
                return
            proc = new_proc

    async def _reap_dead_proc(self, proc: subprocess.Popen[bytes]) -> None:
        """Best-effort cleanup of a subprocess we just observed dying."""
        # Cancel the stderr task for this defunct proc so it doesn't sit
        # blocked on readline against a closed pipe.
        stderr_task = self._stderr_task
        self._stderr_task = None
        if stderr_task is not None and not stderr_task.done():
            stderr_task.cancel()
            try:
                await stderr_task
            except (asyncio.CancelledError, Exception):
                pass
        if proc.poll() is None:
            try:
                proc.terminate()
                await asyncio.to_thread(proc.wait, self.subprocess_kill_timeout_s)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        self._proc = None

    async def _relaunch_in_place(self) -> subprocess.Popen[bytes] | None:
        """Spawn a fresh subprocess from inside the existing consumer task.

        Mirrors `_spawn_subprocess_locked` but does NOT create a new
        `_proc_task` — that's the bug that previously doubled consumers
        on every restart cycle.
        """
        async with self._lifecycle_lock:
            if self._shutting_down or self.subscriber_count == 0 or self._capturing:
                return None
            if self._proc is not None:
                return self._proc
            cmd = self._pipeline_cmd()
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
            except FileNotFoundError as exc:
                self._mode = "unavailable"
                self._fault_detail = f"Could not exec {cmd[0]}: {exc}"
                logger.error("%s subprocess respawn failed: %s", self.name, exc)
                return None
            self._proc = proc
            self._mode = "starting"
            self._fault_detail = None
            self._stderr_task = asyncio.create_task(
                self._pipe_stderr(proc), name=f"{self.name}-stderr",
            )
            logger.info("%s respawned pipeline subprocess pid=%d", self.name, proc.pid)
            return proc

    async def _run_zmq_loop(self, proc: subprocess.Popen[bytes]) -> None:
        # Imported lazily so the hardware service still imports cleanly on
        # systems without pyzmq (e.g. a developer's laptop running tests).
        try:
            import zmq  # type: ignore[import-not-found]
            import zmq.asyncio  # type: ignore[import-not-found]
        except ImportError as exc:
            self._mode = "unavailable"
            self._fault_detail = "pyzmq is not installed"
            raise _PipelineDied(str(exc)) from exc

        ctx = zmq.asyncio.Context.instance()
        sock = ctx.socket(zmq.SUB)
        sock.setsockopt(zmq.SUBSCRIBE, b"")
        sock.setsockopt(zmq.RCVHWM, 2)
        sock.setsockopt(zmq.LINGER, 0)
        sock.connect(self._cfg.pipeline_ipc_path)
        # GNU Radio's zmq_pub_sink emits one message per output (~publish_rate_hz).
        # At 5 Hz the deadline below gives us 3× slack.
        recv_timeout_s = 5.0 * self._publish_period_s + self.subprocess_start_timeout_s
        fft_size = int(self._cfg.fft_size)
        expected_bytes = fft_size * 4  # float32

        try:
            first_frame_deadline = time.monotonic() + self.subprocess_start_timeout_s
            saw_frame = False
            while not self._shutting_down and self.subscriber_count > 0:
                if proc.poll() is not None:
                    raise _PipelineDied(f"subprocess exited with code {proc.returncode}")
                try:
                    raw = await asyncio.wait_for(sock.recv(), timeout=recv_timeout_s)
                except asyncio.TimeoutError:
                    if not saw_frame and time.monotonic() > first_frame_deadline:
                        raise _PipelineDied("no spectrum received within startup grace period")
                    continue

                if len(raw) != expected_bytes:
                    logger.warning(
                        "%s received unexpected payload length %d (expected %d)",
                        self.name, len(raw), expected_bytes,
                    )
                    continue

                saw_frame = True
                if self._mode != "running":
                    self._mode = "running"
                    self._fault_detail = None

                # The flowgraph already produced a finished dB spectrum
                # (integrated, baseline-divided). We just forward it.
                power_db = np.frombuffer(raw, dtype=np.float32)
                self._frames_seen += 1
                self._publish_frame(power_db)
        finally:
            try:
                sock.close(0)
            except Exception:
                pass

    def _publish_frame(self, power_db: np.ndarray) -> None:
        cfg = self._cfg
        # The frontend only shows the H I window, so crop the full FFT output to
        # that slice before any per-frame work — at the default 3 Msps this
        # halves the median filter, dB rounding/serialisation and WebSocket
        # payload. The slice is a view; the median filter copies.
        start, stop = self._display_slice
        power_db = power_db[start:stop]
        # Reject narrowband spurs/RFI (1-2 bin spikes) that don't divide out of
        # the baseline cleanly. The hydrogen line is far wider than this window,
        # so it survives untouched.
        spectrum = _median_filter_1d(
            np.asarray(power_db, dtype=np.float32), int(cfg.spur_median_bins),
        )
        frame = SpectrumFrame(
            timestamp=time.time(),
            center_freq_mhz=cfg.center_freq_hz / 1e6,
            sample_rate_mhz=cfg.sample_rate_hz / 1e6,
            integration_frames=cfg.integration_frames,
            frames_seen=self._frames_seen,
            frame_duration_s=self._publish_period_s,
            integration_seconds=float(cfg.integration_seconds),
            mode=self.mode,
            # Cached cropped axis — constant between layout changes, so it isn't
            # rebuilt per frame.
            freqs_mhz=self._freqs_mhz_display_list,
            power_db=spectrum.round(3).tolist(),
            baseline_corrected=self._baseline_active,
        )
        self._latest = frame
        self.publish(frame)


def _median_filter_1d(values: np.ndarray, window: int) -> np.ndarray:
    """Sliding-window median across frequency bins for spur rejection.

    ``window`` is forced odd; 0 or 1 is a no-op. Edges are handled by
    edge-padding so the output keeps the same length. Cheap enough to run on
    every published frame (a few thousand bins at ~5 Hz).
    """
    if window <= 1 or values.size == 0:
        return values
    k = int(window) | 1  # force odd
    if k >= values.size:
        return values
    pad = k // 2
    padded = np.pad(values, pad, mode="edge")
    windows = np.lib.stride_tricks.sliding_window_view(padded, k)
    return np.median(windows, axis=1).astype(np.float32)


class _PipelineDied(RuntimeError):
    """The GNU Radio subprocess exited or stopped sending data."""


__all__: Iterable[str] = ("SpectrumService", "SpectrumFrame")

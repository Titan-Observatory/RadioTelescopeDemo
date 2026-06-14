# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Monorepo with two independently deployable services:

- `hardware/` — `rt-hardware` package. Runs on a machine at the telescope: motors, SDR, camera. Trusted-network only; no users, no queue, no UI.
- `platform/` — `rt-platform` package. The central web-facing service: UI, queue, auth, proxies HTTP/WS to `rt-hardware`. Includes the React frontend at `platform/frontend/`.

The two services communicate exclusively over HTTP/WebSocket (`platform.config.hardware_url`). The platform has no Python imports from the hardware package.

This split is deliberate groundwork for a multi-telescope observatory network: one central platform (sessions today; cross-telescope scheduling planned, not yet implemented) with an `rt-hardware` instance at each dish. The platform currently binds to a single `hardware_url`. LAN-admin gating is a development convenience, not the deployment model.

## Commands

```bash
# ── Docker (default user experience) ────────────────────────────────────
docker compose up                             # production-style stack
docker compose -f docker-compose.yml -f docker-compose.dev.yml up   # no USB pass-through

# ── Bare metal: hardware service ────────────────────────────────────────
cd hardware
pip install -e ".[dev]"
rt-hardware -c config.toml                    # listens on 0.0.0.0:8001
pytest                                        # hardware tests

# ── Bare metal: platform service ────────────────────────────────────────
cd platform
pip install -e ".[dev]"
rt-platform -c config.toml                    # listens on 0.0.0.0:8000
pytest                                        # platform tests

# ── Frontend dev server ────────────────────────────────────────────────
cd platform/frontend
npm install
npm run dev                                   # Vite at :5173, proxies API to :8000

# ── Type sync (run when models change) ──────────────────────────────────
cd hardware && python -m rt_hardware.scripts.dump_types
# Writes ../platform/frontend/src/types.gen.ts
```

## Architecture

### Hardware service (`hardware/src/rt_hardware/`)

Owns the physical hardware. Routes are unauthenticated — the service binds on a trusted network only (Docker internal bridge, or a LAN with firewall rules).

- `hardware/roboclaw.py` — Packet Serial driver for a RoboClaw motor controller over USB serial. M1 = azimuth, M2 = elevation. `COMMANDS` / `OPERATOR_COMMAND_IDS` define the API surface.
- `hardware/sdr.py` — `LnaController` toggles the SDR's antenna-port bias tee (`airspy_gpio` for the Airspy, `rtl_biast` for RTL-SDR dongles), selected by `[sdr] driver`. Live IQ acquisition lives in the GNU Radio subprocess, not here.
- `hardware/host_stats.py` — CPU/memory/temp readers folded into telemetry.
- `services/roboclaw.py` — `RoboClawService`: polls telemetry, serialises I/O behind an `asyncio.Lock`, broadcasts `RoboClawTelemetry`. Tracks position targets, runs the jog watchdog. Computes RA/Dec via `pointing.altaz_to_radec`.
- `services/spectrum.py` — `SpectrumService`: manages the GNU Radio subprocess lifecycle (lazy spawn on first subscriber, idle close 5 s after the last leaves) and consumes integrated power spectra over ZeroMQ. Applies a rolling EMA in numpy at the publish rate, spur rejection and baseline correction, then broadcasts JSON frames to WebSocket subscribers. The baseline is in-memory only (held for the process lifetime, never persisted); the platform clears it on queue control-handover so each user captures their own. The `.f32` on disk is just the IPC handoff to the GNU Radio subprocess.
- `services/goes.py` — `GoesService`: same lifecycle pattern for the GOES downlink (`[observation] mode = "goes"`; the two SDR modes are mutually exclusive — one SDR). Demod/decode is delegated to goestools: the service supervises `goesrecv` (SDR → VCDUs; config generated from `[goes]`) and `goesproc` (VCDUs → product files, cwd = product store), consumes goesrecv's nanomsg publishers (demod/decoder stats, symbols, VCDUs) into `/ws/goes` status frames, and indexes goesproc's output. `goes.simulate = true` swaps both subprocesses for a synthetic backend (no SDR/goestools needed; lock follows dish pointing).
- `goes/` — GOES glue, hardware-free and unit-tested: `goestools.py` (goesrecv config generation, goesproc discovery + shipped fallback handler config), `nanomsg.py` (minimal SP-over-TCP SUB client), `products.py` (index over goesproc's output tree), `pointing.py` (geostationary look angles), `simulator.py`.
- `services/camera.py` — `CameraService`: single shared `cv2.VideoCapture` so the MJPEG stream and the snapshot endpoint can share the one-opener V4L2 device. Lazy-opens, idle-closes.
- `services/geometry.py` — altitude-calibration polynomial fitting (linear/quadratic through `altitude_calibration.points`).
- `services/_pubsub.py` — `Broadcaster[T]` drop-oldest fanout (a copy also lives in the platform package).
- `sdr_pipeline.py` — GNU Radio top-block (Soapy → FFT → mag² → integrate_ff → zeromq.pub_sink) run as a subprocess via `python -m rt_hardware.sdr_pipeline -c config.toml`. This is where the per-sample DSP actually happens.
- `geometry.py` / `pointing.py` — encoder ↔ altitude and katpoint J2000 conversions. The frontend keeps a deliberately low-precision TS port in `frontend/src/lib/astro.ts`, synced by hand.
- `models/state.py` — canonical Pydantic response models. Frontend types are generated from this via `scripts/dump_types.py`.
- `api/routes_roboclaw.py`, `api/routes_spectrum.py`, `api/routes_camera.py`, `api/routes_goes.py` — the HTTP routers. Hardware has no queue/auth dependencies; mutations are unrestricted. Includes `/api/camera/frame` (single JPEG snapshot) and `/api/admin/spectrum/processing` (live DSP tuning) alongside the streams. `routes_goes` also serves `/api/observation` (boot mode + satellite look angles, available in both modes) and the decoded-product archive.

### Platform service (`platform/src/rt_platform/`)

Web-facing. Enforces the queue and motion audit log; proxies all motor/spectrum/camera traffic to the hardware service.

- `services/queue.py` — `QueueService`: multi-user control queue with session cookies, per-IP caps, idle timeouts, join cooldown.
- `services/ws_bridge.py` — `JsonWsBridge`: holds one upstream WS to a hardware stream (`/ws/spectrum`, `/ws/goes`) and fans frames out to browser subscribers. Lazy: connects only while at least one browser is subscribed. One instance per stream; only the stream matching the hardware's observation mode ever sees subscribers.
- `services/hardware_client.py` — thin httpx wrapper bound to `config.hardware_url`.
- `services/status.py` — `TelescopeStatusService`: operator-set telescope state (`operational` / `maintenance` / `closed`) with disk persistence and broadcast; the queue gates new joins on it.
- `services/_pubsub.py` — `Broadcaster[T]` drop-oldest fanout, shared by queue, bridge, and status.
- `loki.py` — fire-and-forget Loki log push (`loki_url` / `LOKI_URL`; no-op when unset).
- `api/routes_motor.py` — proxies all motor/telescope HTTP endpoints to the hardware service; bridges `/ws/roboclaw`. Enforces `require_control` on mutations; writes motion audit log to `motion.jsonl`. Read-only endpoints require an active queue session; sync/homing/PID require `require_lan_admin`.
- `api/routes_spectrum.py` — proxies spectrum HTTP, bridges `/ws/spectrum`.
- `api/routes_goes.py` — proxies `/api/observation` (degrades to hydrogen-line when the gateway is down) and `/api/goes/*` (status, products, files), bridges `/ws/goes`. Viewers read; only the controller can reconnect the pipeline or clear products.
- `api/routes_camera.py` — proxies camera MJPEG stream, snapshot frame, and status.
- `api/routes_admin.py` — LAN-admin-only control panel: telescope status flag, queue snapshot, kick a session. Returns 404 to non-allowlisted clients so the admin surface is invisible. Audits to `motion.jsonl`.
- `api/routes_queue.py`, `api/routes_feedback.py`, `api/routes_events.py` — fully local. `routes_queue` also serves the public `/api/telescope/status`.
- `api/auth.py` — optional `PasswordAuthMiddleware`. `api/dependencies.py` — shared auth/queue dependencies. `api/log_files.py` — rotating JSONL append + IP hashing helpers.
- Cross-cutting middleware: `SecurityHeadersMiddleware`, `RateLimitMiddleware`, `CORSMiddleware`, `ClientAllowlistMiddleware`, `PasswordAuthMiddleware`. Auth helpers: `require_active_queue_session` (viewer), `require_control` (must hold the queue), `require_lan_admin` / `is_lan_admin`.

### Frontend (`platform/frontend/`)

Vite + React + TypeScript. `App.tsx` is the root and routes between the live view, `QueuePage`, and the LAN-admin `AdminPage`. Subdirs: `components/` (incl. `SkyMap/` built on aladin-lite, `SpectrumPanel`, `MotionControls`, `TelemetryDashboard`, `BaselineWizard`, and `goes/` — `GoesConnectPanel` + `GoesDataExplorer`), `lib/` (hooks — `useJsonSocket`, `useTelemetry`, `useQueueLease`, `useMotionCommands`, `useObservationMode`, `useGoesStream` — plus `astro.ts`, a hand-synced low-precision TS port of `hardware/geometry.py`/`pointing.py`), `types/` and `types.gen.ts` (auto-generated from `rt_hardware.models.state`). The platform serves `frontend/dist/` from `/` with a SPA fallback for unknown GETs.

The observation screen is mode-aware: `useObservationMode` fetches `/api/observation` once and `ControlUI` swaps the right-column hydrogen-line panels for `GoesConnectPanel` (satellite look angles + slew, SNR meter, acquisition stepper, band PSD, constellation) in GOES mode. Once frame lock is achieved (or archived products exist) `GoesDataExplorer` renders full-width below the Aladin/side-panel grid: link stats, virtual-channel activity, and a decoded-product gallery with lightbox.

### Config

Each service has its own Pydantic v2 config loaded from TOML with `${ENV_VAR:-default}` expansion. `HARDWARE_URL` env var on the platform overrides `hardware_url` from the TOML (Docker Compose uses this).

- Hardware: `general`, `server` (just host/port), `roboclaw`, `telemetry`, `mount`, `observer`, `camera`, `sdr`, `observation` (mode switch), `goes`.
- Platform: `general`, `server`, `rate_limit`, `queue`, `auth`, `turnstile`, plus `hardware_url`, `loki_url` (`LOKI_URL` env override), `telescope_status_path`, and feedback/events/motion log paths. `public_exposure_errors(cfg)` runs at startup and refuses to boot a public-facing bind that has placeholder secrets, wildcard CORS, no Turnstile, etc.

## Testing

Tests use `pytest-asyncio` with `asyncio_mode = "auto"`. Each package has its own `tests/` directory and runs independently. Hardware tests use `tests/fake_roboclaw.py::SimulatedRoboClaw` to stand in for the real driver — no real hardware required. `docs/separation-plan.md` records the rationale for the two-service split.

## Hardware Notes (Raspberry Pi)

- Motors: RoboClaw 2xN over USB serial (Packet Serial mode, default address 0x80, 38400 baud). Encoders are the only source of position — calibrate `mount.az_counts_per_degree`, `alt_counts_per_degree`, zero offsets, and (optionally) `altitude_calibration.points`.
- SDR: SoapySDR + GNU Radio (the spectrum DSP runs as a GNU Radio flowgraph in a subprocess; the FastAPI service only consumes integrated spectra via ZeroMQ). `[sdr] driver` picks the dongle: `"airspy"` (Airspy Mini/R2) or `"rtlsdr"` (RTL2832U dongles such as the Nooelec NESDR series). Install on the Pi with `sudo apt install soapysdr-module-airspy soapysdr-module-rtlsdr python3-soapysdr gnuradio gr-soapy python3-zmq` (none of these bindings are on PyPI), plus `rtl-sdr` for `rtl_biast`. Airspy Mini sample rate must be 3 Msps or 6 Msps; RTL-SDR tops out at ~2.4 Msps. Gain scale and bias-tee tool follow the driver. In Docker, the hardware image already installs these packages.
- GOES mode additionally needs goestools (`goesrecv` + `goesproc`), built from source per https://github.com/pietern/goestools — the hardware Docker image builds it in a stage. Not required with `goes.simulate = true`. See `docs/goes-mode.md`.
- Camera: V4L2 device via OpenCV; configured under `[camera]`.

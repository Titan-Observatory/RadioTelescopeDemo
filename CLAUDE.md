# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Layout

Monorepo with two independently deployable services:

- `hardware/` — `rt-hardware` package. Pi-side: motors, SDR, camera. Trusted-network only; no users, no queue, no UI.
- `platform/` — `rt-platform` package. Web-facing: UI, queue, auth, proxies HTTP/WS to `rt-hardware`. Includes the React frontend at `platform/frontend/`.

The two services communicate exclusively over HTTP/WebSocket (`platform.config.hardware_url`). The platform has no Python imports from the hardware package.

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
- `hardware/sdr.py` — `LnaController` toggles the Airspy's 4.5 V bias tee via the `airspy_gpio` tool. Live IQ acquisition lives in the GNU Radio subprocess, not here.
- `hardware/host_stats.py` — CPU/memory/temp readers folded into telemetry.
- `services/roboclaw.py` — `RoboClawService`: polls telemetry, serialises I/O behind an `asyncio.Lock`, broadcasts `RoboClawTelemetry`. Tracks position targets, runs the jog watchdog. Computes RA/Dec via `pointing.altaz_to_radec`.
- `services/spectrum.py` — `SpectrumService`: manages the GNU Radio subprocess lifecycle (lazy spawn on first subscriber, idle close 5 s after the last leaves) and consumes integrated power spectra over ZeroMQ. Applies a rolling EMA in numpy at the publish rate, then broadcasts JSON frames to WebSocket subscribers. Persists baseline to `spectrum_baseline.json`.
- `sdr_pipeline.py` — GNU Radio top-block (Soapy → FFT → mag² → integrate_ff → zeromq.pub_sink) run as a subprocess via `python -m rt_hardware.sdr_pipeline -c config.toml`. This is where the per-sample DSP actually happens.
- `geometry.py` / `pointing.py` — encoder ↔ altitude and katpoint J2000 conversions.
- `models/state.py` — canonical Pydantic response models. Frontend types are generated from this via `scripts/dump_types.py`.
- `api/routes_roboclaw.py`, `api/routes_spectrum.py`, `api/routes_camera.py` — the three HTTP routers. Hardware has no queue/auth dependencies; mutations are unrestricted.

### Platform service (`platform/src/rt_platform/`)

Web-facing. Enforces the queue and motion audit log; proxies all motor/spectrum/camera traffic to the hardware service.

- `services/queue.py` — `QueueService`: multi-user control queue with session cookies, per-IP caps, idle timeouts, join cooldown.
- `services/spectrum_bridge.py` — `SpectrumBridge`: holds one upstream WS to the hardware's `/ws/spectrum` and fans frames out to browser subscribers. Lazy: connects only while at least one browser is subscribed.
- `services/hardware_client.py` — thin httpx wrapper bound to `config.hardware_url`.
- `services/_pubsub.py` — `Broadcaster[T]` drop-oldest fanout, shared by queue and bridge.
- `api/routes_motor.py` — proxies all motor/telescope HTTP endpoints to the hardware service; bridges `/ws/roboclaw`. Enforces `require_control` on mutations; writes motion audit log to `motion.jsonl`. Read-only endpoints (`/api/health`, status, commands listing, `/api/telescope/config`) are unauthenticated.
- `api/routes_spectrum.py` — proxies spectrum HTTP, bridges `/ws/spectrum` via `SpectrumBridge`.
- `api/routes_camera.py` — proxies camera MJPEG stream + status.
- `api/routes_queue.py`, `api/routes_feedback.py`, `api/routes_events.py` — fully local.
- `api/auth.py` — optional `PasswordAuthMiddleware`.
- Cross-cutting middleware: `SecurityHeadersMiddleware`, `RateLimitMiddleware`, `CORSMiddleware`, `ClientAllowlistMiddleware`, `PasswordAuthMiddleware`. Auth helpers: `require_control` (must hold the queue), `require_lan_admin` / `is_lan_admin`.

### Frontend (`platform/frontend/`)

Vite + React + TypeScript. `LiveShell.tsx` is the root. Subdirs: `components/`, `ui/`, `ws/` (telemetry/spectrum/queue WebSocket clients), `lib/` (incl. `altaz.ts` — a hand-synced TS port of `hardware/geometry.py`), `types/` and `types.gen.ts` (auto-generated from `rt_hardware.models.state`). The platform serves `frontend/dist/` from `/` with a SPA fallback for unknown GETs.

### Config

Each service has its own Pydantic v2 config loaded from TOML with `${ENV_VAR:-default}` expansion. `HARDWARE_URL` env var on the platform overrides `hardware_url` from the TOML (Docker Compose uses this).

- Hardware: `general`, `server` (just host/port), `roboclaw`, `telemetry`, `mount`, `observer`, `camera`, `sdr`.
- Platform: `general`, `server`, `rate_limit`, `queue`, `auth`, `turnstile`, plus `hardware_url`, `sdr_bridge_enabled`, and feedback/events/motion log paths. `public_exposure_errors(cfg)` runs at startup and refuses to boot a public-facing bind that has placeholder secrets, wildcard CORS, no Turnstile, etc.

## Testing

Tests use `pytest-asyncio` with `asyncio_mode = "auto"`. Each package has its own `tests/` directory and runs independently. Hardware tests use `tests/fake_roboclaw.py::SimulatedRoboClaw` to stand in for the real driver — no real hardware required.

> The test suite was originally written against the unified `radiotelescope` package and is being re-partitioned as part of the migration. See `docs/separation-plan.md` for the move map.

## Hardware Notes (Raspberry Pi)

- Motors: RoboClaw 2xN over USB serial (Packet Serial mode, default address 0x80, 38400 baud). Encoders are the only source of position — calibrate `mount.az_counts_per_degree`, `alt_counts_per_degree`, zero offsets, and (optionally) `altitude_calibration.points`.
- SDR: SoapySDR Airspy driver + GNU Radio (the spectrum DSP runs as a GNU Radio flowgraph in a subprocess; the FastAPI service only consumes integrated spectra via ZeroMQ). Install on the Pi with `sudo apt install soapysdr-module-airspy python3-soapysdr gnuradio gr-soapy python3-zmq` (none of these bindings are on PyPI). Airspy Mini sample rate must be 3 Msps or 6 Msps. In Docker, the hardware image already installs these packages.
- Camera: V4L2 device via OpenCV; configured under `[camera]`.

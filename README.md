# Radio Telescope

A self-hosted control stack for a small alt-az radio telescope: a RoboClaw-driven mount, an Airspy SDR for spectrum capture, and an optional V4L2 finder camera. You get a browser-based dashboard for slewing, live telemetry, an integrated FFT view, and a video feed — all served from your own LAN.

Designed for a single dish on a workbench or rooftop. Not designed to be exposed to the open internet — keep it on your home network.

```
┌──────────────┐         ┌────────────────────────┐         ┌──────────────┐
│  Browser     │ ◀────▶  │  platform  (port 8000) │ ◀────▶  │  hardware    │
│  (Vite SPA)  │   HTTP  │  React UI, queue, auth │   HTTP  │  (port 8001) │
│              │   WS    │  proxies → hardware    │   WS    │  motors+SDR  │
└──────────────┘         └────────────────────────┘         └──────────────┘
       LAN browser              any LAN host                   Raspberry Pi
```

## What's in the box

- **Mount control** — alt/az or RA/Dec goto, continuous jog, emergency stop, soft pointing limits, jog watchdog, optional altitude lookup-table calibration.
- **Spectrum** — Airspy + GNU Radio flowgraph → FFT → integrated power. Live WebSocket stream, EMA smoothing, baseline capture/subtraction.
- **Finder camera** — MJPEG stream from any V4L2 device.
- **Multi-user queue** — visitors watch the live view freely; one person at a time holds the control lease (configurable session length, idle timeout, per-IP caps).
- **Motion audit log** — every accepted goto/jog/PID write is appended to `motion.jsonl` on the platform side.

## Quickstart — Docker (recommended)

```bash
git clone <repo>
cd radiotelescope
cp hardware/config.example.toml hardware/config.toml
cp platform/config.example.toml platform/config.toml
docker compose up
```

Open `http://localhost:8000/`. Only the platform is published; the hardware service stays on the internal bridge network.

No hardware plugged in? Skip the USB pass-through:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

The hardware service falls back to a disconnected/simulated state.

## Quickstart — bare metal

Two terminals (often on two different machines: the Pi runs the hardware service, a LAN host runs the platform):

```bash
# Terminal 1 — the Pi, RoboClaw + Airspy plugged in
cd hardware
pip install -e ".[dev]"
cp config.example.toml config.toml
rt-hardware -c config.toml          # binds 0.0.0.0:8001

# Terminal 2 — any LAN host
cd platform
pip install -e ".[dev]"
cp config.example.toml config.toml
# edit config.toml: hardware_url = "http://<pi-ip>:8001"
rt-platform -c config.toml          # binds 0.0.0.0:8000
```

Frontend hot reload:

```bash
cd platform/frontend
npm install
npm run dev                         # Vite at :5173, proxies /api → :8000
```

Pi serial-port access:

```bash
sudo usermod -aG dialout $USER      # then log out and back in
```

## Architecture

Two independently deployable Python services, no shared imports — they communicate only over HTTP/WebSocket.

### `hardware/` — `rt-hardware` (port 8001)

Owns the physical hardware. Trusted-network only: **no auth, no queue, no rate limiting**. Bind it to the Docker internal bridge or a LAN-restricted address.

| Module | Role |
|---|---|
| `hardware/roboclaw.py` | RoboClaw Packet Serial driver (M1 = azimuth, M2 = elevation) |
| `hardware/sdr.py` | LNA / bias-tee control via `airspy_gpio` |
| `services/roboclaw.py` | Telemetry polling, goto/jog state machine, encoder → alt/az → RA/Dec |
| `services/spectrum.py` | Spawns GNU Radio subprocess on demand, consumes spectra over ZeroMQ, EMA-integrates, broadcasts JSON frames |
| `sdr_pipeline.py` | GNU Radio top-block: Soapy → FFT → mag² → integrate → ZMQ pub. Run as a subprocess. |
| `geometry.py` / `pointing.py` | Encoder ↔ altitude and katpoint J2000 conversions |
| `models/state.py` | Canonical Pydantic response models — frontend types are generated from this |

### `platform/` — `rt-platform` (port 8000)

Web-facing. Enforces the queue, writes the motion audit log, serves the React SPA, and proxies every motor / spectrum / camera call to the hardware service.

| Module | Role |
|---|---|
| `services/queue.py` | Multi-user control lease, session cookies, per-IP caps, idle timeouts |
| `services/spectrum_bridge.py` | One upstream WS to hardware `/ws/spectrum`, fans frames out to browsers (lazy connect) |
| `services/hardware_client.py` | httpx wrapper bound to `hardware_url` |
| `api/routes_motor.py` | Proxies motor/telescope HTTP, bridges `/ws/roboclaw`, writes `motion.jsonl` |
| `api/routes_spectrum.py` | Proxies spectrum HTTP, bridges `/ws/spectrum` |
| `api/routes_camera.py` | Proxies camera MJPEG + status |
| `api/routes_queue.py`, `routes_feedback.py`, `routes_events.py` | Fully local — no hardware traffic |
| `api/auth.py` | Optional password gate (off by default) |

### Frontend (`platform/frontend/`)

Vite + React + TypeScript. `LiveShell.tsx` is the root. WebSocket clients live in `ws/`; the alt-az math in `lib/altaz.ts` is a hand-synced port of `hardware/geometry.py`. Types in `types.gen.ts` are regenerated from the hardware Pydantic models — re-run the dump script when models change:

```bash
cd hardware && python -m rt_hardware.scripts.dump_types
# Writes ../platform/frontend/src/types.gen.ts
```

## API reference

All browser traffic goes to the platform on **port 8000**. The hardware service on port 8001 is for the platform's internal use and should not be reachable from a browser.

### Access tiers

| Tier | How to qualify |
|---|---|
| **Public** | Anyone who can reach the platform |
| **Session** | Joined the queue (active session cookie). Viewer-level access. |
| **Control** | Currently holding the queue lease. Required for any motion or mutation. |
| **LAN admin** | Request originates from a LAN subnet. Used for homing / sync / PID. |

When the queue is disabled (`queue.enabled = false` — fine for single-user home setups), "Session" and "Control" collapse — everyone has control.

### Queue

| Method | Path | Description |
|---|---|---|
| GET | `/api/queue/config` | Turnstile keys, session limits, auth flags |
| GET | `/api/queue/status` | Your position and session state |
| POST | `/api/queue/join` | Join the queue |
| POST | `/api/queue/leave` | Leave and clear session cookie |
| WS | `/ws/queue` | Real-time queue state; inbound messages count as activity heartbeats |

### Motor / telescope

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | session | RoboClaw connection status |
| GET | `/api/roboclaw/status` | session | Live telemetry (position, speed, battery, temp) |
| GET | `/api/roboclaw/commands` | session | List available low-level RoboClaw commands |
| POST | `/api/roboclaw/commands/{command_id}` | control | Execute a raw RoboClaw command |
| POST | `/api/roboclaw/stop` | control | Emergency stop both motors |
| POST | `/api/telescope/jog` | control | Continuous directional jog (`direction`, `speed`, `token`, `seq`) |
| POST | `/api/telescope/jog/stop` | control | Stop an active jog |
| GET | `/api/telescope/goto` | session | Goto schema + current encoder mapping |
| POST | `/api/telescope/goto` | control | Slew to alt/az (`altitude_deg`, `azimuth_deg`, optional speed/accel/decel) |
| POST | `/api/telescope/goto_radec` | control | Slew to J2000 RA/Dec (`ra_deg`, `dec_deg`) |
| GET | `/api/telescope/config` | session | Beam FWHM, speed defaults, observer location, pointing limits |
| POST | `/api/telescope/sync` | LAN admin | Shift encoder zero so current position reads as given alt/az |
| POST | `/api/telescope/home/elevation` | LAN admin | Drive M2 down to hard stop, zero the encoder |
| POST | `/api/telescope/home/azimuth` | LAN admin | Zero the azimuth encoder at current position |
| POST | `/api/telescope/home/altitude` | LAN admin | Zero the altitude encoder at current position |
| GET | `/api/admin/pid` | LAN admin | Read live PID coefficients from the RoboClaw |
| POST | `/api/admin/pid` | LAN admin | Write PID coefficients (volatile) |
| POST | `/api/admin/pid/save` | LAN admin | Persist current PID to RoboClaw NVM |
| WS | `/ws/roboclaw` | session | Streamed `RoboClawTelemetry` JSON frames |

### Spectrum (SDR)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/spectrum/status` | session | SDR mode, LNA state, FFT config, frame stats |
| GET | `/api/spectrum/baseline` | session | Retrieve saved baseline spectrum |
| POST | `/api/spectrum/baseline` | control | Capture current frame as baseline |
| DELETE | `/api/spectrum/baseline` | control | Clear the saved baseline |
| POST | `/api/spectrum/reset` | control | Reset EMA integration accumulator |
| POST | `/api/spectrum/reconnect` | control | Force SDR receiver to close and re-open |
| WS | `/ws/spectrum` | session | Streamed FFT frames (Hann-windowed, EMA-integrated) |

### Camera

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/camera/status` | public | Whether the camera device is open |
| GET | `/api/camera/stream` | public | MJPEG multipart stream |

### Local (platform-only)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/feedback` | public | Submit a 1–5 star rating with optional text |
| POST | `/api/events` | public | Append a structured analytics event |

## Configuration

### `hardware/config.toml`

```toml
[roboclaw]
port = "/dev/ttyACM0"
connect_mode = "auto"       # "auto" falls back silently; "serial" requires a real device

[mount]
az_counts_per_degree  = 1000.0
alt_counts_per_degree = 1000.0
az_zero_count  = 0
alt_zero_count = 0
goto_speed_qpps = 10000
max_slew_deg_per_command = 45.0
# pointing_limit_altaz = [{altitude_deg=…, azimuth_deg=…}, …]
# altitude_calibration.points = [{counts=…, alt_deg=…}, …]

[observer]
latitude_deg = 51.5
longitude_deg = -0.1
dish_diameter_m   = 2.286
observing_freq_hz = 1.42e9

[sdr]
enabled = true
center_freq_hz = 1.4204e9
sample_rate_hz = 3.0e6      # Airspy Mini: 3e6 or 6e6 only
fft_size = 8192
integration_frames = 256
gain_db = 14
lna_bias_tee_enabled = false

[camera]
enabled = true
device = 0
fps = 15
```

### `platform/config.toml`

For a LAN-only deployment most of this can stay at defaults. The two settings that matter:

```toml
hardware_url = "http://<pi-ip>:8001"   # or "http://hardware:8001" in Docker

[queue]
enabled = false             # set true if multiple people will share control
```

If you turn the queue on:

```toml
[queue]
enabled = true
max_session_seconds  = 600
idle_timeout_seconds = 60
cookie_secret = "generate-something-random"
```

Other sections (`[server]`, `[auth]`, `[turnstile]`) only need touching if you're exposing the platform beyond your LAN — see the next section.

## Internet exposure (advanced, not recommended)

This stack is designed for **LAN use**. If you really want to put the platform on the public internet, the bare minimum:

- Terminate TLS at nginx / Caddy in front of the platform and forward `X-Forwarded-For` + `X-Forwarded-Proto`.
- Set a real `queue.cookie_secret`, real `cors_origins`, and either production Turnstile keys or enable `auth.enabled` with a real password.
- Never expose port 8001 (the hardware service). Public internet → platform only → hardware over the LAN.
- `rt-platform` runs `public_exposure_errors(cfg)` at startup and refuses to boot with placeholder secrets.

## Hardware notes (Raspberry Pi)

- **Motors**: RoboClaw 2×N over USB serial (Packet Serial, address 0x80, 38400 baud). M1 = azimuth, M2 = elevation. Encoders are the only position source — calibrate `az_counts_per_degree`, `alt_counts_per_degree`, and zero offsets before trusting goto.
- **SDR**: SoapySDR Airspy driver + GNU Radio. On the Pi: `sudo apt install soapysdr-module-airspy python3-soapysdr gnuradio gr-soapy python3-zmq` (none of these are on PyPI). Docker images already install them. Airspy Mini sample rate must be 3 Msps or 6 Msps.
- **Camera**: V4L2 device via OpenCV, configured under `[camera]`.

## Layout

```
hardware/                Pi-side service: motors, SDR, camera
  src/rt_hardware/
  config.example.toml
  Dockerfile
platform/                Web-facing service: UI, queue, proxy
  src/rt_platform/
  frontend/              Vite + React + TS
  config.example.toml
  Dockerfile
docker-compose.yml       Two-service stack
docker-compose.dev.yml   Overrides for laptop / no-hardware dev
deploy.sh                git pull + docker compose up -d --build
docs/separation-plan.md  Rationale for the two-service split
```

See [CLAUDE.md](CLAUDE.md) for deeper architecture notes.

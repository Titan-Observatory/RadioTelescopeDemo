# Radio Telescope

Two-service stack for controlling a RoboClaw-driven radio telescope with an Airspy SDR. The Raspberry Pi runs the **hardware** service (motors, SDR, camera); a web-facing **platform** service runs the React UI, the user queue, auth, and proxies all traffic to the hardware. They communicate over HTTP/WebSocket.

```
┌──────────────┐         ┌────────────────────────┐         ┌──────────────┐
│  Browser     │ ◀────▶  │  platform  (port 8000) │ ◀────▶  │  hardware    │
│  (Vite SPA)  │   HTTP  │  - queue, auth, UI     │   HTTP  │  (port 8001) │
│              │   WS    │  - proxies to hardware │   WS    │  motors+SDR  │
└──────────────┘         └────────────────────────┘         └──────────────┘
```

## Quickstart — Docker (default)

```bash
git clone <repo>
cd radiotelescope
cp hardware/config.example.toml hardware/config.toml
cp platform/config.example.toml platform/config.toml
docker compose up
```

The UI is on `http://localhost:8000/`. The hardware service is **not** published — it is only reachable from the platform container over the internal bridge network.

For development on a machine without the RoboClaw / SDR plugged in:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

This drops the `/dev/ttyACM0` USB pass-through and the hardware service falls back to a disconnected (simulated) state.

## Quickstart — bare metal

In two terminals:

```bash
# Terminal 1 — hardware service (Pi, or any host with the RoboClaw plugged in)
cd hardware
pip install -e ".[dev]"
cp config.example.toml config.toml
rt-hardware -c config.toml

# Terminal 2 — platform service (any web-facing host on the LAN)
cd platform
pip install -e ".[dev]"
cp config.example.toml config.toml
# edit config.toml: set hardware_url = "http://<pi-ip>:8001"
rt-platform -c config.toml
```

For frontend dev with hot reload:

```bash
cd platform/frontend
npm install
npm run dev          # Vite on :5173, proxies /api → platform on :8000
```

## Pi serial-port access

```bash
sudo usermod -aG dialout $USER   # then log out and back in
```

## Project layout

```
hardware/                Pi-side service: motors, SDR, camera
  src/rt_hardware/
  config.example.toml
  Dockerfile
  pyproject.toml

platform/                Web-facing service: UI, queue, auth, proxy
  src/rt_platform/
  frontend/              Vite + React + TS
  config.example.toml
  Dockerfile
  pyproject.toml

docker-compose.yml       Two-service stack (the default user experience)
docker-compose.dev.yml   Overrides for laptop / no-hardware dev
deploy.sh                git pull + docker compose up -d --build
docs/separation-plan.md  Rationale for the two-service split
```

## API reference

The platform proxies every hardware endpoint — browsers always talk to port 8000. The hardware service (port 8001) is for internal use only.

### Access tiers (platform only)

| Tier | Requirement | Endpoints |
|------|-------------|-----------|
| **Public** | None | `GET /api/queue/config`, `GET /api/telescope/config`, camera status/stream, `POST /api/feedback`, `POST /api/events` |
| **Queue session** | Active session cookie | All read-only motor/spectrum endpoints, `GET /api/health`, roboclaw/spectrum WS |
| **Control** | Must hold the queue lease | All motion/mutation endpoints (`goto`, `jog`, `stop`, spectrum writes) |
| **LAN admin** | Request from LAN subnet | `sync`, `home/*` |

### Queue

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/queue/config` | Turnstile keys, session limits, auth flags |
| GET | `/api/queue/status` | Your position and session state |
| POST | `/api/queue/join` | Join the queue (Turnstile token / beta password if configured) |
| POST | `/api/queue/leave` | Leave and clear session cookie |
| WS | `/ws/queue` | Real-time queue state; inbound messages count as activity heartbeats |

### Motor / telescope

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | session | RoboClaw connection status |
| GET | `/api/roboclaw/status` | session | Live telemetry (position, speed, battery, temp) |
| GET | `/api/roboclaw/commands` | session | List available low-level commands |
| POST | `/api/roboclaw/commands/{command_id}` | control | Execute a raw RoboClaw command |
| POST | `/api/roboclaw/stop` | control | Emergency stop both motors |
| POST | `/api/telescope/jog` | control | Continuous directional jog (`direction`, `speed`, `token`, `seq`) |
| POST | `/api/telescope/jog/stop` | control | Stop an active jog |
| GET | `/api/telescope/goto` | session | Describe the goto schema and current encoder mapping |
| POST | `/api/telescope/goto` | control | Slew to alt/az (`altitude_deg`, `azimuth_deg`, optional speed/accel/decel) |
| POST | `/api/telescope/goto_radec` | control | Slew to J2000 RA/Dec (`ra_deg`, `dec_deg`) |
| GET | `/api/telescope/config` | session | Beam FWHM, speed defaults, observer location, pointing limits |
| POST | `/api/telescope/sync` | LAN admin | Shift encoder zero so current position reads as given alt/az |
| POST | `/api/telescope/home/elevation` | LAN admin | Drive M2 down to hard stop then zero the encoder |
| POST | `/api/telescope/home/azimuth` | LAN admin | Zero the azimuth encoder at current position |
| POST | `/api/telescope/home/altitude` | LAN admin | Zero the altitude encoder at current position |
| WS | `/ws/roboclaw` | session | Streamed `RoboClawTelemetry` JSON frames |

### Spectrum (SDR)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/spectrum/status` | session | SDR mode, LNA state, FFT config, frame stats |
| GET | `/api/spectrum/baseline` | session | Retrieve saved baseline spectrum |
| POST | `/api/spectrum/baseline` | control | Capture current frame as the baseline |
| DELETE | `/api/spectrum/baseline` | control | Clear the saved baseline |
| POST | `/api/spectrum/reset` | control | Reset EMA integration accumulator |
| POST | `/api/spectrum/reconnect` | control | Force SDR receiver to close and re-open |
| POST | `/api/spectrum/lna` | control | Toggle bias-tee LNA (`{"enabled": true/false}`) |
| WS | `/ws/spectrum` | session | Streamed FFT frames (Hann-windowed, EMA-integrated) |

### Camera

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/camera/status` | public | Whether the camera device is open |
| GET | `/api/camera/stream` | public | MJPEG multipart stream |

### Platform-only

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/feedback` | public | Submit a 1–5 star rating with optional text |
| POST | `/api/events` | public | Append a structured analytics event (snake_case name, props) |

## Configuration

### Hardware (`hardware/config.toml`)

Key sections and fields:

```toml
[roboclaw]
port = "/dev/ttyACM0"
connect_mode = "auto"    # "auto" (falls back silently) or "serial" (required)

[mount]
az_counts_per_degree = 1000.0
alt_counts_per_degree = 1000.0
az_zero_count = 0
alt_zero_count = 0
goto_speed_qpps = 10000
max_slew_deg_per_command = 45.0
# Optional: pointing_limit_altaz = [{altitude_deg=…, azimuth_deg=…}, …]
# Optional: altitude_calibration.points = [{counts=…, alt_deg=…}, …]

[observer]
latitude_deg = 51.5
longitude_deg = -0.1
dish_diameter_m = 2.286
observing_freq_hz = 1.42e9

[sdr]
enabled = true
center_freq_hz = 1.4204e9
sample_rate_hz = 3.0e6   # Airspy Mini: 3e6 or 6e6 only
fft_size = 8192
integration_frames = 256
gain_db = 14
lna_bias_tee_enabled = false

[camera]
enabled = true
device = 0
fps = 15
```

### Platform (`platform/config.toml`)

```toml
hardware_url = "http://<pi-ip>:8001"   # or "http://hardware:8001" in Docker

[server]
lan_only = false          # true locks all routes to LAN IPs
cors_origins = ["*"]
trusted_proxies = ["127.0.0.1", "::1"]

[queue]
enabled = true
max_session_seconds = 600
idle_timeout_seconds = 60
cookie_secret = "change-me-in-config"

[auth]
enabled = false           # optional beta-access password gate

[turnstile]
enabled = true
site_key = ""
secret_key = ""
```

## Internet exposure

The platform has a public-view / queued-control model: visitors may see the live dashboard, but mutating endpoints require the active queue lease. Operator endpoints (homing, sync) remain LAN-admin-only.

For an internet-facing deployment of the **platform** (the **hardware** service must never be exposed publicly):

- Run TLS at nginx / Caddy in front of the platform and forward `X-Forwarded-For` + `X-Forwarded-Proto`.
- Set `server.lan_only = false`, configure real `cors_origins`, generate a real `queue.cookie_secret`, and set production Turnstile keys (or enable `auth.enabled` with a real `secret_key`).
- `rt-platform` runs `public_exposure_errors(cfg)` at startup and refuses to boot with placeholder secrets.

## Type generation

Run this when Pydantic models in `rt_hardware/models/state.py` change:

```bash
cd hardware && python -m rt_hardware.scripts.dump_types
# Writes ../platform/frontend/src/types.gen.ts
```

## Hardware notes (Raspberry Pi)

- **Motors**: RoboClaw 2×N over USB serial (Packet Serial, address 0x80, 38400 baud). M1 = azimuth, M2 = elevation. Encoders are the only position source — calibrate `az_counts_per_degree`, `alt_counts_per_degree`, and zero offsets.
- **SDR**: SoapySDR Airspy driver. Install on the Pi with `sudo apt install soapysdr-module-airspy python3-soapysdr` (not on PyPI). Airspy Mini sample rate must be 3 Msps or 6 Msps. Docker already installs these.
- **Camera**: V4L2 device via OpenCV, configured under `[camera]`.

See [CLAUDE.md](CLAUDE.md) for deeper architecture notes.

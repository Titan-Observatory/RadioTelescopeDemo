# RoboClaw Controller

FastAPI backend and React web UI for controlling a RoboClaw motor controller over USB packet serial. The app can start without hardware by falling back to a simulator, which makes it useful for iterative UI and command workflow development.

## System Requirements

```bash
# RoboClaw USB serial usually appears as /dev/ttyACM0 or /dev/ttyUSB0.
# Add the app user to dialout for serial-port access, then log out and back in.
sudo usermod -aG dialout $USER
```

## Install

```bash
python -m venv .env
source .env/bin/activate
pip install -e .[dev]

cd frontend
npm install
```

## Run

Backend:

```bash
radiotelescope -c config.toml
```

Frontend dev server:

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173/`. For a production build, run `npm run build`; the FastAPI app serves `frontend/dist` from `/`.

## Internet Exposure

The app has a public-view/queued-control model: visitors may see the live
dashboard, but mutating control endpoints require the active queue lease.
Operator endpoints such as homing and sync remain LAN-admin-only.

For an internet-facing deployment:

- Run the public TLS endpoint at nginx/Caddy and forward
  `X-Forwarded-For` plus `X-Forwarded-Proto` to the FastAPI process.
- Set `[server].trusted_proxies` to only the immediate reverse proxy IPs.
- Set `[server].cors_origins` to the exact HTTPS origin, not `["*"]`.
- Set `[queue].enabled = true`, configure production Turnstile keys, and
  replace all `CHANGE-ME` secrets.
- Keep a `gateway-server` Pi reachable only from the web host on the LAN.

When `[server].host` is `0.0.0.0` or `::` and `lan_only = false`, startup
fails if the public safety settings above are incomplete.

## Configuration

```toml
[roboclaw]
port = "/dev/ttyACM0"
baudrate = 38400
address = 0x80
timeout_s = 0.25
connect_mode = "auto" # auto, serial, simulated

[telemetry]
update_rate_hz = 5

[terminal]
enabled = true
# shell = "powershell.exe" # Windows
# shell = "/bin/bash"      # Linux/Raspberry Pi
```

`auto` tries the serial RoboClaw first and falls back to the simulator. `serial` reports an error mode if the port cannot be opened. `simulated` never touches hardware.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | App status and connection mode |
| `GET` | `/api/roboclaw/status` | Latest telemetry snapshot |
| `GET` | `/api/roboclaw/commands` | Operator command registry |
| `POST` | `/api/roboclaw/commands/{command_id}` | Execute an operator command |
| `POST` | `/api/roboclaw/stop` | Stop M1 and M2 |
| `WS` | `/ws/roboclaw` | Live telemetry stream |
| `WS` | `/ws/terminal` | Browser terminal connected to the host shell |

The browser terminal executes commands on the machine running the backend. Keep the server on a trusted network or disable `[terminal].enabled` when not needed.

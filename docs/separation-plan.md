# Hardware / Platform Separation Plan

## Goal

Split the single `radiotelescope` Python package into two independently deployable services that live together in a monorepo. The average open-source user runs both with `docker compose up` and never thinks about the distinction. A multi-telescope deployment runs one hardware instance per Pi and one platform instance that connects to all of them.

The `mode` config field — and every `if mode == ...` branch that flows from it — is deleted entirely. Each service has one job and always does that job.

---

## New Repository Layout

```
RadioTelescope/
├── hardware/                  ← Pi-side service (motors, SDR, camera)
│   ├── src/rt_hardware/
│   │   ├── api/               ← routes_roboclaw, routes_spectrum, routes_camera
│   │   ├── hardware/          ← roboclaw.py, sdr.py, host_stats.py
│   │   ├── models/            ← state.py (Pydantic response models, source of truth)
│   │   ├── safety/            ← interlocks.py
│   │   ├── services/          ← roboclaw.py, spectrum.py, _pubsub.py, _sdr_task.py
│   │   ├── geometry.py        ← server-side coordinate math
│   │   ├── pointing.py        ← katpoint antenna / coordinate conversions
│   │   ├── config.py          ← hardware-only config (RoboClaw, SDR, mount, camera, observer)
│   │   └── main.py            ← single-purpose FastAPI app, no branching
│   ├── config.example.toml
│   ├── Dockerfile
│   └── pyproject.toml
│
├── platform/                  ← Web-facing service (UI, queue, auth, proxy)
│   ├── src/rt_platform/
│   │   ├── api/               ← routes_motor, routes_spectrum_proxy, routes_camera_proxy,
│   │   │                         routes_queue, routes_feedback, routes_events, auth
│   │   ├── services/          ← queue.py, spectrum_bridge.py, hardware_client.py
│   │   ├── config.py          ← platform-only config (server, queue, auth, turnstile, hardware URL)
│   │   └── main.py            ← single-purpose FastAPI app, no branching
│   ├── frontend/              ← Vite React app (moved from repo root)
│   ├── config.example.toml
│   ├── Dockerfile
│   └── pyproject.toml
│
├── docker-compose.yml         ← runs both services; the default user experience
├── docker-compose.dev.yml     ← overrides for local development without hardware
└── README.md
```

The `tests/` directory splits the same way: `hardware/tests/` covers the hardware service (motor mocking, safety, spectrum), and `platform/tests/` covers the platform (queue, auth, proxy behaviour).

---

## What Each Service Owns

### Hardware service

Knows about physical hardware and nothing else. Accepts commands, returns telemetry. Has no concept of users, sessions, or queues. Runs on the Raspberry Pi (or locally during development with `connect_mode = "simulated"`).

**Keeps:**
- `hardware/roboclaw.py`, `hardware/sdr.py`, `hardware/host_stats.py`
- `services/roboclaw.py`, `services/spectrum.py`, `services/_pubsub.py`, `services/_sdr_task.py`
- `safety/interlocks.py`
- `geometry.py`, `pointing.py`
- `models/state.py` — Pydantic response models. The hardware service is the canonical source of these types; the platform derives its TypeScript types from the hardware's OpenAPI spec.
- `api/routes_roboclaw.py`, `api/routes_spectrum.py`, `api/routes_camera.py`

**Drops:**
- `HardwareConfig.mode` — gone. The hardware service always runs in "hardware mode".
- `hardware/remote.py` — this was the proxy client; it moves to the platform.
- `services/spectrum_bridge.py` — belongs to the platform.
- `services/queue.py`, `api/routes_queue.py`
- `api/auth.py`, `api/client_allowlist.py`, `api/security_headers.py`
- `api/routes_feedback.py`, `api/routes_events.py`
- `api/routes_camera_proxy.py`, `api/routes_spectrum_proxy.py`
- `scripts/dump_types.py` — replaced by `openapi-typescript` (see Type Generation below)
- All frontend code

**Auth posture:** none. The hardware service binds to its configured host and trusts the network. In Docker Compose this means it is only reachable by the platform over an internal bridge network, not from the outside. In a bare-metal deployment the operator is responsible for firewall rules (same as today's Pi running in gateway-server mode).

### Platform service

Knows about users and knows where the hardware is. Enforces the queue before forwarding control commands. Serves the web UI. Has no Python imports from the hardware service — it communicates exclusively over HTTP and WebSockets.

**Keeps:**
- `services/queue.py` — unchanged
- `services/spectrum_bridge.py` — subscribes to the hardware's `/ws/spectrum`, fans frames to browser clients
- `api/routes_queue.py`, `api/routes_feedback.py`, `api/routes_events.py`
- `api/auth.py`, `api/client_allowlist.py`, `api/security_headers.py`, `api/dependencies.py`
- All frontend code

**Renamed/restructured:**
- `hardware/remote.py` → `services/hardware_client.py`. The `RemoteRoboClawClient` and related async HTTP helpers become a typed client class that wraps every hardware endpoint. The platform's motor routes call this client instead of using a local service instance.
- `api/routes_roboclaw.py` → `api/routes_motor.py`. The route implementations are unchanged — they still enforce `require_control`, call the client, and return the same JSON. The only difference is that the client is always the remote one; there is no conditional.
- `api/routes_camera_proxy.py` → `api/routes_camera.py`. Becomes the only camera routes file in the platform — no "proxy" suffix needed because proxying is always what happens.
- `api/routes_spectrum_proxy.py` → `api/routes_spectrum.py`. Same reasoning.

**Drops:**
- `HardwareConfig` — replaced by a single `hardware_url: str` field in the platform config.
- `services/roboclaw.py` (the local service) — the platform no longer starts a motor service; it always talks over HTTP.
- `services/spectrum.py` (the local FFT pipeline) — the hardware runs it; the platform only bridges the WebSocket output.
- `geometry.py`, `pointing.py` — coordinate math lives in the hardware service where `goto_radec` is implemented.
- `models/state.py` — the platform does not vendor the Pydantic models; it generates TypeScript types from the hardware's OpenAPI spec and uses those for the frontend (see Type Generation below).

---

## Removing the Branching

### In `main.py`

Today's `main.py` has three separate control flows gated on `mode`. The new files have none.

**`hardware/main.py`** (simplified to its essence):

```python
@asynccontextmanager
async def lifespan(app):
    client = make_client(cfg.roboclaw)           # always local serial/USB
    service = RoboClawService(client, ...)
    spectrum = SpectrumService(SDRReceiver(cfg.sdr), cfg.sdr) if cfg.sdr.enabled else None
    await service.start()
    if spectrum: await spectrum.start()
    yield
    if spectrum: await spectrum.stop()
    await service.stop()

def create_app():
    app = FastAPI(title="RT Hardware", lifespan=lifespan)
    app.include_router(routes_roboclaw.router)
    app.include_router(routes_spectrum.router)
    app.include_router(routes_camera.router)
    return app
```

No middleware stack, no frontend serving, no conditional route registration.

**`platform/main.py`** (simplified to its essence):

```python
@asynccontextmanager
async def lifespan(app):
    queue = QueueService(...)
    bridge = SpectrumBridge(cfg.hardware_url) if cfg.sdr_bridge_enabled else None
    await queue.start()
    if bridge: await bridge.start()
    yield
    if bridge: await bridge.stop()
    await queue.stop()

def create_app():
    app = FastAPI(title="RT Platform", lifespan=lifespan)
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(ClientAllowlistMiddleware, ...)
    app.add_middleware(PasswordAuthMiddleware, ...)
    app.include_router(auth_router)
    app.include_router(routes_motor.router)    # proxies to hardware, enforces queue
    app.include_router(routes_spectrum.router) # bridges /ws/spectrum, proxies HTTP
    app.include_router(routes_camera.router)   # proxies to hardware
    app.include_router(routes_queue.router)
    app.include_router(routes_feedback.router)
    app.include_router(routes_events.router)
    # mount frontend dist
    return app
```

No `mode` checks, no optional service instantiation, no gateway/local branching.

### In `config.py`

**`hardware/config.py`** contains: `RoboClawConfig`, `TelemetryConfig`, `ObserverConfig`, `MountConfig`, `CameraConfig`, `SDRConfig`, `GeneralConfig`, and a lean `AppConfig` that composes only these. The `HardwareConfig` class (the one with the `mode` field) is deleted entirely.

**`platform/config.py`** contains: `ServerConfig`, `QueueConfig`, `AuthConfig`, `TurnstileConfig`, `GeneralConfig`, and a lean `AppConfig`. The hardware connection is a single string:

```toml
hardware_url = "http://hardware:8001"    # Docker default
# hardware_url = "http://10.0.0.10:8001" # bare-metal example
```

`hardware_url` replaces all of `HardwareConfig` (`gateway_host`, `gateway_port`, `mode`, `base_url`, `ws_base_url`).

---

## Docker Compose

The `docker-compose.yml` at the repo root is the primary user-facing entry point. It defines two services on an internal network:

```yaml
services:
  hardware:
    build: ./hardware
    restart: unless-stopped
    devices:
      - /dev/ttyACM0:/dev/ttyACM0   # RoboClaw USB serial
    volumes:
      - ./hardware/config.toml:/app/config.toml:ro
    networks:
      - internal

  platform:
    build: ./platform
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - HARDWARE_URL=http://hardware:8001
    volumes:
      - ./platform/config.toml:/app/config.toml:ro
      - ./platform/feedback.jsonl:/app/feedback.jsonl
      - ./platform/events.jsonl:/app/events.jsonl
      - ./platform/passwords.txt:/app/passwords.txt:ro
    depends_on:
      - hardware
    networks:
      - internal

networks:
  internal:
    driver: bridge
```

The hardware service is not published on any host port. It is only reachable from the platform container over the `internal` network. From the outside, only port 3000 is exposed. Users with SDR hardware attached will need to pass the correct device node; users without hardware set `connect_mode = "simulated"` in the hardware config and the rest works normally.

`docker-compose.dev.yml` overrides `connect_mode` to `simulated` and disables the camera so that development works on any machine without a Pi.

---

## Type Generation

This migration is a natural moment to close technical debt finding #1 from the audit.

The hardware service is the canonical source of Pydantic models. When it starts, FastAPI auto-generates a complete OpenAPI 3.1 spec at `/openapi.json`. The platform's frontend build pipeline generates TypeScript types directly from this spec:

```json
// platform/frontend/package.json
"scripts": {
  "sync-types": "openapi-typescript http://localhost:8001/openapi.json -o src/types.gen.ts",
  "build": "npm run sync-types && vite build"
}
```

`dump_types.py` is deleted. `QueueConfig` in `queue.ts` is replaced by the generated type (once `QueueConfigResponse` is added to `routes_queue.py`'s response annotation, which it already is). The `EXPORTED_MODELS` maintenance burden disappears.

For CI or offline builds, commit the hardware service's `openapi.json` to the platform repo and point `openapi-typescript` at the file instead of the live server.

---

## Development Workflow

Without Docker, run both servers in separate terminals:

```bash
# Terminal 1 — hardware service (simulated hardware, no Pi needed)
cd hardware
pip install -e ".[dev]"
rt-hardware -c config.dev.toml     # connect_mode = "simulated"

# Terminal 2 — platform + frontend dev server
cd platform
pip install -e ".[dev]"
rt-platform -c config.dev.toml    # hardware_url = "http://localhost:8001"
cd frontend && npm run dev         # Vite at :5173, proxies API to :3000
```

`config.dev.toml` files ship in each package with safe defaults for local development. They are gitignored like `config.toml`.

---

## What Gets Deleted

Removing the branching eliminates more code than the split adds:

| Deleted | Reason |
|---|---|
| `HardwareConfig` with `mode` field | No longer needed; each app has one mode |
| `hardware/remote.py` (from hardware pkg) | Moves to platform as `services/hardware_client.py` |
| All `if mode == ...` blocks in `main.py` | Both apps are unconditional |
| `api/routes_camera_proxy.py` | Becomes `platform/api/routes_camera.py`; "proxy" is implicit |
| `api/routes_spectrum_proxy.py` | Same |
| `scripts/dump_types.py` | Replaced by `openapi-typescript` |
| `frontend/src/queue.ts` `QueueConfig` hand-written block | Generated from OpenAPI |
| The `mode != "gateway-server"` guard on feedback/events routes | Platform always serves them |
| The gateway-server headless index route | Hardware's index can just return its OpenAPI URL |
| `HostStats` wrong-machine bug (audit #11) | Hardware reads its own `/proc`; platform never reads host stats |

---

## Migration Order

The migration is cleanest done in this sequence so the service stays deployable at each step:

1. **Add `QueueConfigResponse` to `routes_queue.py`'s response annotation** and verify the OpenAPI spec includes it. This unblocks the type generation switch.

2. **Switch `sync-types` to `openapi-typescript`** in `frontend/package.json`. Delete `dump_types.py`. Commit. This pays off audit finding #1 independently of the split.

3. **Create the `hardware/` and `platform/` top-level directories** and copy files into position according to the layout above. Keep the old `src/radiotelescope/` package intact and working during this step — do not delete it yet.

4. **Write `hardware/main.py`** — the unconditional hardware app. Run it with `connect_mode = "simulated"` and confirm `/openapi.json` looks correct.

5. **Write `platform/main.py`** — the unconditional platform app pointing at the hardware service. Confirm the frontend loads and queue operations work.

6. **Write `docker-compose.yml`** and verify the full stack comes up with `docker compose up`.

7. **Delete `src/radiotelescope/`** and update `pyproject.toml` at the repo root (or remove it, since each subpackage now has its own).

8. **Update `deploy.sh`** to build and restart both Docker services instead of managing the Python process directly.

9. **Update `README.md`** with the new quickstart (`docker compose up`) and the bare-metal instructions.

---

## Audit Items Resolved by This Migration

The separation directly closes several findings from `audits/technical-debt.md` without extra effort:

- **#1** `dump_types.py` → replaced by `openapi-typescript`
- **#2** `QueueConfig` hand-written → generated from OpenAPI
- **#7** `deploy.sh` doesn't regenerate types → Docker build always runs `sync-types`
- **#11** `HostStats` reports wrong machine → hardware reads its own stats, always correct

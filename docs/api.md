# API map

The browser talks to the platform service. The platform service is the public
edge: it serves the frontend, owns queue/auth policy, and proxies hardware
requests to the private hardware service.

```text
Browser -> Platform API -> Hardware API -> telescope hardware
```

Do not expose the hardware service directly to the internet. Its routes are
intended for the trusted telescope network; the platform applies the access
checks described below.

## Access levels

| Level | Meaning |
|---|---|
| Public | Reachable before joining the queue. |
| Queue session | Caller has a valid queue session cookie. Used for queue lease updates while waiting or controlling. |
| Active queue session | Caller owns the active queue lease, or is a LAN admin. Required for live hardware reads and WebSocket streams. |
| Active controller | Caller owns the active queue lease, or is a LAN admin. Required for telescope/observation mutations and also refreshes command activity. |
| LAN admin | Caller IP is in the platform `server.allowed_clients` allowlist. Used for local-only hardware maintenance routes. |

If password auth is enabled, most HTTP and WebSocket paths also require the
signed `rt_auth` cookie. `/`, static assets, `/api/queue/config`, and
`/api/queue/join` are exempt from that global password middleware.

## Platform API

Base URL in local Docker/dev examples: `http://localhost:8000`.

### Queue and session

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/queue/config` | Public | Queue/auth bootstrap data plus operator telescope status. |
| `GET` | `/api/queue/status` | Public | Queue status for the caller's queue cookie, or not-in-queue status. |
| `POST` | `/api/queue/join` | Public | Join or rejoin the queue. Sets the queue session cookie. |
| `POST` | `/api/queue/leave` | Public | Leave the queue and clear the queue cookie. |
| `WS` | `/ws/queue` | Queue session | Queue lease updates. Any inbound message is treated as user activity. |

`POST /api/queue/join` body:

```json
{
  "turnstile_token": "optional Cloudflare Turnstile token",
  "beta_password": "optional beta access password"
}
```

Queue status shape:

```json
{
  "token": "session token",
  "is_active": true,
  "position": 0,
  "queue_length": 0,
  "lease_remaining_s": 120,
  "idle_remaining_s": 30,
  "has_active_user": true
}
```

### Telescope and mount control

These platform routes proxy the same hardware paths and add queue/LAN gates.

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/roboclaw/status` | Active queue session | Latest mount telemetry and host stats. |
| `GET` | `/api/roboclaw/commands` | Active queue session | Operator-safe RoboClaw command catalog. |
| `POST` | `/api/roboclaw/commands/{command_id}` | Active controller | Execute an operator-safe low-level command. |
| `POST` | `/api/roboclaw/stop` | Active controller | Stop both motors. |
| `POST` | `/api/telescope/jog` | Active controller | Start or refresh a jog command. |
| `POST` | `/api/telescope/jog/stop` | Active controller | Stop a jog sequence. |
| `GET` | `/api/telescope/config` | Active queue session | Observer location, beam width, goto defaults, and safety limits. |
| `POST` | `/api/telescope/goto` | Active controller | Slew to altitude/azimuth. |
| `POST` | `/api/telescope/goto_radec` | Active controller | Convert RA/Dec to alt/az and slew. |
| `POST` | `/api/telescope/home/elevation` | LAN admin | Drive elevation downward until counts stall, then zero M2. |
| `WS` | `/ws/roboclaw` | Active queue session | Live mount telemetry stream. |

Motion request bodies:

```json
{
  "altitude_deg": 45.0,
  "azimuth_deg": 180.0,
  "speed_qpps": 12000,
  "accel_qpps2": 12000,
  "decel_qpps2": 12000
}
```

```json
{
  "ra_deg": 83.633,
  "dec_deg": 22.0145,
  "speed_qpps": 12000,
  "accel_qpps2": 12000,
  "decel_qpps2": 12000
}
```

```json
{
  "token": "client-generated jog token",
  "seq": 0,
  "direction": "west",
  "speed": 80
}
```

`direction` is one of `west`, `east`, `up`, or `down`. Motion responses use
the `CommandResult` shape:

```json
{
  "command_id": "speed_accel_decel_position_m1m2",
  "ok": true,
  "response": {},
  "error": null
}
```

### Hydrogen-line spectrum

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/spectrum/status` | Active queue session | SDR/LNA/pipeline status. Returns a structured disconnected fallback if the hardware gateway is unavailable. |
| `POST` | `/api/spectrum/baseline` | Active controller | Capture and apply a spectrum baseline. |
| `POST` | `/api/spectrum/reset` | Active controller | Flush the rolling integration by restarting processing. |
| `POST` | `/api/spectrum/reconnect` | Active controller | Kill and respawn the SDR pipeline. |
| `WS` | `/ws/spectrum` | Active queue session | Live spectrum frames. |

### GOES observation mode

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/observation` | Active queue session | Current hardware observation mode and GOES satellite look angles. Falls back to degraded hydrogen-line mode if hardware is unreachable. |
| `GET` | `/api/goes/status` | Active queue session | GOES demod/decode status. |
| `POST` | `/api/goes/reconnect` | Active controller | Restart the GOES receive chain. |
| `GET` | `/api/goes/products?limit=60` | Active queue session | List decoded product metadata. `limit` is clamped by hardware to 1..500. |
| `GET` | `/api/goes/products/{product_id}/file` | Active queue session | Binary product file passthrough. |
| `WS` | `/ws/goes` | Active queue session | Live GOES acquisition/status frames. |

GOES product list shape:

```json
{
  "total": 12,
  "products": [
    {
      "id": "product id",
      "kind": "image",
      "name": "filename.png",
      "group": "images/goes19/2026-06-12",
      "size_bytes": 123456,
      "created_at": 1781294400.0,
      "media_type": "image/png",
      "preview": null
    }
  ]
}
```

### Camera

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/api/camera/status` | Public | Camera availability and label. Returns a disabled fallback if hardware is unavailable. |
| `GET` | `/api/camera/frame` | Public | Single no-store JPEG frame. |

### Feedback and analytics

| Method | Path | Access | Description |
|---|---|---|---|
| `POST` | `/api/feedback` | Public | Append a feedback record. |
| `POST` | `/api/events` | Public | Append a frontend analytics event. Returns 204. |

Feedback body:

```json
{
  "rating": 5,
  "message": "Optional text, max 2000 chars"
}
```

Analytics event body:

```json
{
  "event": "snake_case_event",
  "session_id": "frontend session id",
  "ts_client": "client timestamp",
  "is_active_controller": true,
  "queue_position": 0,
  "viewport_w": 1440,
  "viewport_h": 900,
  "device_class": "desktop",
  "page_path": "/",
  "props": {}
}
```

Event names must be snake_case and `props` is capped at 4 KB serialized.

### Runtime frontend config

| Method | Path | Access | Description |
|---|---|---|---|
| `GET` | `/rt-env.js` | Public | JavaScript assignment containing public frontend runtime config. Not included in the OpenAPI schema. |

## Hardware API

Base URL in Docker is internal to the compose network. In local development it
is typically the `hardware_url` configured by the platform.

The hardware routes mirror the proxied platform routes but do not enforce
queue/auth policy. They are useful for local hardware diagnostics and for
understanding platform proxy responses.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Service identity and basic status. |
| `GET` | `/api/health` | RoboClaw connection health. |
| `GET` | `/api/roboclaw/status` | Latest `RoboClawTelemetry`. |
| `GET` | `/api/roboclaw/commands` | Low-level operator command catalog. |
| `POST` | `/api/roboclaw/commands/{command_id}` | Execute an operator-safe command with `{ "args": { ... } }`. |
| `POST` | `/api/roboclaw/stop` | Stop both motors. |
| `POST` | `/api/telescope/jog` | Start or refresh a jog sequence. |
| `POST` | `/api/telescope/jog/stop` | Stop a jog sequence. |
| `POST` | `/api/telescope/goto` | Slew to alt/az, with safety and pointing-limit checks. |
| `POST` | `/api/telescope/goto_radec` | Convert RA/Dec to alt/az and slew. |
| `GET` | `/api/telescope/config` | Mount/observer/safety config exposed to clients. |
| `POST` | `/api/telescope/home/elevation` | Home and zero elevation. |
| `WS` | `/ws/roboclaw` | Live mount telemetry. |
| `GET` | `/api/spectrum/status` | SDR/LNA/pipeline status. |
| `POST` | `/api/spectrum/baseline` | Capture baseline. |
| `DELETE` | `/api/spectrum/baseline` | Clear baseline. |
| `POST` | `/api/spectrum/reset` | Reset spectrum integration. |
| `POST` | `/api/spectrum/reconnect` | Restart SDR pipeline. |
| `WS` | `/ws/spectrum` | Live spectrum frames. |
| `GET` | `/api/observation` | Current observation mode and GOES satellite look angles. |
| `GET` | `/api/goes/status` | GOES receive-chain status. |
| `POST` | `/api/goes/reconnect` | Restart GOES receive chain. |
| `GET` | `/api/goes/products?limit=60` | List decoded GOES products. |
| `GET` | `/api/goes/products/{product_id}/file` | GOES product file. |
| `WS` | `/ws/goes` | Live GOES status frames. |
| `GET` | `/api/camera/status` | Camera status. |
| `GET` | `/api/camera/frame` | Single JPEG frame. |
| `GET` | `/api/camera/stream` | MJPEG stream. |

## Schemas and source files

Most shared telemetry and command schemas live in
`hardware/src/rt_hardware/models/state.py`. Platform-only queue schemas live
in `platform/src/rt_platform/services/queue.py`.

The frontend consumes TypeScript copies in `platform/frontend/src/types.ts`.
When API model shapes change, keep those frontend types in sync with the
Python models.

Relevant route files:

| Surface | Platform | Hardware |
|---|---|---|
| Queue/auth | `platform/src/rt_platform/api/routes_queue.py`, `auth.py` | n/a |
| Telescope/motor | `platform/src/rt_platform/api/routes_motor.py` | `hardware/src/rt_hardware/api/routes_roboclaw.py` |
| Spectrum | `platform/src/rt_platform/api/routes_spectrum.py` | `hardware/src/rt_hardware/api/routes_spectrum.py` |
| GOES | `platform/src/rt_platform/api/routes_goes.py` | `hardware/src/rt_hardware/api/routes_goes.py` |
| Camera | `platform/src/rt_platform/api/routes_camera.py` | `hardware/src/rt_hardware/api/routes_camera.py` |
| Feedback/events | `platform/src/rt_platform/api/routes_feedback.py`, `routes_events.py` | n/a |

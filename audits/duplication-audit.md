# Code Duplication Audit — `radiotelescope`

Scope: `src/radiotelescope/**/*.py`, `frontend/src/**/*.{ts,tsx}`, `frontend/src/styles/main.css`.
Skipped per brief: `node_modules`, build output, `*.log`, `events.jsonl`, `passwords.txt`.

All line numbers are 1-based against the files in the working tree at audit time.

## Summary

| # | Finding | Category | Importance | Effort |
|---|---|---|---|---|
| 1 | `Pydantic models in models/state.py` mirror `TypeScript interfaces in types.ts` 1:1 | STRUCTURAL / DATA | 8 | M |
| 2 | `_put_latest` drop-oldest pub/sub repeated across 3+ services | EXACT | 7 | S |
| 3 | SDR receiver `start` / `stop` / `reconnect` lifecycle duplicated between `SpectrumService` and `IQPublisher` | NEAR | 8 | M |
| 4 | Triangle-in-pointing-limits + azimuth normalise/unwrap implemented twice (Python + TS) | NEAR / STRUCTURAL | 7 | M |
| 5 | `AltAzLimitPoint` (config) ≡ `AltAzPoint` (state) — two Pydantic models with identical fields & validators | EXACT | 5 | S |
| 6 | Hydrogen-line rest frequency `1420.4058` MHz literal repeated in 3+ files; also in `SDRConfig.center_freq_hz` default | DATA | 4 | S |
| 7 | `queue.ts` re-implements `request<T>()` fetch/error pattern that `api.ts` already exports | NEAR | 5 | S |
| 8 | `goto*` API methods in `api.ts` duplicate the `{speed_qpps, accel_qpps2, decel_qpps2}` payload shape; `accel_qpps2` is silently passed as `decel_qpps2` in both | NEAR | 4 | S |
| 9 | Per-axis `speed/accel/decel` resolve-fallback ladder repeated 6× in `_execute_goto_altaz` | EXACT-ish | 4 | S |
| 10 | WebSocket boilerplate (`protocol = ... 'wss:' : 'ws:'` + open/close/error handlers) repeated in 3 effects | NEAR | 6 | S |
| 11 | `gaussianLine` and `gaussianFill` in `QueuePage.tsx` share their entire sampling loop | EXACT | 2 | S |
| 12 | Raw `#0b0d16` (== `--bg`) and `#ffbc42`/`#9b9ece` family hex literals in CSS rules instead of `var(--…)` | DATA | 3 | S |

Total findings: 12. Net duplicated code footprint ≈ 350–450 lines.

---

## 1. Pydantic ↔ TypeScript model duplication

**Category:** STRUCTURAL / DATA. **Importance:** 8 / 10. **Effort:** M.

Every Pydantic response model in `src/radiotelescope/models/state.py` has a hand-maintained twin in `frontend/src/types.ts`. They are field-for-field identical with the field names re-typed in TS — a classic source of silent drift when only one side is updated.

Pairs (Python `file:line` ↔ TS `file:line`):

- `ConnectionStatus` `models/state.py:12` ↔ `types.ts:4`
- `MotorSnapshot` `models/state.py:21` ↔ `types.ts:13`
- `HostStats` `models/state.py:34` ↔ `types.ts:26` (12 mirrored fields)
- `PollStats` `models/state.py:49` ↔ `types.ts:41`
- `RoboClawTelemetry` `models/state.py:55` ↔ `types.ts:47` (20 mirrored fields)
- `CommandArg` `models/state.py:77` ↔ `types.ts:97`
- `CommandInfo` `models/state.py:86` ↔ `types.ts:106`
- `CommandResult` `models/state.py:109` ↔ `types.ts:117`
- `AltAzPoint` `models/state.py:116` ↔ `types.ts:79`
- `TelescopeConfig` `models/state.py:121` ↔ `types.ts:69`
- `ConnectionMode` / `ArgType` literal unions `models/state.py:8-9` ↔ `types.ts:1-2`

Footprint: ~110 LOC of duplicated declarations in `types.ts` against ~140 LOC in `state.py`; ~75% of `types.ts` is mirrored.

**Suggested fix:** generate `types.ts` from a JSON Schema export of the Pydantic models. Add a `python -m radiotelescope.scripts.dump_schemas` step that calls `AppModel.model_json_schema()` for each response model, pipe through `json-schema-to-typescript` (already widely available in npm). Wire it into a `frontend/scripts/sync-types.mjs` and add a CI check that `git diff --exit-code types.ts`.

Minimal drop-in (one-off helper, no new build step required) — replace the hand-written interfaces with a small Pydantic codegen:

```python
# src/radiotelescope/scripts/dump_openapi.py
"""python -m radiotelescope.scripts.dump_openapi > frontend/openapi.json"""
import json, sys
from radiotelescope.main import build_app
from radiotelescope.config import AppConfig
app = build_app(AppConfig())
json.dump(app.openapi(), sys.stdout, indent=2)
```

Then `npx openapi-typescript frontend/openapi.json -o frontend/src/types.gen.ts` and re-export from `types.ts`.

---

## 2. `_put_latest` drop-oldest pub/sub helper repeated

**Category:** EXACT. **Importance:** 7 / 10. **Effort:** S.

Same 8-line drop-oldest enqueue helper is defined three times:

- `src/radiotelescope/services/spectrum.py:222-230` (`_put_latest` for `SpectrumFrame`)
- `src/radiotelescope/services/iq_publisher.py:88-96` (`_put_latest` for `bytes`)
- `src/radiotelescope/services/roboclaw.py:154-162` (`_put_latest` for `RoboClawTelemetry`)

Plus a fourth inline copy in `src/radiotelescope/services/queue.py:188-197`:

```python
for q in list(self._listeners):
    if q.full():
        try: q.get_nowait()
        except asyncio.QueueEmpty: pass
    try: q.put_nowait(sentinel)
    except asyncio.QueueFull: pass
```

Same intent, slightly different shape (catches both branches instead of the get/put pair).

The subscribe/unsubscribe pair around it is also copied:

```python
def subscribe(self, maxsize: int = 4) -> asyncio.Queue[T]:
    q = asyncio.Queue(maxsize=maxsize); self._subscribers.append(q); return q
def unsubscribe(self, q): try: self._subscribers.remove(q) except ValueError: pass
```

`spectrum.py:105-116`, `iq_publisher.py:64-73`, `roboclaw.py:83-94`.

Footprint: ~50 LOC across 4 services.

**Suggested extraction:** `src/radiotelescope/services/_pubsub.py` with a small generic `Broadcaster[T]` mixin.

```python
# src/radiotelescope/services/_pubsub.py
from __future__ import annotations
import asyncio
from typing import Generic, TypeVar

T = TypeVar("T")


def put_latest(q: asyncio.Queue[T], item: T) -> None:
    """Enqueue `item`, evicting the oldest entry when the queue is full."""
    try:
        q.put_nowait(item)
    except asyncio.QueueFull:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            pass
        q.put_nowait(item)


class Broadcaster(Generic[T]):
    """Drop-oldest pub/sub over `asyncio.Queue`."""

    def __init__(self) -> None:
        self._subscribers: list[asyncio.Queue[T]] = []

    def subscribe(self, maxsize: int = 4) -> asyncio.Queue[T]:
        q: asyncio.Queue[T] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[T]) -> None:
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    def publish(self, item: T) -> None:
        for q in list(self._subscribers):
            put_latest(q, item)
```

Each service drops its three methods and the trailing module-level `_put_latest`; `SpectrumService.subscribe` keeps its "replay latest" wrinkle via an override.

---

## 3. `SpectrumService` ↔ `IQPublisher` lifecycle duplication

**Category:** NEAR. **Importance:** 8 / 10. **Effort:** M.

Both services wrap an `SDRReceiver` and share near-identical `start` / `stop` / `reconnect` / `_run` plumbing. Compare:

- `services/spectrum.py:70-103` vs `services/iq_publisher.py:34-62` — `start`, `stop`, `reconnect` are nearly byte-for-byte identical (only log message and class name differ).
- Both maintain a `_task: asyncio.Task | None`, both call `await self._rx.open()` / `close()` around it, both swallow `CancelledError` the same way.
- `_run` (`spectrum.py:169-198`, `iq_publisher.py:75-85`) shares the same `try / async for / except CancelledError raise / except Exception logger.exception` skeleton.

Footprint: ~60 LOC duplicated (≈ 25 % of `iq_publisher.py`, ≈ 12 % of `spectrum.py`).

**Suggested extraction:** an `_SDRDriverTask` base class in `src/radiotelescope/services/_sdr_task.py` that owns the receiver, task lifecycle, and subscriber broadcaster. Subclasses only override `_consume(self, rx)` (async iter→fan-out).

```python
# src/radiotelescope/services/_sdr_task.py
from __future__ import annotations
import asyncio, logging
from typing import Generic, TypeVar
from radiotelescope.hardware.sdr import SDRReceiver
from radiotelescope.services._pubsub import Broadcaster

logger = logging.getLogger(__name__)
T = TypeVar("T")


class SDRDriverTask(Broadcaster[T], Generic[T]):
    """Owns an SDRReceiver + a single consumer task with restart support."""

    name: str = "sdr-task"

    def __init__(self, receiver: SDRReceiver) -> None:
        super().__init__()
        self._rx = receiver
        self._task: asyncio.Task | None = None

    @property
    def mode(self) -> str:
        return self._rx.mode

    async def start(self) -> None:
        await self._rx.open()
        self._task = asyncio.create_task(self._safe_run(), name=self.name)
        logger.info("%s started (mode=%s)", self.name, self._rx.mode)

    async def stop(self) -> None:
        await self._cancel_task()
        await self._rx.close()
        logger.info("%s stopped", self.name)

    async def reconnect(self) -> str:
        await self._cancel_task()
        await self._rx.close()
        await self._rx.open()
        self._task = asyncio.create_task(self._safe_run(), name=self.name)
        logger.info("%s reconnected (mode=%s)", self.name, self._rx.mode)
        return self._rx.mode

    async def _cancel_task(self) -> None:
        if self._task:
            self._task.cancel()
            try: await self._task
            except asyncio.CancelledError: pass
            self._task = None

    async def _safe_run(self) -> None:
        try: await self._run()
        except asyncio.CancelledError: raise
        except Exception: logger.exception("%s loop crashed", self.name)

    async def _run(self) -> None:  # subclasses implement
        raise NotImplementedError
```

`SpectrumService` and `IQPublisher` shrink to their DSP / fan-out specifics.

---

## 4. Triangle-in-pointing-limits + azimuth helpers duplicated across Python and TS

**Category:** NEAR / STRUCTURAL. **Importance:** 7 / 10. **Effort:** M.

The "is the requested target inside the 3-vertex pointing-limit triangle (with azimuth unwrapping around the seam)" algorithm exists in two places:

- **Python:** `src/radiotelescope/api/routes_roboclaw.py:18-62`
  - `_normalise_azimuth` (`:18-20`), `_unwrap_azimuth` (`:23-29`), `_point_in_triangle` (`:32-48`), `_inside_pointing_limits` (`:51-62`).
- **TypeScript:** `frontend/src/components/SkyMap.tsx:70-79, 312-339`
  - `normalizeDeg` (`:70-72`), `unwrapDeg` (`:74-79`), `isInsideTriangle` (`:312-339`).

The `sign(x1,y1,x2,y2,x3,y3) = (x1-x3)(y2-y3)-(x2-x3)(y1-y3)` half-plane test and the `±1e-9` epsilon are character-for-character the same. Both unwrap vertices against `triangle[0].azimuth_deg` before testing.

Footprint: ~50 LOC each side; the Python copy is also exported nowhere — it lives in a route module where it can't be reused from other backends.

**Suggested extraction:**

- Python: move the four helpers into `src/radiotelescope/geometry.py` (new module, sibling of `pointing.py`); have `routes_roboclaw.py` import them. This positions them for reuse by future scripts / tests.
- TS: leave the implementation client-side (the SkyMap needs synchronous local feedback before the round trip), but extract into `frontend/src/lib/altaz.ts` so it stops competing with the 1670-line SkyMap component.

Minimal Python module:

```python
# src/radiotelescope/geometry.py
from __future__ import annotations
import math
from collections.abc import Sequence


def normalise_azimuth(deg: float) -> float:
    az = deg % 360.0
    return 0.0 if math.isclose(az, 360.0) else az


def unwrap_azimuth(deg: float, reference_deg: float) -> float:
    while deg - reference_deg > 180.0: deg -= 360.0
    while deg - reference_deg < -180.0: deg += 360.0
    return deg


def point_in_triangle(
    point: tuple[float, float],
    triangle: Sequence[tuple[float, float]],
    epsilon: float = 1e-9,
) -> bool:
    px, py = point
    (ax, ay), (bx, by), (cx, cy) = triangle
    def s(x1, y1, x2, y2, x3, y3): return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
    d1, d2, d3 = s(px, py, ax, ay, bx, by), s(px, py, bx, by, cx, cy), s(px, py, cx, cy, ax, ay)
    neg = d1 < -epsilon or d2 < -epsilon or d3 < -epsilon
    pos = d1 >  epsilon or d2 >  epsilon or d3 >  epsilon
    return not (neg and pos)
```

The TS side is fine as-is once it lives in `frontend/src/lib/altaz.ts` alongside `normalizeDeg`/`unwrapDeg`.

---

## 5. `AltAzLimitPoint` ≡ `AltAzPoint`

**Category:** EXACT. **Importance:** 5 / 10. **Effort:** S.

Two Pydantic models with identical field names, types, and `Field(ge=0, le=…)` validators:

```python
# src/radiotelescope/config.py:34
class AltAzLimitPoint(BaseModel):
    altitude_deg: float = Field(ge=0, le=90)
    azimuth_deg: float = Field(ge=0, le=360)

# src/radiotelescope/models/state.py:116
class AltAzPoint(BaseModel):
    altitude_deg: float = Field(ge=0, le=90)
    azimuth_deg: float = Field(ge=0, le=360)
```

`AltAzRequest` (`state.py:101`) and `RaDecRequest` (`state.py:131`) also share the trailing `{speed_qpps, accel_qpps2, decel_qpps2}` triplet verbatim.

**Suggested extraction:** keep one canonical `AltAzPoint` in `models/state.py`, re-export it from `config.py`; introduce a `_MotionParams` mixin for the speed/accel/decel block:

```python
# models/state.py
class _MotionParams(BaseModel):
    speed_qpps: int | None = Field(default=None, ge=0)
    accel_qpps2: int | None = Field(default=None, ge=0)
    decel_qpps2: int | None = Field(default=None, ge=0)


class AltAzPoint(BaseModel):
    altitude_deg: float = Field(ge=0, le=90)
    azimuth_deg: float = Field(ge=0, le=360)


class AltAzRequest(AltAzPoint, _MotionParams): pass


class RaDecRequest(_MotionParams):
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
```

Then in `config.py`: `from radiotelescope.models.state import AltAzPoint as AltAzLimitPoint` (or just inline-use `AltAzPoint`).

---

## 6. Hydrogen-line rest-frequency constant scattered

**Category:** DATA. **Importance:** 4 / 10. **Effort:** S.

`1420.4058` MHz appears literally in:

- `frontend/src/components/SpectrumPanel.tsx:81` — `const H1_REST_MHZ = 1420.4058;`
- `frontend/src/components/SkyMap.tsx:422` — `const HYDROGEN_LINE_MHZ = 1420.4058;`
- `frontend/src/components/SkyMap.tsx:349` — `spectrumMhz: 1420.4058,` inside the HI survey entry
- `frontend/src/components/SpectrumPanel.tsx:438` — prose `<strong>1420.4058 MHz</strong>` in the UI copy (acceptable, but flag)
- Implicitly via `config.example.toml:70` and `src/radiotelescope/config.py:145` (`1.4204e9` Hz)

**Suggested extraction:** `frontend/src/lib/astro.ts` (proposed module — see end of report) exporting `HYDROGEN_LINE_MHZ = 1420.4058`. Import in both components and replace both literals plus the survey entry.

---

## 7. `queue.ts` re-implements `request<T>()`

**Category:** NEAR. **Importance:** 5 / 10. **Effort:** S.

`frontend/src/api.ts:9-21` defines a generic `request<T>(method, path, body)` that throws `ApiError` with `data.detail`. `frontend/src/queue.ts:19-44` duplicates that fetch + status-check + `data.detail` pattern four times, each with a slightly different error message format:

```ts
// queue.ts:19-23
export async function fetchQueueConfig(): Promise<QueueConfig> {
  const r = await fetch('/api/queue/config');
  if (!r.ok) throw new Error(`queue config: ${r.status}`);
  return r.json();
}
// queue.ts:25-29 — identical shape for /api/queue/status
// queue.ts:31-40 — POST /api/queue/join with manual detail extraction
// queue.ts:42-44 — fire-and-forget POST /api/queue/leave
```

Footprint: 26 LOC out of 44 (~60 % of the file).

**Suggested fix:** fold the four helpers into the `api` object in `api.ts`.

```ts
// frontend/src/api.ts
import type { QueueStatus, QueueConfig } from './queue';

export const api = {
  // …existing entries…
  queueConfig:  () => request<QueueConfig>('GET',  '/api/queue/config'),
  queueStatus:  () => request<QueueStatus>('GET',  '/api/queue/status'),
  joinQueue:    (turnstileToken: string | null) =>
    request<QueueStatus>('POST', '/api/queue/join', { turnstile_token: turnstileToken }),
  leaveQueue:   () => request<void>('POST', '/api/queue/leave'),
};
```

Keep `QueueStatus` / `QueueConfig` *types* in `queue.ts` (or move into `types.ts` once #1 is addressed); delete the four functions.

---

## 8. `goto*` payloads: `decel_qpps2 = accel_qpps2` bug-shaped duplication

**Category:** NEAR. **Importance:** 4 / 10. **Effort:** S.

```ts
// frontend/src/api.ts:28-35  (gotoAltAz)
body: {
  altitude_deg, azimuth_deg,
  speed_qpps: speedQpps,
  accel_qpps2: accelQpps2,
  decel_qpps2: accelQpps2,   // ← deliberately reuses accel for decel
},

// frontend/src/api.ts:37-44  (gotoRaDec)
body: {
  ra_deg: target.ra_deg, dec_deg: target.dec_deg,
  speed_qpps: speedQpps,
  accel_qpps2: accelQpps2,
  decel_qpps2: accelQpps2,   // ← same trick
},
```

Aside from the duplicated four-line payload, both helpers silently drop the caller's ability to pass a distinct `decelQpps2`. That's either a latent bug or an intentional simplification — either way the contract should live in one place.

**Suggested fix:** factor a `motionParams(speedQpps, accelQpps2, decelQpps2)` builder; pass it through.

```ts
function motionParams(speed?: number, accel?: number, decel?: number) {
  return { speed_qpps: speed, accel_qpps2: accel, decel_qpps2: decel ?? accel };
}

gotoAltAz: (alt: number, az: number, s?: number, a?: number, d?: number) =>
  request<CommandResult>('POST', '/api/telescope/goto',
    { altitude_deg: alt, azimuth_deg: az, ...motionParams(s, a, d) }),

gotoRaDec: (t: RaDecTarget, s?: number, a?: number, d?: number) =>
  request<CommandResult>('POST', '/api/telescope/goto_radec',
    { ra_deg: t.ra_deg, dec_deg: t.dec_deg, ...motionParams(s, a, d) }),
```

---

## 9. Per-axis speed/accel/decel resolution ladder

**Category:** EXACT-ish. **Importance:** 4 / 10. **Effort:** S.

`src/radiotelescope/api/routes_roboclaw.py:164-169`:

```python
az_speed  = speed_qpps if speed_qpps is not None else (stored_m1 if stored_m1 is not None else cfg.goto_speed_qpps)
alt_speed = speed_qpps if speed_qpps is not None else (stored_m2 if stored_m2 is not None else cfg.goto_speed_qpps)
az_accel  = accel_qpps2 if accel_qpps2 is not None else az_speed
az_decel  = decel_qpps2 if decel_qpps2 is not None else az_speed
alt_accel = accel_qpps2 if accel_qpps2 is not None else alt_speed
alt_decel = decel_qpps2 if decel_qpps2 is not None else alt_speed
```

The "user override → stored controller value → config default" coalesce chain is repeated for each axis. The accel/decel rows are then identical mod the per-axis speed.

**Suggested extraction:** local `_resolve(override, stored, default)` and `_ramps(speed, accel, decel)`:

```python
def _resolve(override, stored, default):
    return override if override is not None else (stored if stored is not None else default)


def _ramps(speed: int, accel: int | None, decel: int | None) -> tuple[int, int]:
    return (accel if accel is not None else speed,
            decel if decel is not None else speed)

# in _execute_goto_altaz:
az_speed  = _resolve(speed_qpps, stored_m1, cfg.goto_speed_qpps)
alt_speed = _resolve(speed_qpps, stored_m2, cfg.goto_speed_qpps)
az_accel,  az_decel  = _ramps(az_speed,  accel_qpps2, decel_qpps2)
alt_accel, alt_decel = _ramps(alt_speed, accel_qpps2, decel_qpps2)
```

---

## 10. WebSocket open/close/error boilerplate

**Category:** NEAR. **Importance:** 6 / 10. **Effort:** S.

Three React effects open a WebSocket with the same `wss/ws` URL construction and identical teardown:

- `frontend/src/main.tsx:72-81` (`/ws/roboclaw`)
- `frontend/src/main.tsx:86-115` (`/ws/queue` — adds activity heartbeat)
- `frontend/src/components/SpectrumPanel.tsx:238-252` (`/ws/spectrum`)

Common pattern:

```ts
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}/ws/<topic>`);
ws.onopen    = …;
ws.onclose   = …;
ws.onerror   = …;
ws.onmessage = (event) => { try { JSON.parse(event.data) … } catch {} };
return () => ws.close();
```

None of them reconnect automatically; if/when that need lands it will be the third hand-rolled reconnect ladder in the codebase.

**Suggested extraction:** `frontend/src/lib/useJsonSocket.ts` — a React hook returning `{connected, last}` plus a `send` callback, with optional auto-reconnect.

```ts
// frontend/src/lib/useJsonSocket.ts
import { useEffect, useRef, useState } from 'react';

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export function useJsonSocket<T>(
  path: string | null,
  onMessage: (msg: T) => void,
  opts: { onError?: (e: Event) => void } = {},
) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (path == null) return;
    const ws = new WebSocket(wsUrl(path));
    wsRef.current = ws;
    ws.onopen    = () => setConnected(true);
    ws.onclose   = () => setConnected(false);
    ws.onerror   = (e) => { setConnected(false); opts.onError?.(e); };
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data) as T); } catch { /* ignore */ }
    };
    return () => { wsRef.current = null; ws.close(); };
  }, [path]);

  return {
    connected,
    send: (s: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(s);
    },
  };
}
```

`SpectrumPanel.tsx`, the RoboClaw effect in `main.tsx`, and the queue WS effect collapse to one `useJsonSocket(…)` call each (the queue case still attaches its own document-event activity throttle, but the socket lifecycle disappears).

---

## 11. `gaussianLine` ↔ `gaussianFill` share a sampling loop

**Category:** EXACT. **Importance:** 2 / 10. **Effort:** S.

`frontend/src/components/QueuePage.tsx:29-41`:

```ts
function gaussianLine(cx, sigma, amp, base, w): string {
  const pts: string[] = [];
  for (let x = 0; x <= w; x += 3)
    pts.push(`${x},${(base - amp * Math.exp(-0.5 * ((x - cx) / sigma) ** 2)).toFixed(1)}`);
  return `M ${pts.join(' L ')}`;
}

function gaussianFill(cx, sigma, amp, base, w): string {
  const pts: string[] = [];
  for (let x = 0; x <= w; x += 3)
    pts.push(`${x},${(base - amp * Math.exp(-0.5 * ((x - cx) / sigma) ** 2)).toFixed(1)}`);
  return `M 0,${base} L ${pts.join(' L ')} L ${w},${base} Z`;
}
```

100 % shared sampling, differing only in prefix/suffix.

**Suggested fix:**

```ts
function gaussianPts(cx: number, sigma: number, amp: number, base: number, w: number): string[] {
  const pts: string[] = [];
  for (let x = 0; x <= w; x += 3)
    pts.push(`${x},${(base - amp * Math.exp(-0.5 * ((x - cx) / sigma) ** 2)).toFixed(1)}`);
  return pts;
}
const gaussianLine = (...args: Parameters<typeof gaussianPts>) => `M ${gaussianPts(...args).join(' L ')}`;
const gaussianFill = (cx: number, sigma: number, amp: number, base: number, w: number) =>
  `M 0,${base} L ${gaussianPts(cx, sigma, amp, base, w).join(' L ')} L ${w},${base} Z`;
```

---

## 12. Raw hex colour literals duplicate CSS custom-properties

**Category:** DATA. **Importance:** 3 / 10. **Effort:** S.

`--bg` is defined as `#0b0d16` at `frontend/src/styles/main.css:16`. The same literal appears as a raw hex in at least 8 places:

- `:312`, `:349`, `:846`, `:1562`, `:1565`, `:2757`, `:2843`, `:2899`, `:3047` — all `color: #0b0d16;` (the "ink on golden button" use case).

Other family hex repeats:

- `#e6a830` (darker accent) at `:1566` (×2 in same rule).
- `#8a6720` (warning border) at `:1395`, `:1408`.
- `rgba(230,160,30, …)` family at `:2770`, `:2772` (×2). The number `230,160,30` corresponds to no existing variable.

**Suggested fix:** introduce two more tokens and route through `var()`:

```css
:root {
  --on-accent: #0b0d16;   /* text colour on amber buttons */
  --accent-press: #e6a830; /* :active state of accent buttons */
  --accent-amber-edge: #8a6720; /* dim amber hairline */
}
```

Then `color: var(--on-accent);` and `background: var(--accent-press);` everywhere they're used today.

This is low-risk find-and-replace; the only judgement call is whether `#0b0d16` should reuse `--bg` directly or get a semantic alias — semantic alias recommended so a future palette tweak doesn't drag button text colour along with the page background.

---

## Proposed shared modules

Only one of these is large enough to justify a new file; the rest are recommended one-liner moves into existing modules.

### `frontend/src/lib/astro.ts` (new) — recommended

Contents drawn entirely from current SkyMap helpers; no invented APIs:

```ts
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const HYDROGEN_LINE_MHZ = 1420.4058;

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function unwrapDeg(deg: number, reference: number): number {
  let v = deg;
  while (v - reference >  180) v -= 360;
  while (v - reference < -180) v += 360;
  return v;
}

export function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

export function gmstDeg(date: Date): number {
  const d = julianDay(date) - 2_451_545.0;
  return normalizeDeg(280.46061837 + 360.98564736629 * d);
}

// raDecToAltAz / altAzToRaDec / positionAngleDeg / sunRaDec / moonRaDec
// lifted verbatim from SkyMap.tsx:91-193
```

`SpectrumPanel.tsx` imports `HYDROGEN_LINE_MHZ`; `SkyMap.tsx` deletes its private copies of `D`, `R`, `normalizeDeg`, `unwrapDeg`, `julianDay`, `gmstDeg`, etc., and imports them.

### `src/radiotelescope/geometry.py` (new) — recommended

Already shown in finding #4. Tiny module (≈40 LOC) housing `normalise_azimuth`, `unwrap_azimuth`, `point_in_triangle`. Both `routes_roboclaw.py` and future scripts/tests import from it.

### `src/radiotelescope/services/_pubsub.py` (new) — recommended

Already shown in finding #2. ~30 LOC. `Broadcaster[T]` + `put_latest(q, item)`.

### `src/radiotelescope/services/_sdr_task.py` (new) — recommended

Already shown in finding #3. ~50 LOC. Houses `SDRDriverTask` base.

### `frontend/src/lib/useJsonSocket.ts` (new) — recommended

Already shown in finding #10.

---

## Items not pursued / unable to verify

- `katpoint` already encapsulates the precise `altaz_to_radec` / `radec_to_altaz` math; the SkyMap TS code uses a fast, low-precision implementation. These are **not** duplicates — they're deliberately separate (one for backend pointing, one for client-side preview). Left as-is.
- `frontend/src/branding.ts` is 9 lines and only imported in one place; no duplication to extract.
- `tests/` was outside the read scope of this audit pass; if test fixtures duplicate the Pydantic models a follow-up sweep would confirm. **Unable to verify** without reading `tests/conftest.py` and the test files.
- `hardware/roboclaw.py` (689 LOC) was not read line-by-line; large register/command tables are inherent and likely not duplication. **Unable to verify** further without targeted inspection.
- `hardware/host_stats.py` and `services/geometry.py` are each single-purpose and small; no internal duplication observed at the file level.

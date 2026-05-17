# Code Complexity Audit

Generated: 2026-05-17
Scope: `src/radiotelescope/**/*.py`, `frontend/src/**/*.{ts,tsx}`
Method: `radon cc/mi/raw` for Python; manual structural review for TypeScript (no JS analyser run because the project ships no eslint/sonar config).

Headline numbers (`python -m radon`):

- Total Python: 4649 LOC / 3157 LLOC across 27 modules.
- Maintainability Index: **only one module drops to a `C` grade — `hardware/roboclaw.py` MI = 3.12** (size + monolithic dict). Every other module is `A`.
- Highest cyclomatic complexity scores:
  - `SimulatedRoboClaw._simulated_value` — **CC 19** (`hardware/roboclaw.py:464`)
  - `dump_types._ts_type` — **CC 18** (`scripts/dump_types.py:75`)
  - `SimulatedRoboClaw._apply_simulated_command` — **CC 17** (`hardware/roboclaw.py:399`)
  - `QueueService._tick` — **CC 16** (`services/queue.py:203`)
  - `RoboClawService.refresh` — **CC 11** (`services/roboclaw.py:123`)

Frontend hotspots (no analyser, sizes are line counts of the function body):

- `SkyMap()` at [SkyMap.tsx:630](frontend/src/components/SkyMap.tsx:630) — single component ~912 lines.
- `App()` at [main.tsx:34](frontend/src/main.tsx:34) — single component ~365 lines, 27 `useState`/`useRef` declarations in the first 50 lines.
- `SpectrumPanel()` at [SpectrumPanel.tsx:130](frontend/src/components/SpectrumPanel.tsx:130) — ~405 lines.

---

## Findings

Each finding has an importance score (1 = nit, 10 = must-fix). All sizes verified against working tree at the time of this audit; nothing speculative.

---

### F1 — `hardware/roboclaw.py` is a 689-line monolith with MI = 3.12
**Importance: 8/10**
**Location:** [src/radiotelescope/hardware/roboclaw.py](src/radiotelescope/hardware/roboclaw.py)

A single file contains:
- Three protocol/data dataclasses (`ArgSpec`, `ResponseSpec`, `CommandSpec`).
- A `COMMANDS` registry of ~70 entries (`roboclaw.py:106-181`) — many single lines over 200 chars wide.
- `SerialRoboClaw` (lines 234-345) — serial driver.
- `SimulatedRoboClaw` (lines 346-493) — full simulator with command handler and value synthesiser.
- `build_snapshot` (lines 507-580) — telemetry aggregator.
- CRC, validation, packing, status flags helpers.

This is the only `C`-grade file in the Python tree. The breadth of responsibilities and the wide-format dict literal are what tank the MI score.

**Remediation (split-only, behaviour-preserving):**

```
src/radiotelescope/hardware/roboclaw/
  __init__.py        # re-export public names
  commands.py        # ArgSpec / ResponseSpec / CommandSpec / COMMANDS / OPERATOR_COMMAND_IDS / STATUS_FLAGS / command_registry / _arg / _resp
  protocol.py        # crc16, _encode_args, _validate_args, _pack_value, _decode_response, _unpack_value, _response_type_size, _status_flags
  serial_client.py   # SerialRoboClaw
  simulated.py       # SimulatedRoboClaw
  snapshot.py        # build_snapshot
  factory.py         # make_client
```

Re-export at `__init__.py` so existing imports (`from radiotelescope.hardware.roboclaw import make_client, COMMANDS, …`) keep working. No call-site changes needed.

---

### F2 — `SimulatedRoboClaw._simulated_value` — CC 19, a long elif chain on string substrings
**Importance: 6/10**
**Location:** [src/radiotelescope/hardware/roboclaw.py:464](src/radiotelescope/hardware/roboclaw.py:464)

The dispatch is keyed by membership tests (`if "current" in name`, `if "pwm" in name`, …). It is correct but brittle: a new response spec named `m1_pwm_current` would match the first branch (`"current" in name`) and return the wrong raw value.

**Remediation — replace the elif chain with an ordered, explicit pattern dispatch table:**

```python
# Predicate-based dispatch; first match wins. Easier to add/audit
# than an `elif "x" in name:` chain.
_VALUE_SOURCES: tuple[tuple[Callable[[str], bool], Callable[["SimulatedRoboClaw", str], Any]], ...] = (
    (lambda n: n in ("voltage_v", "main_battery_v"),  lambda s, n: s._main_battery_tenths),
    (lambda n: n == "temperature_c",                  lambda s, n: s._temperature_tenths),
    (lambda n: n in ("status", "settings", "config"), lambda s, n: s._status),
    (lambda n: n in ("m1", "m1_encoder", "encoder"),  lambda s, n: s._encoders["m1"]),
    (lambda n: n in ("m2", "m2_encoder"),             lambda s, n: s._encoders["m2"]),
    (lambda n: "current" in n,                        lambda s, n: abs(s._pwms["m1" if n.startswith("m1") else "m2"]) // 600),
    (lambda n: "pwm" in n,                            lambda s, n: s._pwms["m1" if n.startswith("m1") else "m2"]),
    (lambda n: "speed" in n,                          lambda s, n: s._speeds["m1" if n.startswith("m1") else "m2"]),
)

def _simulated_value(self, name, type_, scale, precision):
    if type_ == "string":
        raw: Any = self._firmware
    else:
        raw = 0
        for predicate, getter in _VALUE_SOURCES:
            if predicate(name):
                raw = getter(self, name)
                break
    if scale != 1.0 and isinstance(raw, int):
        value = raw * scale
        return round(value, precision) if precision is not None else value
    return raw
```

CC drops from 19 to ~4. Or — preferred — extend `ResponseSpec` with a `source: Literal["voltage","temp","encoder_m1",…]` tag and dispatch on that, removing the substring guesswork entirely.

---

### F3 — `SimulatedRoboClaw._apply_simulated_command` — CC 17, parallel `forward_m1/m2`, `duty_m1/m2/m1m2` branches
**Importance: 5/10**
**Location:** [src/radiotelescope/hardware/roboclaw.py:399](src/radiotelescope/hardware/roboclaw.py:399)

15 branches, but each pair (`forward_m1`/`forward_m2`, `duty_m1`/`duty_m2`, `speed_m1`/`speed_m2`, `*_m1m2`) is essentially the same code with `"m1"` ↔ `"m2"`.

**Remediation — a small per-id handler table, parameterised by channel:**

```python
_DRIVE = {
    "forward_m1":  ("m1",  1, "speed"),
    "backward_m1": ("m1", -1, "speed"),
    "forward_m2":  ("m2",  1, "speed"),
    "backward_m2": ("m2", -1, "speed"),
}

def _apply_simulated_command(self, spec, args):
    cid = spec.id
    if cid == "reset_encoders":
        self._encoders = {"m1": 0, "m2": 0}; return
    if cid in ("set_encoder_m1", "set_encoder_m2"):
        self._encoders[cid[-2:]] = int(args["value"]); return
    if cid in _DRIVE:
        ch, sign, key = _DRIVE[cid]
        v = int(args[key])
        self._commands[ch] = sign * v
        self._speeds[ch]   = sign * v * 100
        self._pwms[ch]     = sign * round(v * 32767 / 127)
        return
    if cid in ("duty_m1", "duty_m2"):
        self._set_duty(cid[-2:], int(args["duty"])); return
    if cid == "duty_m1m2":
        self._set_duty("m1", int(args["m1_duty"])); self._set_duty("m2", int(args["m2_duty"])); return
    if cid in ("speed_m1", "speed_m2"):
        self._set_speed(cid[-2:], int(args["speed"])); return
    if cid == "speed_m1m2":
        self._set_speed("m1", int(args["m1_speed"])); self._set_speed("m2", int(args["m2_speed"])); return
    if cid in ("speed_accel_decel_position_m1", "speed_accel_decel_position_m2"):
        self._move_to_position(cid[-2:], int(args["position"]), int(args["speed"])); return
    if cid == "speed_accel_decel_position_m1m2":
        self._move_to_position("m1", int(args["m1_position"]), int(args["m1_speed"]))
        self._move_to_position("m2", int(args["m2_position"]), int(args["m2_speed"]))
```

CC drops from 17 to ~8; the symmetry between M1 and M2 stops being copy-pasted.

---

### F4 — `QueueService._tick` is the lease state machine, CC 16, deeply nested
**Importance: 7/10**
**Location:** [src/radiotelescope/services/queue.py:203](src/radiotelescope/services/queue.py:203)

`_tick` does four distinct things behind one lock:
1. lease expiry check
2. lease-on-disconnect check
3. queue prune for stale joiners
4. promote next candidate

Each is conceptually independent and currently lives inside one `async with self._lock` block with up-to-3-deep conditionals. The function works, but the cognitive cost is the per-block invariants ("must be called with lock held"), which is only documented at line 254 below the function. The mixing of expiry and promotion logic makes it easy to introduce a race when adding a new transition.

**Remediation — extract three private "must hold lock" helpers:**

```python
async def _tick(self) -> bool:
    async with self._lock:
        now = time.monotonic()
        changed  = self._expire_active_locked(now)
        changed |= self._drop_disconnected_active_locked(now)
        changed |= self._prune_stale_queue_locked(now)
        changed |= self._promote_if_idle()
        return changed

def _expire_active_locked(self, now: float) -> bool: ...
def _drop_disconnected_active_locked(self, now: float) -> bool: ...
def _prune_stale_queue_locked(self, now: float) -> bool: ...
```

Naming the helpers `*_locked` matches the existing convention (`_drop_locked`, `_promote_if_idle` at lines 256/267). CC of each helper falls to ~3-4.

---

### F5 — `dump_types._ts_type` — CC 18, mixed runtime introspection branches
**Importance: 3/10**
**Location:** [src/radiotelescope/scripts/dump_types.py:75](src/radiotelescope/scripts/dump_types.py:75)

CC is high but the function is a one-shot codegen helper that only runs in `dump_types`. Cost of a bug is low (developer rebuilds). Documentation already justifies the structure. **Recommend leaving as-is**, possibly with a single dispatch dict for the leading scalar checks:

```python
_SCALAR = {type(None): "null", str: "string", int: "number", float: "number", bool: "boolean", Any: "unknown"}
def _ts_type(py_type):
    if py_type in _SCALAR: return _SCALAR[py_type]
    ...
```

Saves ~5 CC at no behavioural cost.

---

### F6 — `RoboClawService.refresh` — CC 11
**Importance: 4/10**
**Location:** [src/radiotelescope/services/roboclaw.py:123](src/radiotelescope/services/roboclaw.py:123)

Just over the CC=10 threshold. Without seeing the function being abused, this is borderline. Mention in passing; if `_stop_if_position_target_reached` and `refresh_stored_qpps` keep accreting checks, extract the QPPS-resolution branch into its own coroutine. **No change recommended yet.**

---

### F7 — `frontend/src/components/SkyMap.tsx` is 1542 lines, with one ~912-line component
**Importance: 9/10**
**Location:** [frontend/src/components/SkyMap.tsx:630](frontend/src/components/SkyMap.tsx:630)

`SkyMap()` is the dominant React component in the app. The file also fuses unrelated rendering helpers, the spectrum-survey selector (`LightSpectrumSurveySelector`, lines 494-614), an in-file `CameraPip` component, polygon math (`pointInPolygon`), Sun/Moon drawing primitives, and a horizon orientation calculator. Cohesion is low — at minimum five distinct responsibilities live here.

This is the single biggest readability liability in the repo. Reading it cold is harder than the Python `roboclaw.py` because the component captures dozens of closure variables (you have to scan everything that follows `function SkyMap(...)` to know whether a state setter is referenced).

**Remediation (file split, no behavioural changes):**

```
frontend/src/components/SkyMap/
  index.tsx                   # SkyMap proper, < 400 lines after extraction
  CameraPip.tsx               # lines 27-78 → its own component
  spectrum/
    SurveyConstants.ts        # SURVEYS, MIN_FREQ_MHZ, …, helpers logFreqToRatio/freqLabelFromLog/wavelengthLabelFromLog
    spectrumOption.ts         # buildSpectrumOption (lines 362-494)
    LightSpectrumSurveySelector.tsx
  drawing.ts                  # drawSunIcon, drawMoonIcon, pointInPolygon
  orientation.ts              # localUpOrientationDeg, initialHorizonRotationDeg, DEFAULT_HORIZON_VIEW
```

Then, inside `SkyMap()` itself, extract logically-grouped state into custom hooks (e.g. `useTargetSelection`, `useHorizonOverlay`, `useSpectrumSurveys`). The component-level `useState`/`useEffect` density should drop by half once these move.

---

### F8 — `frontend/src/main.tsx` `App()` is a 365-line god component
**Importance: 8/10**
**Location:** [frontend/src/main.tsx:34](frontend/src/main.tsx:34)

`App()` carries everything: telemetry socket, queue lease tracking, LNA state, command list, target az/alt, fullscreen state, join error state, refs for previous-active / last-lease-remaining / panel DOM. The first 16 lines are pure `useState`/`useRef` (file lines 35-50).

Cognitive complexity is high because:
- State variables span unrelated concerns (lease vs telemetry vs UI mode).
- Many of these (e.g. `prevIsActiveRef`, `lastLeaseRemainingRef`) belong with the queue subscription, not the top level.

**Remediation:**

1. Extract the queue/lease side-effects into `useQueueLease()` returning `{ status, isActive, joinError, joining, join, leave }`.
2. Extract telemetry/LNA into `useTelemetry()` returning `{ telemetry, lnaStatus, lnaChanging, setLna }`.
3. Extract command catalogue + telescope config into `useBackendCatalog()`.
4. `App()` becomes a layout component that composes `<TopBar/> <SkyMap/> <MotionControls/> <TelemetryDashboard/> <InfoSection/>` with the hook outputs passed in.

Target: `App()` body under 80 lines, with each hook ≤ ~80 lines and individually testable.

---

### F9 — `frontend/src/components/SpectrumPanel.tsx` — single component, ~405 lines
**Importance: 5/10**
**Location:** [frontend/src/components/SpectrumPanel.tsx:130](frontend/src/components/SpectrumPanel.tsx:130)

Smaller than `SkyMap`, but the component does waterfall rendering, ECharts option building, H1 search logic, and y-range autoscale. `buildColormapLUT` (line 60) and `baseOption` (line 536) are already extracted; finish the job by moving:
- the H1 search constants/helpers (lines 83-128),
- the waterfall offscreen-canvas update,
- the y-range autoscale,

into a `useSpectrumChart` hook plus a `h1.ts` helper. Importance is below `SkyMap`/`main.tsx` because it has only one core responsibility (a chart), just expressed verbosely.

---

### F10 — `routes_roboclaw.py:execute_command` — CC 10, tangled authority check
**Importance: 6/10**
**Location:** [src/radiotelescope/api/routes_roboclaw.py:98](src/radiotelescope/api/routes_roboclaw.py:98)

```python
gateway_internal = (
    command_id in GATEWAY_INTERNAL_COMMAND_IDS
    and request.app.state.config.hardware.mode == "gateway-server"
    and is_lan_admin(request)
)
if command_id not in OPERATOR_COMMAND_IDS and not gateway_internal:
    raise HTTPException(404, ...)
```

The "is this command allowed for this caller" decision is inline with execution; it should be its own checked predicate (security-sensitive logic should not share a function with the side-effect path). A reader can't quickly answer "what commands does the gateway-server expose that the regular API doesn't?" without scrolling.

**Remediation — extract authority predicate:**

```python
def _authorised(command_id: str, request: Request) -> bool:
    if command_id in OPERATOR_COMMAND_IDS:
        return True
    cfg = request.app.state.config.hardware
    return (
        command_id in GATEWAY_INTERNAL_COMMAND_IDS
        and cfg.mode == "gateway-server"
        and is_lan_admin(request)
    )

async def execute_command(command_id: str, body: CommandRequest, request: Request):
    spec = COMMANDS.get(command_id)
    if spec is None:
        raise HTTPException(404, f"Unknown command: {command_id}")
    if not _authorised(command_id, request):
        raise HTTPException(404, f"Command is not available from the web controller: {command_id}")
    ...
```

This is also unit-testable in isolation, which the inline form is not.

---

### F11 — `client_allowlist.ClientAllowlistMiddleware.__call__` — CC 10
**Importance: 3/10**
**Location:** [src/radiotelescope/api/client_allowlist.py:31](src/radiotelescope/api/client_allowlist.py:31)

Right at the CC=10 line. Likely fine — middlewares legitimately branch on scope type, allow-list state, exempt paths, etc. **No change unless adding more cases.** Mark and watch.

---

### F12 — `routes_queue.queue_join` — CC 10
**Importance: 3/10**
**Location:** [src/radiotelescope/api/routes_queue.py:55](src/radiotelescope/api/routes_queue.py:55)

Same as F11 — at the threshold, no clear win from further decomposition without seeing what's actually growing. Watch only.

---

### F13 — Cohesion: `services/spectrum.py` co-locates worker loop + state, but tightly couples to `SDRReceiver`
**Importance: 4/10**
**Location:** [src/radiotelescope/services/spectrum.py](src/radiotelescope/services/spectrum.py), [services/_sdr_task.py](src/radiotelescope/services/_sdr_task.py)

`SpectrumService` (169 lines) is reasonably focused. Efferent coupling is to `_sdr_task`, `_pubsub`, and the hardware `SDRReceiver`/`RemoteSDRReceiver` protocol. Afferent: only `main.py` and `routes_spectrum.py`. Instability index `I ≈ 0.6` — acceptable for a service-layer module. No action.

---

### F14 — Coupling: `main.py.lifespan` is the single point that knows every service
**Importance: 4/10**
**Location:** [src/radiotelescope/main.py:41-95](src/radiotelescope/main.py:41)

`lifespan` constructs and orders the lifecycle of: `RemoteRoboClawClient`/`SerialRoboClaw`/`SimulatedRoboClaw`, `Antenna`, `RoboClawService`, `QueueService`, `SDRReceiver`/`RemoteSDRReceiver`, `SpectrumService`, `IQPublisher`. This is *fine* — it is the composition root — but it does mean adding a new service requires touching one file in 5 places (construct, store on state, start, stop). Consider a small `ServiceRegistry` that holds (start, stop) pairs so the start/stop blocks become a loop. Low priority — current code is explicit and readable.

```python
services: list[tuple[str, Any]] = []
services.append(("roboclaw", service))
services.append(("queue", queue))
if spectrum: services.append(("spectrum", spectrum))
if iq_publisher: services.append(("iq", iq_publisher))
for name, svc in services:
    await svc.start()
yield
for name, svc in reversed(services):
    await svc.stop()
```

---

### F15 — `hardware/roboclaw.py` `COMMANDS` registry: 70 wide single-line entries
**Importance: 5/10**
**Location:** [src/radiotelescope/hardware/roboclaw.py:106-181](src/radiotelescope/hardware/roboclaw.py:106)

Each command spec is one long single-line `CommandSpec(...)` call, several over 250 chars wide. Not "complex" by CC, but dominates the file's bad MI score and is unreviewable in PR diffs. Either reformat to one field per line (mechanical), or pull the registry out into `commands.yaml`/`.toml` and load at import time. Mechanical reformat is the lowest-risk option and combines naturally with the split in F1.

---

## Cross-cutting observations

- **No automated complexity gate.** Adding `radon` + a CI threshold (`radon cc --total-average --no-assert` fail if any `D+`) would catch regressions cheaply. *Suggested config in `pyproject.toml`:*

  ```toml
  [tool.radon]
  cc_min = "B"
  exclude = "tests/*,src/radiotelescope/scripts/*"
  ```

  Plus `pre-commit` hook or one CI step running `python -m radon cc src/radiotelescope --total-average -n B`.

- **No JS/TS complexity tooling configured.** `frontend/` has no eslint config visible at repo root and no `complexity` rule. Recommend adding `eslint-plugin-sonarjs` with `sonarjs/cognitive-complexity: ["warn", 15]` — this would have surfaced F7/F8/F9 automatically.

- **Cohesion of the package layout is generally good.** `api/`, `services/`, `hardware/`, `models/` map cleanly to the layered architecture described in `CLAUDE.md`. The exceptions are `hardware/roboclaw.py` (F1) and the two giant frontend components (F7, F8).

- **Unable to verify (would need extra context):** Afferent/efferent coupling for the frontend modules — there is no dependency-graph tool configured and the import graph is too small to bother with manually. If desired, `madge --circular --extensions ts,tsx frontend/src` would prove the absence of cycles in < 2 s.

---

## Recommended remediation priority

| Order | Finding | Effort | Impact |
|---|---|---|---|
| 1 | F7 — split `SkyMap.tsx` | Medium (1 day) | High readability |
| 2 | F1 — split `hardware/roboclaw.py` into a package | Small (2 hr, mechanical) | Restores MI to A, prerequisite for F2/F3/F15 |
| 3 | F8 — extract hooks from `App()` | Medium (½ day) | High readability + testability |
| 4 | F4 — break `QueueService._tick` into named locked helpers | Small (1 hr) | Race-safety legibility |
| 5 | F10 — extract `_authorised` predicate | Small (15 min) | Security-relevant clarity |
| 6 | F2, F3, F15 — clean up roboclaw simulator + registry | Small (3 hr total) | Maintenance |
| 7 | Cross-cutting: add `radon` CI gate + `sonarjs` lint | Small (½ hr) | Prevents regression |

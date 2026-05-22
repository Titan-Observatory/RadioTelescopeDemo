# Complexity Audit — radiotelescope backend

**Date:** 2026-05-19
**Scope:** `src/radiotelescope/**/*.py` (4,897 LOC across 27 modules)
**Tooling:** `radon cc` (cyclomatic), `radon mi` (maintainability), `radon raw` (LOC), manual reading for cognitive complexity / coupling / cohesion.

Maintainability index is **A** across all modules except `hardware/roboclaw.py` (**C, MI=3.12**) — the single biggest hotspot in the repo.

---

## 1. Cyclomatic Complexity

Radon's only **C-grade** functions (CC ≥ 11). No functions exceed CC=20; nothing is in the D/E/F bands.

| # | Location | Function | CC | Importance |
|---|---|---|---|---|
| 1 | [hardware/roboclaw.py:464](src/radiotelescope/hardware/roboclaw.py:464) | `SimulatedRoboClaw._simulated_value` | 19 | **8/10** |
| 2 | [hardware/roboclaw.py:399](src/radiotelescope/hardware/roboclaw.py:399) | `SimulatedRoboClaw._apply_simulated_command` | 17 | **8/10** |
| 3 | [scripts/dump_types.py:75](src/radiotelescope/scripts/dump_types.py:75) | `_ts_type` | 18 | 3/10 (build script, exec'd once) |
| 4 | [services/queue.py:203](src/radiotelescope/services/queue.py:203) | `QueueService._tick` | 16 | **7/10** (runs every 1 s; correctness critical) |
| 5 | [services/roboclaw.py:123](src/radiotelescope/services/roboclaw.py:123) | `RoboClawService.refresh` | 11 | 5/10 |

Functions in the **B band (CC 6–10)** that are worth watching but not refactoring solo: `client_allowlist.ClientAllowlistMiddleware.__call__` (10), `routes_roboclaw.execute_command` (10), `routes_queue.queue_join` (10), `hardware/roboclaw._validate_args` (9), `SDRReceiver.stream` (8), `SDRReceiver._set_lna_bias_tee_gpio` (8), `lifespan` (8), `auth.PasswordAuthMiddleware.__call__` (8). None individually justify a refactor; flag if they grow.

### 1a. `_simulated_value` (CC 19) — Importance 8/10

A 30-line elif chain switching on the response field name. Long, but each branch is one line and the abstraction level is uniform — cognitive complexity is moderate, not pathological. The real issue is that **name-based dispatch is fragile**: e.g. `if "current" in name` will match a future field called `recurrent_x`, and `name == "m2" or name == "m2_encoder"` is asymmetric with the `m1` branch.

**Remediation (CC: 19 → ~3):** replace the chain with a lookup table keyed by exact response-spec name; fall back to a tiny dispatcher for the parameterised channels (`m1_*`/`m2_*`).

```python
_SIM_FIELDS: dict[str, Callable[["SimulatedRoboClaw"], Any]] = {
    "firmware":       lambda s: s._firmware,
    "voltage_v":      lambda s: s._main_battery_tenths,
    "main_battery_v": lambda s: s._main_battery_tenths,
    "temperature_c":  lambda s: s._temperature_tenths,
    "status":         lambda s: s._status,
    "settings":       lambda s: s._status,
    "config":         lambda s: s._status,
    "m1":             lambda s: s._encoders["m1"],
    "m1_encoder":     lambda s: s._encoders["m1"],
    "encoder":        lambda s: s._encoders["m1"],
    "m2":             lambda s: s._encoders["m2"],
    "m2_encoder":     lambda s: s._encoders["m2"],
}

def _simulated_value(self, name, type_, scale, precision):
    if type_ == "string":
        raw = self._firmware
    elif name in _SIM_FIELDS:
        raw = _SIM_FIELDS[name](self)
    else:
        ch = "m1" if name.startswith("m1") else "m2"
        if "current" in name:  raw = abs(self._pwms[ch]) // 600
        elif "pwm"   in name:  raw = self._pwms[ch]
        elif "speed" in name:  raw = self._speeds[ch]
        else:                  raw = 0           # error/mode/unknown
    if scale != 1.0 and isinstance(raw, int):
        v = raw * scale
        return round(v, precision) if precision is not None else v
    return raw
```

### 1b. `_apply_simulated_command` (CC 17) — Importance 8/10

Same shape: 14-arm elif chain dispatching on `spec.id`. Each arm wires args→state mutators (`_set_duty`, `_set_speed`, `_move_to_position`).

**Remediation:** dispatch table mapping `spec.id` → handler. Drops CC to ~3.

```python
_SIM_COMMANDS: dict[str, Callable[["SimulatedRoboClaw", dict], None]] = {
    "reset_encoders":  lambda s, a: s._encoders.update({"m1": 0, "m2": 0}),
    "set_encoder_m1":  lambda s, a: s._encoders.__setitem__("m1", int(a["value"])),
    "set_encoder_m2":  lambda s, a: s._encoders.__setitem__("m2", int(a["value"])),
    "forward_m1":      lambda s, a: s._apply_open_loop("m1", +int(a["speed"])),
    "backward_m1":     lambda s, a: s._apply_open_loop("m1", -int(a["speed"])),
    "forward_m2":      lambda s, a: s._apply_open_loop("m2", +int(a["speed"])),
    "backward_m2":     lambda s, a: s._apply_open_loop("m2", -int(a["speed"])),
    "duty_m1":         lambda s, a: s._set_duty("m1", int(a["duty"])),
    "duty_m2":         lambda s, a: s._set_duty("m2", int(a["duty"])),
    "duty_m1m2":       lambda s, a: (s._set_duty("m1", int(a["m1_duty"])),
                                     s._set_duty("m2", int(a["m2_duty"]))),
    "speed_m1":        lambda s, a: s._set_speed("m1", int(a["speed"])),
    "speed_m2":        lambda s, a: s._set_speed("m2", int(a["speed"])),
    "speed_m1m2":      lambda s, a: (s._set_speed("m1", int(a["m1_speed"])),
                                     s._set_speed("m2", int(a["m2_speed"]))),
    "speed_accel_decel_position_m1":
        lambda s, a: s._move_to_position("m1", int(a["position"]), int(a["speed"])),
    "speed_accel_decel_position_m2":
        lambda s, a: s._move_to_position("m2", int(a["position"]), int(a["speed"])),
    "speed_accel_decel_position_m1m2":
        lambda s, a: (s._move_to_position("m1", int(a["m1_position"]), int(a["m1_speed"])),
                      s._move_to_position("m2", int(a["m2_position"]), int(a["m2_speed"]))),
}

def _apply_simulated_command(self, spec, args):
    handler = _SIM_COMMANDS.get(spec.id)
    if handler is not None:
        handler(self, args)

def _apply_open_loop(self, ch, signed):     # extract the duplicated fwd/back math
    self._commands[ch] = signed
    self._speeds[ch]   = signed * 100
    self._pwms[ch]     = round(signed * 32767 / 127)
```

### 1c. `QueueService._tick` (CC 16) — Importance 7/10

Three independent concerns interleaved inside one `async with self._lock` block at [services/queue.py:203](src/radiotelescope/services/queue.py:203): (a) expire/idle the active lease, (b) drop the active lease on WS disconnect grace, (c) prune stale queued sessions. Cognitive complexity is high because each block reads from `self._sessions` differently.

**Remediation:** extract three lock-held helpers; `_tick` becomes a 6-line orchestrator. CC drops to ~4 each.

```python
async def _tick(self) -> bool:
    now = time.monotonic()
    async with self._lock:
        changed  = self._expire_active_locked(now)
        changed |= self._drop_active_on_disconnect_locked(now)
        changed |= self._prune_stale_queued_locked(now)
        if self._promote_if_idle():
            changed = True
    return changed
```

Each `_*_locked` returns `bool`. Naming carries the "lock held" contract; matches the existing `_drop_locked` convention at [services/queue.py:256](src/radiotelescope/services/queue.py:256).

### 1d. `RoboClawService.refresh` (CC 11) — Importance 5/10

The CC comes from nested `if … is not None` guards around the alt/az/ra/dec derivations at [services/roboclaw.py:129-153](src/radiotelescope/services/roboclaw.py:129). Readable, but the geometry concern is mixing with the polling concern.

**Remediation:** lift the derivation into `_derive_mount_state(snap) -> dict` in `services/geometry.py` (which already exists). `refresh` keeps the polling/broadcast skeleton; CC drops to ~4.

### 1e. `dump_types._ts_type` (CC 18) — Importance 3/10

Codegen script, runs at build time, has no production blast radius. Low priority. If touched, dispatch on `(origin, py_type)` via a small registry; otherwise leave it.

---

## 2. Cognitive Complexity (manual)

Cyclomatic ≠ cognitive. The functions below have lower CC but read harder because of nesting and mixed abstraction levels.

| Location | Function | Why it's hard | Importance |
|---|---|---|---|
| [services/queue.py:203](src/radiotelescope/services/queue.py:203) | `_tick` | three concerns interleaved, all touching the same locked state | 7/10 — see §1c |
| [main.py:41](src/radiotelescope/main.py:41) | `lifespan` | startup wiring for 6+ services in one function with try/except | 5/10 |
| [hardware/sdr.py:233](src/radiotelescope/hardware/sdr.py:233) | `SDRReceiver.stream` | bridges blocking `readStream` to asyncio with retries; nested try/except inside a generator | 5/10 |
| [api/routes_roboclaw.py:98](src/radiotelescope/api/routes_roboclaw.py:98) | `execute_command` | authz check, dispatch, side-effect (position target) all in one handler | 4/10 |

**Remediation for `lifespan`:** factor "build hardware clients" and "build services" into two helpers returning a `Resources` dataclass. The `try/finally` shell stays in `lifespan`; CC goes from 8 → ~3 and the wiring becomes testable without spinning up FastAPI.

---

## 3. LOC Metrics

| Threshold | File | LOC |
|---|---|---|
| Files > 300 | [hardware/roboclaw.py](src/radiotelescope/hardware/roboclaw.py) | **689** |
| Files > 300 | [api/routes_roboclaw.py](src/radiotelescope/api/routes_roboclaw.py) | **369** |
| Files > 300 | [api/auth.py](src/radiotelescope/api/auth.py) | **354** |

No function exceeds 50 lines. No class exceeds 500 lines (`SimulatedRoboClaw` is the largest, ~150 lines).

### 3a. `hardware/roboclaw.py` (689 LOC) — Importance 7/10

Holds **at least four cohesive groupings** that could live in their own files:
- `CommandSpec` / `ResponseSpec` / `COMMANDS` registry — pure data
- `_validate_args`, `_pack_value`, `_unpack_value`, `_status_flags` — codec helpers
- `SerialRoboClaw` — real hardware client
- `SimulatedRoboClaw` — fake client (the largest contributor to the file's MI=C grade)

**Remediation (drop-in, zero behaviour change):**

```
hardware/roboclaw/
    __init__.py        # re-exports public API for callers that do `from ...roboclaw import X`
    commands.py        # CommandSpec, ResponseSpec, COMMANDS, _response_specs
    codec.py           # _validate_args, _pack_value, _unpack_value, _status_flags
    serial_client.py   # SerialRoboClaw, make_client, build_snapshot
    simulator.py       # SimulatedRoboClaw
```

`__init__.py`:
```python
from .commands import COMMANDS, CommandSpec, ResponseSpec, _response_specs  # noqa: F401
from .codec import _validate_args, _pack_value, _unpack_value, _status_flags  # noqa: F401
from .serial_client import SerialRoboClaw, make_client, build_snapshot  # noqa: F401
from .simulator import SimulatedRoboClaw  # noqa: F401
```

Callers like `from radiotelescope.hardware.roboclaw import make_client` keep working unchanged.

### 3b. `api/routes_roboclaw.py` (369 LOC) — Importance 4/10

Hosts ~10 endpoints. At ~37 LOC each it's not yet painful, but `sync_alt_az` (CC 7) and `home_elevation` (CC 7) are doing service-layer work inside route handlers. Move the geometry math into `services/geometry.py` (already exists) or `services/roboclaw.py` and let the routes stay HTTP-adapter-thin. Not urgent.

### 3c. `api/auth.py` (354 LOC) — Importance 3/10

Most of that is the `_LOGIN_PAGE` HTML constant. Splitting it into a sibling `_login_page.html` loaded via `pkg_resources` (or `importlib.resources`) drops the file to ~150 LOC and lets the login UI be edited without touching middleware. Optional.

---

## 4. Coupling

Quick read of inbound (afferent / `Ca`) and outbound (efferent / `Ce`) dependencies across first-party imports:

| Module | Ca | Ce | Instability `Ce/(Ca+Ce)` | Notes |
|---|---|---|---|---|
| `models/state.py` | ~10 | 0 | **0.00** (stable) | Pure data, correct — everyone depends on it. |
| `hardware/roboclaw.py` (the file) | 4 | 1 | 0.20 | Stable. Internally bloated (§3a) — split it but coupling is fine. |
| `services/roboclaw.py` | 2 | 6 | 0.75 | Pulls hardware + geometry + pointing + models. Expected for a service. |
| `main.py` | 0 | 14 | **1.00** (unstable) | Correct — composition root. |
| `api/routes_roboclaw.py` | 0 | 6 | 1.00 | Route module, expected. |

No problematic cycles observed; layering (hardware → services → api) is respected. **No coupling-driven refactor required.** Importance: 2/10.

---

## 5. Cohesion

Most modules are tightly focused:

- `safety/`, `services/_pubsub.py`, `services/geometry.py`, `models/state.py`, `api/security_headers.py` — single, clear responsibility. **Good.**
- `services/roboclaw.py` — two concerns: (a) poll loop / broadcast and (b) mount geometry derivation in `refresh`. See §1d. Importance 4/10.
- `hardware/roboclaw.py` — four concerns in one file (see §3a). The **biggest cohesion problem in the repo.** Importance 6/10 (file is large; logically several modules).
- `api/auth.py` — mixes ASGI middleware, an `AuthManager`, and an HTML page constant. Mild. Importance 3/10.

`SimulatedRoboClaw` and `SerialRoboClaw` share the `RoboClawClient` protocol but otherwise have nothing in common — strong evidence they should not share a module (§3a).

---

## 6. Prioritised Punch List

| Rank | Item | Importance | Effort |
|---|---|---|---|
| 1 | Split `hardware/roboclaw.py` into a package (§3a) | 7/10 | ~1 h, mechanical |
| 2 | Dispatch-table refactor of `_simulated_value` + `_apply_simulated_command` (§1a, §1b) | 8/10 | ~1 h, covered by existing tests |
| 3 | Extract `_expire_active_locked` / `_drop_active_on_disconnect_locked` / `_prune_stale_queued_locked` from `QueueService._tick` (§1c) | 7/10 | ~30 min |
| 4 | Move alt/az/ra/dec derivation out of `RoboClawService.refresh` into `services/geometry.py` (§1d) | 5/10 | ~30 min |
| 5 | Factor `lifespan` startup into resource-builder helpers (§2) | 5/10 | ~45 min |
| 6 | Extract `_LOGIN_PAGE` HTML to a resource file (§3c) | 3/10 | ~15 min |
| 7 | `dump_types._ts_type` registry refactor (§1e) | 3/10 | only if touched |

---

## 7. Things I could not verify

- **No runtime profiling.** "Importance" is structural, not based on measured hot paths. If `QueueService._tick` runs at 1 Hz with <10 sessions, its CC is harmless even though the structural smell remains.
- **Afferent counts** in §4 are import-graph based, not call-graph based. A call-graph would need `pyan`/`pydeps` or AST tooling not available in this audit.
- **Test coverage** for `SimulatedRoboClaw` was not measured. The dispatch-table refactor (§1b) is safe iff the existing tests exercise each `spec.id` branch — unverified. Run `pytest --cov=radiotelescope.hardware.roboclaw` before/after to confirm.

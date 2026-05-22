# Technical Debt & Bloat Audit

Scope: all Python source under `src/`, all TypeScript/TSX under `frontend/src/`, config, and deployment tooling.  
Excluded: `node_modules`, build output, `*.jsonl` data files.

Each finding has a **type** (Stopgap | Standardization | Bloat), an **impact** rating (1–5), and a rough **effort** to fix (S/M/L).

---

## Stopgaps — temporary solutions left in place

### 1. `dump_types.py` — hand-rolled Pydantic→TypeScript emitter
**Impact:** 4 | **Effort:** S

`src/radiotelescope/scripts/dump_types.py` is a bespoke 155-line script that reflects a curated subset of Pydantic models into TypeScript interfaces. FastAPI already generates a complete, authoritative OpenAPI 3.1 spec at `/openapi.json` for free. The hand-rolled emitter only covers models manually listed in `EXPORTED_MODELS`, so any model added without updating that tuple silently disappears from the frontend's type system.

The script was introduced to fix drift from a fully hand-written `types.ts`. It solved that problem but stopped one step short of the standard solution: `openapi-typescript` (zero runtime, types only) pointed at the running server or a committed spec file.

The downstream consequence is already visible: `QueueConfigResponse` exists as a Pydantic model in `routes_queue.py` but was never added to `EXPORTED_MODELS`, so `QueueConfig` in `queue.ts` is hand-written and independently maintained — exactly the drift problem `dump_types.py` was supposed to eliminate.

**Fix:** replace `sync-types` in `frontend/package.json` with `npx openapi-typescript http://localhost:PORT/openapi.json -o src/types.gen.ts`. Add `QueueConfigResponse` as a proper Pydantic model (it already exists, just needs exposing). Delete `dump_types.py`.

---

### 2. `QueueConfig` in `queue.ts` is hand-maintained
**Impact:** 3 | **Effort:** S

`frontend/src/queue.ts` contains:
> "QueueConfig lives only on the wire (no backend Pydantic model — it is assembled by the /api/queue/config route from a handful of fields), so it stays hand-written."

This comment is incorrect. `QueueConfigResponse` is a fully defined Pydantic model in `routes_queue.py:28`. It wasn't added to `EXPORTED_MODELS` in `dump_types.py`, so the frontend duplicates it by hand. Fixing finding #1 above resolves this automatically.

---

### 3. Login page HTML embedded as a Python string
**Impact:** 3 | **Effort:** M

`api/auth.py` contains `_LOGIN_PAGE`, a 75-line raw HTML string with its own inline `<style>` block. It is served from a FastAPI route and styled independently of the Vite-built frontend. The color palette and font stack are manually duplicated from `main.css` and will drift whenever the UI is restyled. The page title is hardcoded as "Radio Telescope — Sign In" rather than using `BRAND.name`. It labels itself "Beta Access Password," confirming it was always intended as temporary.

The right integration is to build the login page as part of the Vite frontend and serve it as a static file, the same way `index.html` is served. The backend only needs to know which paths are exempt from the auth check — it doesn't need to generate the HTML.

---

### 4. Plaintext passwords in `passwords.txt`
**Impact:** 3 | **Effort:** S

`auth.py` loads passwords as plaintext strings and compares them with `hmac.compare_digest`. The file ships with commented example entries. Bcrypt or Argon2 hashing is standard for stored credentials. The comparison-timing protection (`hmac.compare_digest`) is present but the storage is not. Fine for a closed beta; wrong for anything longer-lived.

---

### 5. In-memory brute-force lockout lost on restart
**Impact:** 2 | **Effort:** S

`AuthManager._records` is a plain in-memory dict. Any lockout state — including active lockouts during an attack — is wiped when the server restarts. A simple shelf or SQLite write of locked IPs would survive restarts. Low priority while auth is in beta mode, but worth noting.

---

### 6. `branding.ts` logo and favicon are external URLs
**Impact:** 2 | **Effort:** S

```ts
logoUrl: 'https://titanobservatory.org/_next/image?url=%2Fimages%2F2.webp&w=828&q=75',
faviconUrl: 'https://titanobservatory.org/icon.png',
```

Both point at the main website's Next.js image pipeline. If the main site is down, restructured, or the query params change, the radio telescope UI loses its branding silently. These should be local static assets served by the same Vite build.

---

### 7. `deploy.sh` doesn't run `sync-types`
**Impact:** 3 | **Effort:** S

`deploy.sh` runs `git pull → npm install → npm run build → pip install → systemctl restart`. It does not run `npm run sync-types` before building. If a backend model field changes, the deploy will compile the frontend against stale type declarations and ship silently broken types. TypeScript catches this at compile time only if the types are regenerated first.

**Fix:** add `npm run sync-types` before `npm run build` in `deploy.sh`. Switching to `openapi-typescript` (finding #1) makes this simpler since the server can be started temporarily during deploy to generate the spec.

---

### 8. `audits/duplication-audit.md` committed to the repo
**Impact:** 1 | **Effort:** S

There is a 674-line AI-generated audit file in `audits/`. It was accurate at the time of generation but is already partially stale: several issues it identified (notably the pub/sub duplication) have since been resolved via `services/_pubsub.py`. Committed audit documents become misleading guides as the code evolves. The findings from both audits should be tracked as issues or tickets and the files removed from the repo.

---

## Standardization — things that work but diverge from their own patterns

### 9. `geometry.py` and `astro.ts` are manually kept in sync
**Impact:** 3 | **Effort:** M

`src/radiotelescope/geometry.py` includes this docstring:
> "The matching TypeScript copies in `frontend/src/lib/altaz.ts` are kept manually in sync — there is no client-side route to invoke this code, and inlined feedback during the user's click on the sky map needs synchronous local execution."

The same duplication extends to coordinate math. `src/radiotelescope/pointing.py` uses `katpoint` for `radec_to_altaz` and `altaz_to_radec`. `frontend/src/lib/astro.ts` reimplements Julian Day, GMST, local sidereal time, RA/Dec↔Alt/Az conversion, sun position, moon position, and moon illumination from scratch in TypeScript — low-precision versions for real-time UI feedback, but independent implementations of the same math. When `katpoint` or the server's coordinate pipeline changes, the client-side math won't automatically track.

This is a real architectural tension: synchronous local execution in the browser requires a JS implementation. The options are (a) accept the duplication with explicit precision disclaimers in comments, (b) use a WASM build of a C coordinate library, or (c) use a WebWorker that calls the server for precision coordinates and interpolates locally for the animation frame rate. Option (a) is probably still the right call, but the duplication should be documented explicitly as intentional and the tolerance between the two implementations should be tested.

---

### 10. `auth` cookie name hardcoded; queue cookie name configurable
**Impact:** 1 | **Effort:** S

`api/auth.py` has `_COOKIE_NAME = "rt_auth"` as a module-level constant. `QueueConfig.cookie_name` is a configurable field in `config.py`. Both cookies live on the same domain. Inconsistency. If the auth cookie ever needs to be renamed (e.g., to avoid collision with another service on the same hostname), it requires a code change rather than a config change.

---

### 11. `HostStats` reports client machine stats in gateway-client mode
**Impact:** 3 | **Effort:** M

`RoboClawTelemetry.host` is populated by `hardware/host_stats.py`, which reads from the local machine via `/proc/stat`, `psutil`-equivalent syscalls, and `/sys/class/thermal`. In `gateway-client` mode, the telescope service runs on the Windows host machine, not the Raspberry Pi. The telemetry panel therefore shows the Windows host's CPU temp, load average, and disk usage — not the Pi's, where the hardware actually lives and where those metrics matter. The remote `RoboClawService` client doesn't forward the Pi's host stats; they are read locally and silently reflect the wrong machine.

**Fix:** either forward `HostStats` from the gateway-server as part of the telemetry response, or suppress `host` in gateway-client mode rather than reporting misleading data.

---

## Questionable value — features whose complexity cost may exceed their benefit

### 12. `GET /api/telescope/goto` info endpoint
**Impact:** 2 | **Effort:** S

`routes_roboclaw.py` registers a GET handler at `/api/telescope/goto` that returns a JSON blob describing what the POST body should look like — motor mapping, speed defaults, encoder counts. It is not consumed by the frontend (confirmed by search) and will drift from the actual implementation as config changes. FastAPI's auto-generated OpenAPI docs at `/docs` cover this more accurately and automatically. The endpoint is ~25 lines of hand-maintained documentation masquerading as an API route.

---

### 13. Guided observation tour with hardcoded celestial targets
**Impact:** 2 | **Effort:** M

`frontend/src/guidedObservation.ts` drives a step-by-step observation walkthrough that slews to:
- **Reference:** RA 192.86°, Dec 27.13° (North Galactic Pole, low HI)
- **Target:** RA 305.0°, Dec 40.7° (Cygnus, galactic plane)

These coordinates are hardcoded. The Cygnus target at Dec +40.7° is below the horizon from southern latitudes. Both targets are only well-placed during specific months of the year; outside those windows the slew will either fail pointing limits or point at a patch of sky with no visibility. If the telescope moves to a different site, the hardcoded targets silently stop working without any error message to the user.

These should come from the server (computed from observer lat/lon and current time) or at minimum have a horizon-check before the slew button triggers.

---

### 14. `FeedbackDialog` writes to a file no one can read
**Impact:** 2 | **Effort:** S

`FeedbackDialog.tsx` (via `@radix-ui/react-dialog`) lets users submit a 1–5 star rating and optional comment, which is appended to `feedback.jsonl`. There is no read endpoint, no admin view, and no notification mechanism. Viewing the feedback requires SSH access and `tail feedback.jsonl`. The analytics event log (`events.jsonl` via `track('feedback_submitted', ...)`) already captures that feedback happened and the rating. Until an admin dashboard surfaces the feedback content, the dialog is effectively write-only and the dependency on `@radix-ui/react-dialog` exists solely for a write-only feature.

This becomes worthwhile once the admin dashboard lands. Flag it now so the read side is built at the same time as the dashboard rather than after.

---

### 15. `driver.js` tour dependency for optional onboarding
**Impact:** 2 | **Effort:** M

`tour.ts` and the first-visit prompt together import `driver.js` and its CSS — a ~90KB npm package — for an optional UI tour that most returning users will never trigger again. The tour is a real feature for first-time visitors, but the implementation has some rough edges: the first-visit prompt fires 600ms after the user gains control (`setTimeout(..., 600)`), which feels like an interruption if the user already knows what they're doing. The mobile vs. desktop step branching is correct in intent but forks into slightly different code paths with no shared test coverage.

The tour is worth keeping. The dependency cost is acceptable. Worth auditing whether `hasSeenAnyOnboarding()` in localStorage is being respected (if a browser clears storage, the tour re-fires on next visit).

---

### 16. Append-only JSONL logs with no rotation or size cap
**Impact:** 2 | **Effort:** S

`events.jsonl` and `feedback.jsonl` are append-only files with no maximum size, no rotation, and no cleanup policy. On a busy public demo with many sessions, `events.jsonl` grows at a rate proportional to user activity (every click, scroll, keypress, queue join, etc. is tracked). Config has `events_log_path` and `feedback_log_path` as path strings but no corresponding size or retention options. Worth adding a `max_log_size_mb` config value and a simple rotate-on-open strategy before this becomes a disk space issue on the Pi.

---

## Summary table

| # | Finding | Type | Impact | Effort |
|---|---|---|---|---|
| 1 | `dump_types.py` instead of `openapi-typescript` | Stopgap | 4 | S |
| 2 | `QueueConfig` hand-written despite existing Pydantic model | Stopgap | 3 | S |
| 3 | Login page as raw HTML string in Python | Stopgap | 3 | M |
| 4 | Plaintext passwords in `passwords.txt` | Stopgap | 3 | S |
| 5 | In-memory brute-force lockout lost on restart | Stopgap | 2 | S |
| 6 | Logo/favicon as external URLs in `branding.ts` | Stopgap | 2 | S |
| 7 | `deploy.sh` doesn't regenerate types before building | Stopgap | 3 | S |
| 8 | `audits/duplication-audit.md` committed and going stale | Stopgap | 1 | S |
| 9 | `geometry.py` / `astro.ts` manually kept in sync | Standardization | 3 | M |
| 10 | Auth cookie name hardcoded vs. queue cookie configurable | Standardization | 1 | S |
| 11 | `HostStats` reports wrong machine in gateway-client mode | Standardization | 3 | M |
| 12 | `GET /api/telescope/goto` info-only endpoint | Bloat | 2 | S |
| 13 | Hardcoded celestial targets in guided observation | Bloat | 2 | M |
| 14 | `FeedbackDialog` writes to file with no read path | Bloat | 2 | S |
| 15 | `driver.js` for optional tour | Bloat | 2 | M |
| 16 | Append-only logs with no rotation | Bloat | 2 | S |

// Queue types. The backend `QueueStatus` shape is generated into `./types`
// by `python -m radiotelescope.scripts.dump_types`; we re-export it from
// here so existing call sites keep working. `QueueConfig` lives only on the
// wire (no backend Pydantic model — it is assembled by the `/api/queue/config`
// route from a handful of fields), so it stays hand-written.
//
// Network helpers for the queue live alongside the rest of the REST surface
// in `./api.ts` — see `api.queueConfig`, `api.queueStatus`, `api.joinQueue`,
// `api.leaveQueue`.

export type { QueueStatus } from './types';

export interface QueueConfig {
  enabled: boolean;
  turnstile_enabled: boolean;
  turnstile_site_key: string;
  max_session_seconds: number;
  idle_timeout_seconds: number;
}

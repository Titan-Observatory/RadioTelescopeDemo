import type { CommandInfo, CommandResult, LnaStatus, RaDecTarget, RoboClawTelemetry, TelescopeConfig } from './types';
import type { QueueConfig, QueueStatus } from './queue';

export type JogDirection = 'west' | 'east' | 'up' | 'down';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export class RateLimitError extends ApiError {
  /** Seconds until the next slot opens, derived from the Retry-After header.
   *  Falls back to 1 when the server didn't send the header. */
  public readonly retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(429, message);
    this.retryAfterSec = retryAfterSec;
  }
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 1;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  // Retry-After can also be an HTTP-date; convert to remaining seconds.
  const target = Date.parse(header);
  if (!Number.isNaN(target)) {
    return Math.max(1, Math.ceil((target - Date.now()) / 1000));
  }
  return 1;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = typeof data?.detail === 'string' ? data.detail : resp.statusText;
    if (resp.status === 429) {
      throw new RateLimitError(detail, parseRetryAfter(resp.headers.get('Retry-After')));
    }
    throw new ApiError(resp.status, detail);
  }
  return data as T;
}

// The RoboClaw goto endpoints accept an optional `decel_qpps2`; today every
// caller drives both ramps from the same `accel` knob, so default the decel
// to the accel when the caller doesn't override it. Centralising the shape
// here keeps the two goto wrappers from drifting apart.
function motionParams(speedQpps?: number, accelQpps2?: number, decelQpps2?: number) {
  return {
    speed_qpps: speedQpps,
    accel_qpps2: accelQpps2,
    decel_qpps2: decelQpps2 ?? accelQpps2,
  };
}

export const api = {
  status: () => request<RoboClawTelemetry>('GET', '/api/roboclaw/status'),
  commands: () => request<CommandInfo[]>('GET', '/api/roboclaw/commands'),
  execute: (commandId: string, args: Record<string, number | boolean>) =>
    request<CommandResult>('POST', `/api/roboclaw/commands/${commandId}`, { args }),
  jog: (direction: JogDirection, speed: number, token: string, seq: number) =>
    request<{ ok: boolean; accepted: boolean; stale?: boolean; seq?: number }>('POST', '/api/telescope/jog', {
      direction,
      speed,
      token,
      seq,
    }),
  stopJog: (token: string, seq: number) =>
    request<Record<string, CommandResult>>('POST', '/api/telescope/jog/stop', { token, seq }),
  telescopeConfig: () => request<TelescopeConfig>('GET', '/api/telescope/config'),
  gotoAltAz: (altitudeDeg: number, azimuthDeg: number, speedQpps?: number, accelQpps2?: number, decelQpps2?: number) =>
    request<CommandResult>('POST', '/api/telescope/goto', {
      altitude_deg: altitudeDeg,
      azimuth_deg: azimuthDeg,
      ...motionParams(speedQpps, accelQpps2, decelQpps2),
    }),
  gotoRaDec: (target: RaDecTarget, speedQpps?: number, accelQpps2?: number, decelQpps2?: number) =>
    request<CommandResult>('POST', '/api/telescope/goto_radec', {
      ra_deg: target.ra_deg,
      dec_deg: target.dec_deg,
      ...motionParams(speedQpps, accelQpps2, decelQpps2),
    }),
  homeElevation: (speed: number) =>
    request<{ status: string; message: string }>('POST', '/api/telescope/home/elevation', { speed }),
  stop: () => request<Record<string, CommandResult>>('POST', '/api/roboclaw/stop'),
  setSpectrumLna: (enabled: boolean) =>
    request<{ ok: boolean; lna: LnaStatus }>('POST', '/api/spectrum/lna', { enabled }),
  // ─── Queue ────────────────────────────────────────────────────────────
  queueConfig: () => request<QueueConfig>('GET', '/api/queue/config'),
  queueStatus: () => request<QueueStatus>('GET', '/api/queue/status'),
  joinQueue: (turnstileToken: string | null, betaPassword: string | null) =>
    request<QueueStatus>('POST', '/api/queue/join', { turnstile_token: turnstileToken, beta_password: betaPassword }),
  leaveQueue: () => request<void>('POST', '/api/queue/leave'),
};

export async function submitFeedback(rating: number, message: string): Promise<void> {
  await request<{ ok: boolean }>('POST', '/api/feedback', { rating, message });
}

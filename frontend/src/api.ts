import type { CommandInfo, CommandResult, RaDecTarget, RoboClawTelemetry, TelescopeConfig } from './types';
import type { QueueConfig, QueueStatus } from './queue';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
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
  stop: () => request<Record<string, CommandResult>>('POST', '/api/roboclaw/stop'),
  // ─── Queue ────────────────────────────────────────────────────────────
  queueConfig: () => request<QueueConfig>('GET', '/api/queue/config'),
  queueStatus: () => request<QueueStatus>('GET', '/api/queue/status'),
  joinQueue: (turnstileToken: string | null) =>
    request<QueueStatus>('POST', '/api/queue/join', { turnstile_token: turnstileToken }),
  leaveQueue: () => request<void>('POST', '/api/queue/leave'),
};

export async function submitFeedback(rating: number, message: string): Promise<void> {
  await request<{ ok: boolean }>('POST', '/api/feedback', { rating, message });
}

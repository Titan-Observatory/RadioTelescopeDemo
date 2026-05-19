// Pure formatting + classification helpers for telemetry values. No React,
// no side effects — safe to import from anywhere.

import { ApiError } from '../api';

export function volts(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(2)} V`;
}

export function celsius(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(1)} °C`;
}

export function amps(input: number | null | undefined): string {
  return input == null ? '—' : `${Math.abs(input).toFixed(2)} A`;
}

export function encoder(input: number | null | undefined): string {
  return input == null ? '—' : input.toLocaleString();
}

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

export function minReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length === 0 ? null : Math.min(...present);
}

export function maxReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length === 0 ? null : Math.max(...present);
}

export function maxAbsReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null).map(Math.abs);
  return present.length === 0 ? null : Math.max(...present);
}

// Encoder quantisation and PWM telemetry both jitter by ±1 around zero when the
// motors are commanded off. Without a deadband the state readout flickers
// between Moving/Idle every poll. 2 QPPS / 2 PWM counts is well below any real
// commanded motion (slewing runs at hundreds of QPPS) so it's safe to ignore.
const MOTOR_SPEED_DEADBAND_QPPS = 2;
const MOTOR_OUTPUT_DEADBAND = 2;

export function motorState(speed: number | null, output: number | null): string {
  if (speed == null && output == null) return '—';
  const moving =
    (speed ?? 0) > MOTOR_SPEED_DEADBAND_QPPS ||
    (output ?? 0) > MOTOR_OUTPUT_DEADBAND;
  return moving ? 'Moving' : 'Idle';
}

export function voltClass(v: number | null | undefined): string {
  if (v == null) return '';
  if (v < 10) return 'val-crit';
  if (v < 11.5) return 'val-warn';
  return 'val-ok';
}

export function tempClass(c: number | null | undefined): string {
  if (c == null) return '';
  if (c > 75) return 'val-crit';
  if (c > 60) return 'val-warn';
  return '';
}

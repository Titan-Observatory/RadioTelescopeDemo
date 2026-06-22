import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Square } from 'lucide-react';
import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { track } from '../analytics';
import type { JogDirection } from '../api';
import {
  altAzToRaDec,
  galacticToRaDec,
  raDecToAltAz,
  raDecToGalactic,
} from '../lib/astro';
import type { TelescopeConfig } from '../types';

const JOG_REPEAT_MS = 250;

function makeJogToken() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Hook: turn a button into a press-and-hold jog. Reissues `start` every
// JOG_REPEAT_MS while pressed, and every packet carries a per-press token plus
// monotonically increasing sequence number. The backend ignores stale packets
// and stops automatically if heartbeats stop arriving.
function useJog(
  direction: JogDirection,
  speed: number,
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>,
  stopJog: (token: string, seq: number) => Promise<void>,
  onPress?: () => void,
) {
  const [active, setActive] = useState(false);
  const timerRef = useRef<number | null>(null);
  const tokenRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  // Drop ticks while the previous request is still in flight so a slow link
  // (or a hardware that briefly stalls) can't queue up a backlog of jogs.
  // The hardware-side watchdog tolerates up to 1 s between heartbeats; one
  // skipped tick is well within that.
  const inFlightRef = useRef(false);
  const directionRef = useRef(direction);
  const speedRef = useRef(speed);
  const jogRef = useRef(jog);
  const stopJogRef = useRef(stopJog);
  const onPressRef = useRef(onPress);
  directionRef.current = direction;
  speedRef.current = speed;
  jogRef.current = jog;
  stopJogRef.current = stopJog;
  onPressRef.current = onPress;

  const end = useCallback(() => {
    const token = tokenRef.current;
    if (timerRef.current == null || token == null) return;
    window.clearInterval(timerRef.current);
    timerRef.current = null;
    tokenRef.current = null;
    setActive(false);
    void stopJogRef.current(token, ++seqRef.current);
  }, []);

  const cancelHeartbeatOnly = useCallback(() => {
    if (timerRef.current == null) return;
    window.clearInterval(timerRef.current);
    timerRef.current = null;
    tokenRef.current = null;
    setActive(false);
  }, []);

  const sendTick = useCallback((token: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    jogRef.current(directionRef.current, speedRef.current, token, ++seqRef.current)
      .finally(() => { inFlightRef.current = false; });
  }, []);

  const begin = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left-click only on mouse
    if (timerRef.current != null) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const token = makeJogToken();
    tokenRef.current = token;
    seqRef.current = 0;
    inFlightRef.current = false;
    setActive(true);
    onPressRef.current?.();
    sendTick(token);
    timerRef.current = window.setInterval(() => {
      const currentToken = tokenRef.current;
      if (currentToken == null) return;
      sendTick(currentToken);
    }, JOG_REPEAT_MS);
  }, [sendTick]);

  useEffect(() => {
    window.addEventListener('blur', cancelHeartbeatOnly);
    document.addEventListener('visibilitychange', cancelHeartbeatOnly);
    return () => {
      window.removeEventListener('blur', cancelHeartbeatOnly);
      document.removeEventListener('visibilitychange', cancelHeartbeatOnly);
      cancelHeartbeatOnly();
    };
  }, [cancelHeartbeatOnly]);

  return {
    active,
    onPointerDown: begin,
    onPointerUp: end,
    onPointerCancel: cancelHeartbeatOnly,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  } as const;
}

function PointingPad({ jog, stopJog, speed, onStop }: {
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>;
  stopJog: (token: string, seq: number) => Promise<void>;
  speed: number;
  onStop: () => Promise<void>;
}) {
  // Track on press only (not every repeat tick) — useJog's start fires every
  // JOG_REPEAT_MS while held, which would flood the events log otherwise.
  const onPress = (direction: 'west' | 'east' | 'up' | 'down') =>
    track('jog_pressed', { direction, speed });

  const west = useJog('west', speed, jog, stopJog, () => onPress('west'));
  const east = useJog('east', speed, jog, stopJog, () => onPress('east'));
  const down = useJog('down', speed, jog, stopJog, () => onPress('down'));
  const up   = useJog('up', speed, jog, stopJog, () => onPress('up'));

  return (
    <div className="pointing-pad" role="group" aria-label="Pointing controls">
      <button type="button" className={`pad-btn pad-up${up.active ? ' jog-active' : ''}`} {...up} aria-label="Up">
        <ChevronUp size={36} strokeWidth={2.25} />
      </button>
      <button type="button" className={`pad-btn pad-west${west.active ? ' jog-active' : ''}`} {...west} aria-label="West">
        <ChevronLeft size={36} strokeWidth={2.25} />
      </button>
      <button
        type="button"
        className="pad-btn pad-stop"
        onClick={() => { track('stop_pressed', { source: 'pad' }); void onStop(); }}
        aria-label="Stop all motion"
        title="Stop all motion"
      >
        <Square size={18} fill="currentColor" strokeWidth={0} />
      </button>
      <button type="button" className={`pad-btn pad-east${east.active ? ' jog-active' : ''}`} {...east} aria-label="East">
        <ChevronRight size={36} strokeWidth={2.25} />
      </button>
      <button type="button" className={`pad-btn pad-down${down.active ? ' jog-active' : ''}`} {...down} aria-label="Down">
        <ChevronDown size={36} strokeWidth={2.25} />
      </button>
    </div>
  );
}

// The go-to row accepts coordinates in any of three systems; whichever the
// operator picks is converted to J2000 RA/Dec before pinning the target, since
// that is the one coordinate the sky map speaks.
type CoordSystem = 'radec' | 'altaz' | 'galactic';

interface AxisSpec {
  /** Short label shown inside the field (RA, Dec, Alt, …). */
  prefix: string;
  /** Unit suffix shown after the value. */
  unit: string;
  /** Max digits before the decimal point the numeric filter allows. */
  maxInt: number;
  /** Whether a leading minus is permitted (latitude-like axes). */
  allowNegative: boolean;
  min: number;
  max: number;
  placeholder: string;
}

interface SystemSpec {
  /** Segment label on the slider. */
  label: string;
  /** First (top-of-form) axis and second axis, in display order. */
  a: AxisSpec;
  b: AxisSpec;
}

// Axes are listed in the same order the slider segment names them, so the field
// labels always read the way the chosen system is written.
const COORD_SYSTEMS: Record<CoordSystem, SystemSpec> = {
  radec: {
    label: 'RA/Dec',
    a: { prefix: 'RA', unit: 'h', maxInt: 2, allowNegative: false, min: 0, max: 24, placeholder: '20.690' },
    b: { prefix: 'Dec', unit: '°', maxInt: 2, allowNegative: true, min: -90, max: 90, placeholder: '45.300' },
  },
  altaz: {
    label: 'Alt/Az',
    a: { prefix: 'Alt', unit: '°', maxInt: 2, allowNegative: true, min: -90, max: 90, placeholder: '45.000' },
    b: { prefix: 'Az', unit: '°', maxInt: 3, allowNegative: false, min: 0, max: 360, placeholder: '180.000' },
  },
  galactic: {
    label: 'Gal',
    a: { prefix: 'l', unit: '°', maxInt: 3, allowNegative: false, min: 0, max: 360, placeholder: '120.000' },
    b: { prefix: 'b', unit: '°', maxInt: 2, allowNegative: true, min: -90, max: 90, placeholder: '10.000' },
  },
};

const SYSTEM_ORDER: CoordSystem[] = ['radec', 'altaz', 'galactic'];

// Convert a valid (a, b) pair in the given system to J2000 RA/Dec degrees.
// Alt/Az needs the observer location + a timestamp; returns null when that
// context is missing so the caller can treat the input as not-yet-resolvable.
function systemToRaDec(
  system: CoordSystem, a: number, b: number, config: TelescopeConfig | null, date: Date,
): { ra_deg: number; dec_deg: number } | null {
  if (system === 'radec') return { ra_deg: a * 15, dec_deg: b };
  if (system === 'galactic') return galacticToRaDec(a, b);
  if (!config) return null;
  return altAzToRaDec({ altitude_deg: a, azimuth_deg: b }, config, date);
}

// Inverse of systemToRaDec: format an RA/Dec position as the two field strings
// for the given system, so picking a point on the map (or switching systems)
// refills the inputs in the active coordinates.
function raDecToSystemFields(
  system: CoordSystem, raDeg: number, decDeg: number, config: TelescopeConfig | null, date: Date,
): [string, string] | null {
  if (system === 'radec') return [(raDeg / 15).toFixed(3), decDeg.toFixed(3)];
  if (system === 'galactic') {
    const g = raDecToGalactic(raDeg, decDeg);
    return [g.l_deg.toFixed(3), g.b_deg.toFixed(3)];
  }
  if (!config) return null;
  const p = raDecToAltAz(raDeg, decDeg, config, date);
  return [p.altitude_deg.toFixed(3), p.azimuth_deg.toFixed(3)];
}

// Floating control handset for the dish. Reads top to bottom the way an
// operator thinks: where the dish is pointing (live readout + motion state),
// how to nudge it (pad), and where to send it (inline go-to row).
// Both interaction modes stay visible at once — no tabs hiding the other half.
// The typed go-to accepts RA/Dec, Alt/Az, or galactic coordinates (a slider
// switches between them); whichever you pick is converted to RA/Dec. Rather
// than slewing directly, entering valid coordinates drops the target pin on the
// sky map (exactly as clicking it would), so the shared Slew button confirms
// the move just like a map click.
export function MotionControls({
  jog, stopJog, onPickTarget, onStop, targetRaDeg, targetDecDeg, config,
}: {
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>;
  stopJog: (token: string, seq: number) => Promise<void>;
  /** Pin a target on the sky map at the given RA/Dec (degrees). */
  onPickTarget: (raDeg: number, decDeg: number) => void;
  onStop: () => Promise<void>;
  /** RA/Dec (degrees) of the latest sky-map click, to prefill the GoTo inputs. */
  targetRaDeg?: number | null;
  targetDecDeg?: number | null;
  /** Observer location, required to resolve Alt/Az input into RA/Dec. */
  config?: TelescopeConfig | null;
}) {
  const [system, setSystem] = useState<CoordSystem>('radec');
  const [aText, setAText] = useState('');
  const [bText, setBText] = useState('');
  const speed = Math.round(85 * 127 / 100);

  const sys = COORD_SYSTEMS[system];
  const cfg = config ?? null;

  // Accept a keystroke only if the whole field stays a number within the axis's
  // integer-digit budget and at most three decimals (so letters, extra dots and
  // 4th decimals never make it in). An empty field and a lone leading "-" (on
  // axes that allow it) are allowed mid-typing.
  const filterNumeric = (raw: string, axis: AxisSpec): string | null => {
    const sign = axis.allowNegative ? '-?' : '';
    const re = new RegExp(`^${sign}\\d{0,${axis.maxInt}}(\\.\\d{0,3})?$`);
    return re.test(raw) ? raw : null;
  };

  // Mirror the clicked sky position into the GoTo inputs, converted to whatever
  // system is selected, so picking a point on the map — or flipping the slider —
  // fills in where to slew in the active coordinates.
  useEffect(() => {
    if (targetRaDeg == null || targetDecDeg == null) return;
    const fields = raDecToSystemFields(system, targetRaDeg, targetDecDeg, cfg, new Date());
    if (!fields) return;
    setAText(fields[0]);
    setBText(fields[1]);
  }, [targetRaDeg, targetDecDeg, system, cfg]);

  const aVal = parseFloat(aText);
  const bVal = parseFloat(bText);
  const aValid = Number.isFinite(aVal) && aVal >= sys.a.min && aVal <= sys.a.max;
  const bValid = Number.isFinite(bVal) && bVal >= sys.b.min && bVal <= sys.b.max;
  // Alt/Az can't be resolved without an observer location; treat it as invalid
  // until the config has loaded rather than silently dropping the pin.
  const configReady = system !== 'altaz' || cfg != null;
  const targetValid = aValid && bValid && configReady;
  // Only flag a field red once it has content; an empty field is incomplete, not wrong.
  const aInvalid = aText.trim() !== '' && !aValid;
  const bInvalid = bText.trim() !== '' && !bValid;

  // Commit the typed coordinates as the map target. Fires on Enter and when a
  // field loses focus, so finishing the pair drops the pin and reveals the
  // shared Slew button — without re-pinning on every keystroke mid-number.
  const pickTarget = () => {
    if (!targetValid) return;
    const rd = systemToRaDec(system, aVal, bVal, cfg, new Date());
    if (!rd) return;
    onPickTarget(rd.ra_deg, rd.dec_deg);
  };

  const submitTarget = (e: FormEvent) => {
    e.preventDefault();
    pickTarget();
  };

  return (
    <div className="motion-panel">
      <header className="motion-head">
        <span className="motion-head-title">Pointing</span>
      </header>

      <div className="motion-card">
        <PointingPad jog={jog} stopJog={stopJog} speed={speed} onStop={onStop} />
      </div>

      <form className="target-form-overlay" onSubmit={submitTarget} aria-label="Go to celestial coordinates">
        <div className="motion-goto-head">
          <span className="motion-goto-label">Go to</span>
          {/* Compact coordinate-system slider beside the label: a sliding thumb
              tracks the active segment, and switching converts whatever target
              is pinned into the new system. */}
          <div
            className="coord-system-slider"
            data-system={system}
            role="radiogroup"
            aria-label="Coordinate system"
          >
            {SYSTEM_ORDER.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={system === key}
                className={`coord-system-option${system === key ? ' is-active' : ''}`}
                onClick={() => {
                  if (key === system) return;
                  track('goto_coord_system', { system: key });
                  setSystem(key);
                }}
              >
                {COORD_SYSTEMS[key].label}
              </button>
            ))}
          </div>
        </div>
        <div className={`goto-input-row${aInvalid ? ' is-invalid' : ''}`}>
          <span className="goto-prefix">{sys.a.prefix}</span>
          <input
            type="text" inputMode="decimal"
            value={aText}
            placeholder={sys.a.placeholder}
            onChange={(e) => {
              const next = filterNumeric(e.target.value, sys.a);
              if (next !== null) setAText(next);
            }}
            onBlur={pickTarget}
            aria-label={`Target ${sys.a.prefix}`}
            aria-invalid={aInvalid}
            title={aInvalid ? `${sys.a.prefix} must be between ${sys.a.min} and ${sys.a.max}` : undefined}
          />
          <span className="goto-unit">{sys.a.unit}</span>
        </div>
        <div className={`goto-input-row${bInvalid ? ' is-invalid' : ''}`}>
          <span className="goto-prefix">{sys.b.prefix}</span>
          <input
            type="text" inputMode="decimal"
            value={bText}
            placeholder={sys.b.placeholder}
            onChange={(e) => {
              const next = filterNumeric(e.target.value, sys.b);
              if (next !== null) setBText(next);
            }}
            onBlur={pickTarget}
            aria-label={`Target ${sys.b.prefix}`}
            aria-invalid={bInvalid}
            title={bInvalid ? `${sys.b.prefix} must be between ${sys.b.min} and ${sys.b.max}` : undefined}
          />
          <span className="goto-unit">{sys.b.unit}</span>
        </div>
        {/* Submit on Enter still pins the target; the visible button is the
            shared map Slew button that appears once a target is selected. */}
        <button type="submit" className="goto-submit-hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </div>
  );
}

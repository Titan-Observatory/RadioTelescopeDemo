import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Square } from 'lucide-react';
import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { track } from '../analytics';
import type { JogDirection } from '../api';

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
        <ChevronUp size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">Up</span>
      </button>
      <button type="button" className={`pad-btn pad-west${west.active ? ' jog-active' : ''}`} {...west} aria-label="West">
        <ChevronLeft size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">West</span>
      </button>
      <button
        type="button"
        className="pad-btn pad-stop"
        onClick={() => { track('stop_pressed', { source: 'pad' }); void onStop(); }}
        aria-label="Stop all motion"
        title="Stop all motion"
      >
        <Square size={14} fill="currentColor" strokeWidth={0} />
        <span className="pad-btn-label">Stop</span>
      </button>
      <button type="button" className={`pad-btn pad-east${east.active ? ' jog-active' : ''}`} {...east} aria-label="East">
        <ChevronRight size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">East</span>
      </button>
      <button type="button" className={`pad-btn pad-down${down.active ? ' jog-active' : ''}`} {...down} aria-label="Down">
        <ChevronDown size={24} strokeWidth={2.15} />
        <span className="pad-btn-label">Down</span>
      </button>
    </div>
  );
}

// Floating control handset for the dish. Reads top to bottom the way an
// operator thinks: where the dish is pointing (live readout + motion state),
// how to nudge it (pad), and where to send it (inline go-to row).
// Both interaction modes stay visible at once — no tabs hiding the other half.
// The typed go-to speaks RA/Dec — the coordinates star charts and catalogues
// actually give you. Rather than slewing directly, entering valid coordinates
// drops the target pin on the sky map (exactly as clicking it would), so the
// shared Slew button confirms the move just like a map click.
export function MotionControls({
  jog, stopJog, onPickTarget, onStop, targetRaDeg, targetDecDeg,
}: {
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>;
  stopJog: (token: string, seq: number) => Promise<void>;
  /** Pin a target on the sky map at the given RA/Dec (degrees). */
  onPickTarget: (raDeg: number, decDeg: number) => void;
  onStop: () => Promise<void>;
  /** RA/Dec (degrees) of the latest sky-map click, to prefill the GoTo inputs. */
  targetRaDeg?: number | null;
  targetDecDeg?: number | null;
}) {
  const [raText, setRaText] = useState('');
  const [decText, setDecText] = useState('');
  const speed = Math.round(85 * 127 / 100);

  // Accept a keystroke only if the whole field stays a number with at most three
  // decimals (so letters, extra dots and 4th decimals never make it in). An
  // empty field and a lone leading "-" (Dec only) are allowed mid-typing.
  const filterNumeric = (raw: string, allowNegative: boolean): string | null => {
    const re = allowNegative ? /^-?\d{0,3}(\.\d{0,3})?$/ : /^\d{0,2}(\.\d{0,3})?$/;
    return re.test(raw) ? raw : null;
  };

  // Mirror the clicked sky position into the GoTo inputs (RA shown in hours),
  // so picking a point on the map fills in where to slew.
  useEffect(() => {
    if (targetRaDeg == null || targetDecDeg == null) return;
    setRaText((targetRaDeg / 15).toFixed(3));
    setDecText(targetDecDeg.toFixed(3));
  }, [targetRaDeg, targetDecDeg]);

  const raHoursVal = parseFloat(raText);
  const decDegVal = parseFloat(decText);
  const raValid = Number.isFinite(raHoursVal) && raHoursVal >= 0 && raHoursVal <= 24;
  const decValid = Number.isFinite(decDegVal) && decDegVal >= -90 && decDegVal <= 90;
  const targetValid = raValid && decValid;
  // Only flag a field red once it has content; an empty field is incomplete, not wrong.
  const raInvalid = raText.trim() !== '' && !raValid;
  const decInvalid = decText.trim() !== '' && !decValid;

  // Commit the typed coordinates as the map target. Fires on Enter and when a
  // field loses focus, so finishing the pair drops the pin and reveals the
  // shared Slew button — without re-pinning on every keystroke mid-number.
  const pickTarget = () => {
    if (!targetValid) return;
    onPickTarget(raHoursVal * 15, decDegVal);
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
        <span className="motion-goto-label">Go to</span>
        <div className={`goto-input-row${raInvalid ? ' is-invalid' : ''}`}>
          <span className="goto-prefix">RA</span>
          <input
            type="text" inputMode="decimal"
            value={raText}
            placeholder="20.690"
            onChange={(e) => {
              const next = filterNumeric(e.target.value, false);
              if (next !== null) setRaText(next);
            }}
            onBlur={pickTarget}
            aria-label="Target right ascension in hours"
            aria-invalid={raInvalid}
            title={raInvalid ? 'RA must be between 0 and 24 hours' : undefined}
          />
          <span className="goto-unit">h</span>
        </div>
        <div className={`goto-input-row${decInvalid ? ' is-invalid' : ''}`}>
          <span className="goto-prefix">Dec</span>
          <input
            type="text" inputMode="decimal"
            value={decText}
            placeholder="45.300"
            onChange={(e) => {
              const next = filterNumeric(e.target.value, true);
              if (next !== null) setDecText(next);
            }}
            onBlur={pickTarget}
            aria-label="Target declination in degrees"
            aria-invalid={decInvalid}
            title={decInvalid ? 'Dec must be between −90 and 90 degrees' : undefined}
          />
          <span className="goto-unit">°</span>
        </div>
        {/* Submit on Enter still pins the target; the visible button is the
            shared map Slew button that appears once a target is selected. */}
        <button type="submit" className="goto-submit-hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </div>
  );
}

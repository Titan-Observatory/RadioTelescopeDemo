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

function PointingPad({ jog, stopJog, speed }: {
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>;
  stopJog: (token: string, seq: number) => Promise<void>;
  speed: number;
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

const SPEED_PRESETS: { id: 'fine' | 'coarse' | 'slew'; label: string; value: number }[] = [
  { id: 'fine',   label: 'Fine',   value: 10 },
  { id: 'coarse', label: 'Coarse', value: 40 },
  { id: 'slew',   label: 'Slew',   value: 85 },
];

function SpeedFader({ slewSpeed, setSlewSpeed }: {
  slewSpeed: number;
  setSlewSpeed: (n: number) => void;
}) {
  const active = SPEED_PRESETS.reduce((best, p) =>
    Math.abs(p.value - slewSpeed) < Math.abs(best.value - slewSpeed) ? p : best,
  SPEED_PRESETS[0]);

  return (
    <div className="speed-toggle" role="radiogroup" aria-label="Slew speed">
      <span className="speed-toggle-heading">Speed</span>
      {SPEED_PRESETS.map((p) => {
        const selected = p.id === active.id;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`speed-toggle-btn speed-toggle-${p.id}${selected ? ' is-active' : ''}`}
            onClick={() => setSlewSpeed(p.value)}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

// Combined floating control surface. A sliding segmented toggle picks between
// the press-and-hold jog pad and the numeric GoTo form so a single overlay
// holds both interaction modes without doubling the on-screen real estate.
export function MotionControls({
  jog, stopJog, gotoAltAz, targetAz, targetAlt, setTargetAz, setTargetAlt, onStop,
}: {
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>;
  stopJog: (token: string, seq: number) => Promise<void>;
  gotoAltAz: (alt: number, az: number) => Promise<void>;
  targetAz: number;
  targetAlt: number;
  setTargetAz: (v: number) => void;
  setTargetAlt: (v: number) => void;
  onStop: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'jog' | 'goto'>('jog');
  const [slewSpeed, setSlewSpeed] = useState(40);
  const speed = Math.round(slewSpeed * 127 / 100);

  const switchMode = (next: 'jog' | 'goto') => {
    if (next === mode) return;
    track('motion_mode_switched', { from: mode, to: next });
    setMode(next);
  };

  const changeSpeed = (value: number) => {
    if (value === slewSpeed) return;
    track('motion_speed_changed', { from: slewSpeed, to: value });
    setSlewSpeed(value);
  };

  const submitTarget = async (e: FormEvent) => {
    e.preventDefault();
    await gotoAltAz(targetAlt, targetAz);
  };

  return (
    <>
      <div className="motion-controls-title">
        Motion
      </div>
      <div className="motion-mode" role="radiogroup" aria-label="Control mode">
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'jog'}
          className="motion-mode-step"
          onClick={() => switchMode('jog')}
        >
          Jog
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'goto'}
          className="motion-mode-step"
          onClick={() => switchMode('goto')}
        >
          GoTo
        </button>
      </div>
      {mode === 'jog' ? (
        <div className="motion-card">
          <PointingPad jog={jog} stopJog={stopJog} speed={speed} />
          <SpeedFader slewSpeed={slewSpeed} setSlewSpeed={changeSpeed} />
        </div>
      ) : (
        <form className="target-form-overlay" onSubmit={submitTarget}>
          <label className="goto-field">
            <span>Azimuth</span>
            <div className="goto-input-row">
              <input
                type="number" min={0} max={360} step={0.001}
                value={targetAz}
                onChange={(e) => setTargetAz(Number(e.target.value))}
              />
              <span className="goto-unit">°</span>
            </div>
          </label>
          <label className="goto-field">
            <span>Altitude</span>
            <div className="goto-input-row">
              <input
                type="number" min={0} max={90} step={0.001}
                value={targetAlt}
                onChange={(e) => setTargetAlt(Number(e.target.value))}
              />
              <span className="goto-unit">°</span>
            </div>
          </label>
          <div className="goto-actions">
            <button type="button" className="action-button goto-stop-btn" onClick={onStop} aria-label="Stop">
              <Square size={14} fill="currentColor" strokeWidth={0} />
            </button>
            <button type="submit" className="action-button goto-slew-btn">
              Slew
            </button>
          </div>
        </form>
      )}
    </>
  );
}

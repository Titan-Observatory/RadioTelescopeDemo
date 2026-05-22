import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
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

  const begin = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left-click only on mouse
    if (timerRef.current != null) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const token = makeJogToken();
    tokenRef.current = token;
    seqRef.current = 0;
    setActive(true);
    onPressRef.current?.();
    void jogRef.current(directionRef.current, speedRef.current, token, ++seqRef.current);
    timerRef.current = window.setInterval(() => {
      const currentToken = tokenRef.current;
      if (currentToken == null) return;
      void jogRef.current(directionRef.current, speedRef.current, currentToken, ++seqRef.current);
    }, JOG_REPEAT_MS);
  }, []);

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
const HOME_ELEVATION_SPEED = Math.round(85 * 127 / 100);

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
  jog, stopJog, gotoAltAz, homeElevation, targetAz, targetAlt, setTargetAz, setTargetAlt, onStop,
}: {
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>;
  stopJog: (token: string, seq: number) => Promise<void>;
  gotoAltAz: (alt: number, az: number) => Promise<void>;
  homeElevation: (speed: number) => Promise<void>;
  targetAz: number;
  targetAlt: number;
  setTargetAz: (v: number) => void;
  setTargetAlt: (v: number) => void;
  onStop: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'jog' | 'goto'>('jog');
  const [slewSpeed, setSlewSpeed] = useState(40);
  const [homingElevation, setHomingElevation] = useState(false);
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

  const zeroAltitude = async () => {
    if (homingElevation) return;
    setHomingElevation(true);
    try {
      await homeElevation(HOME_ELEVATION_SPEED);
    } finally {
      setHomingElevation(false);
    }
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
          <button
            type="button"
            className="action-button home-elevation-button"
            onClick={zeroAltitude}
            disabled={homingElevation}
          >
            {homingElevation ? 'Zeroing Alt' : 'Zero Alt'}
          </button>
        </div>
      ) : (
        <form className="target-form target-form-overlay" onSubmit={submitTarget}>
          <label>
            <span>Azimuth °</span>
            <input
              type="number" min={0} max={360} step={0.001}
              value={targetAz}
              onChange={(e) => setTargetAz(Number(e.target.value))}
            />
          </label>
          <label>
            <span>Altitude °</span>
            <input
              type="number" min={0} max={90} step={0.001}
              value={targetAlt}
              onChange={(e) => setTargetAlt(Number(e.target.value))}
            />
          </label>
          <button type="submit" className="action-button">
            Slew
          </button>
        </form>
      )}
      <div className="motion-controls-stop">
        <button type="button" className="action-button stop-button" onClick={onStop}>
          Stop
        </button>
      </div>
    </>
  );
}

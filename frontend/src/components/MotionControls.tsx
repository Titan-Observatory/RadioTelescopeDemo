import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import { track } from '../analytics';

// RoboClaw's firmware serial-timeout failsafe stops the motors if no command
// arrives within ~1 s. Re-issuing the drive command at this cadence is safely
// inside that window while still being light on the bus.
const JOG_REPEAT_MS = 200;

// Hook: turn a button into a press-and-hold jog. Reissues `start` every
// JOG_REPEAT_MS while pressed, sends `stop` on release / pointer-leave /
// cancel / unmount. We avoid setPointerCapture so dragging off the button
// is treated as a release (matches what the user sees on touch too).
function useJog(start: () => Promise<void>, stop: () => Promise<void>, onPress?: () => void) {
  const [active, setActive] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Stash the latest callbacks so the interval always fires the current one
  // even though we only set it up once per press.
  const startRef = useRef(start);
  const stopRef = useRef(stop);
  const onPressRef = useRef(onPress);
  startRef.current = start;
  stopRef.current = stop;
  onPressRef.current = onPress;

  const end = useCallback(() => {
    if (timerRef.current == null) return;
    window.clearInterval(timerRef.current);
    timerRef.current = null;
    setActive(false);
    void stopRef.current();
  }, []);

  const begin = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return; // left-click only on mouse
    if (timerRef.current != null) return;
    setActive(true);
    onPressRef.current?.();
    void startRef.current();
    timerRef.current = window.setInterval(() => { void startRef.current(); }, JOG_REPEAT_MS);
  }, []);

  // If the component unmounts mid-press (e.g. queue revokes control and the
  // page swaps to the spectator view), make sure we stop the motor.
  useEffect(() => () => { if (timerRef.current != null) { window.clearInterval(timerRef.current); void stopRef.current(); } }, []);

  return {
    active,
    onPointerDown: begin,
    onPointerUp: end,
    onPointerLeave: end,
    onPointerCancel: end,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  } as const;
}

function PointingPad({ runCommand, speed }: {
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
  speed: number;
}) {
  // Track on press only (not every repeat tick) — useJog's start fires every
  // JOG_REPEAT_MS while held, which would flood the events log otherwise.
  const onPress = (direction: 'west' | 'east' | 'up' | 'down') =>
    track('jog_pressed', { direction, speed });

  const west = useJog(() => runCommand('forward_m1',  { speed }), () => runCommand('forward_m1',  { speed: 0 }), () => onPress('west'));
  const east = useJog(() => runCommand('backward_m1', { speed }), () => runCommand('backward_m1', { speed: 0 }), () => onPress('east'));
  const down = useJog(() => runCommand('backward_m2', { speed }), () => runCommand('backward_m2', { speed: 0 }), () => onPress('down'));
  const up   = useJog(() => runCommand('forward_m2',  { speed }), () => runCommand('forward_m2',  { speed: 0 }), () => onPress('up'));

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
  runCommand, gotoAltAz, targetAz, targetAlt, setTargetAz, setTargetAlt, onStop,
}: {
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
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
          <PointingPad runCommand={runCommand} speed={speed} />
          <SpeedFader slewSpeed={slewSpeed} setSlewSpeed={changeSpeed} />
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

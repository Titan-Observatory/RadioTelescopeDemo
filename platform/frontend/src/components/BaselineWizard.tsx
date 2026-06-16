import * as Dialog from '@radix-ui/react-dialog';
import { Camera, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { track } from '../analytics';
import tourCopy from '../data/tourCopy.json';
import { HYDROGEN_LINE_MHZ } from '../lib/astro';
import {
  TRACE_BOXCAR_BINS,
  bottomHalfYRange,
  boxcarSmooth,
  displayWindow,
  zeroBaselineSpectrum,
  zeroBaselineYRange,
} from '../lib/spectrum';

const FORCE_HYDROGEN_SURVEY_EVENT = 'rt-force-hydrogen-survey';
// The "pick a spot" Cancel / confirm buttons live on the sky map's in-map hint
// banner now (see SkyMap/index.tsx). They reach this component via these window
// events rather than a shared callback.
const BASELINE_PICK_CONFIRM_EVENT = 'rt-baseline-pick-confirm';
const BASELINE_PICK_CANCEL_EVENT = 'rt-baseline-pick-cancel';

// Pull a human-readable reason out of a failed response. The platform proxies
// the hardware service's `{detail: ...}` body through verbatim, so a read-only
// state dir, a missing dongle, or a 403 (no queue control) all arrive here with
// an actionable message. Fall back to the status code when there's no body.
async function errorDetail(r: Response): Promise<string> {
  try {
    const body = await r.json() as { detail?: unknown };
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
  } catch {
    // non-JSON body — fall through to the generic message
  }
  if (r.status === 403) return 'You need telescope control to capture a baseline. Join the queue first.';
  return `Baseline capture failed (HTTP ${r.status}).`;
}

interface SpectrumFrame {
  timestamp: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  frames_seen: number;
  frame_duration_s: number;
  integration_seconds: number;
  mode: string;
  freqs_mhz: number[];
  power_db: number[];
  baseline_corrected?: boolean;
}

export interface Baseline {
  captured_at: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  freqs_mhz: number[];
  power_linear?: number[];
  power_db: number[];
  capture_samples?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frame: SpectrumFrame | null;
  // Optional success hook. The live stream's `baseline_corrected` flag already
  // drives the UI, so callers that just rely on that don't need this.
  onBaselineReady?: (baseline: Baseline) => void;
}

type Step = 'intro' | 'pick' | 'capture' | 'done';

// A compact live trace of the spectrum being integrated into the baseline,
// shown on the capture step. The trace only appears once capture is `active`
// (the user has triggered it) — before that the box stays empty so they watch
// the integration build from scratch rather than seeing the pre-capture live
// stream. The x-window and y-fit reuse the main SpectrumPanel helpers so the
// shape matches the chart the baseline will be applied to. Self-contained SVG —
// no axes or interaction, just the shape, with a dashed 21 cm reference line.
const SPARK_W = 320;
const SPARK_H = 104;
const SPARK_PAD = 6;

function LiveSpectrum({ frame, active }: { frame: SpectrumFrame | null; active: boolean }) {
  const geom = useMemo(() => {
    const freqs = frame?.freqs_mhz;
    const raw = frame?.power_db;
    if (!frame || !freqs || !raw || raw.length < 2 || freqs.length !== raw.length) return null;

    const win = displayWindow(frame);
    if (!win) return null;
    const { xMin, xMax } = win;
    const xSpan = xMax - xMin;
    if (xSpan <= 0) return null;

    // Match the main chart: zero against the robust median when baseline-
    // corrected, boxcar-smooth, then fit the y-axis the same way.
    const corrected = frame.baseline_corrected === true;
    const values = corrected ? zeroBaselineSpectrum(raw) : raw;
    const smoothed = boxcarSmooth(values, TRACE_BOXCAR_BINS);
    const [yMin, yMax] = corrected ? zeroBaselineYRange(smoothed) : bottomHalfYRange(smoothed);
    const ySpan = yMax - yMin || 1;

    const innerW = SPARK_W - 2 * SPARK_PAD;
    const innerH = SPARK_H - 2 * SPARK_PAD;
    const px = (mhz: number) => SPARK_PAD + ((mhz - xMin) / xSpan) * innerW;
    const py = (v: number) => {
      const t = Math.max(0, Math.min(1, (v - yMin) / ySpan));
      return SPARK_PAD + (1 - t) * innerH;
    };

    // Only the bins inside the displayed window, so the trace fills the box the
    // same way the main chart's x-crop does.
    let points = '';
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] < xMin || freqs[i] > xMax) continue;
      points += (points ? ' ' : '') + `${px(freqs[i]).toFixed(1)},${py(smoothed[i]).toFixed(1)}`;
    }

    const hLineX = HYDROGEN_LINE_MHZ >= xMin && HYDROGEN_LINE_MHZ <= xMax ? px(HYDROGEN_LINE_MHZ) : null;
    return { points, hLineX };
  }, [frame]);

  return (
    <svg
      className="baseline-live-spectrum"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={active ? 'Baseline integration building' : 'Spectrum preview (empty until capture starts)'}
    >
      {geom?.hLineX != null && (
        <line
          className="baseline-live-hline"
          x1={geom.hLineX} y1={SPARK_PAD} x2={geom.hLineX} y2={SPARK_H - SPARK_PAD}
        />
      )}
      {active && geom?.points && (
        <polyline
          className="baseline-live-trace"
          points={geom.points}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}

// ─── Baseline explainer animation ──────────────────────────────────────────
// A looping, self-contained schematic shown on the intro step so the user sees
// WHY baseline correction matters before committing to capturing one. Three
// beats, narrated by the caption underneath:
//   1. BASELINE  — the receiver's bandpass dome + local RFI spikes (what you
//      get pointed at empty sky), breathing with live receiver noise.
//   2. SIGNAL    — the same shape with a faint hydrogen bump riding on top,
//      almost lost in the curve.
//   3. subtract  — the stored baseline slides across onto the signal, the
//      shared bandpass + RFI cancel, and the hydrogen line is left standing.
// The breathing-trace technique (per-frame noise low-passed across frames) is
// borrowed from the queue page's HeroSpectrum so the two animations feel of a
// piece.
const EXP_N = 140;
const EXP_PANEL_W = 196;
const EXP_PANEL_H = 104;
const EXP_PEAK_PX = 92; // power 1.0 → this many px above the panel baseline
const EXP_HYD_C = 0.54; // hydrogen-bump centre (normalised x)

function expSmoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function expGauss(u: number, c: number, w: number): number {
  const z = (u - c) / w;
  return Math.exp(-z * z);
}
// Receiver bandpass: a flat-topped dome on a pedestal, rolling off at the band
// edges — the "shape" baseline correction is all about.
function expBandpass(u: number): number {
  const plateau = 0.5 * expSmoothstep(0.04, 0.22, u) * expSmoothstep(0.04, 0.22, 1 - u);
  const ripple = 0.045 * Math.sin(u * Math.PI * 2.6);
  return 0.2 + plateau + ripple;
}
// Narrow RFI spikes — present in BOTH the baseline and the live signal, which
// is exactly why subtracting the baseline removes them.
const EXP_RFI = [
  { c: 0.3, a: 0.3 },
  { c: 0.45, a: 0.34 },
  { c: 0.68, a: 0.26 },
];
function expRfi(u: number): number {
  let s = 0;
  for (const r of EXP_RFI) s += r.a * expGauss(u, r.c, 0.007);
  return s;
}

const EXP_BASELINE = new Float32Array(EXP_N);
const EXP_SIGNAL = new Float32Array(EXP_N);
const EXP_RESULT = new Float32Array(EXP_N);
for (let i = 0; i < EXP_N; i++) {
  const u = i / (EXP_N - 1);
  const base = Math.min(1, expBandpass(u) + expRfi(u));
  EXP_BASELINE[i] = base;
  // Faint hydrogen bump on top of the same receiver shape — nearly lost in it.
  EXP_SIGNAL[i] = Math.min(1.02, base + 0.11 * expGauss(u, EXP_HYD_C, 0.04));
  // After subtraction: flat near zero, hydrogen now clearly standing alone.
  EXP_RESULT[i] = 0.1 + 0.46 * expGauss(u, EXP_HYD_C, 0.045);
}
const EXP_HYD_X = EXP_HYD_C * EXP_PANEL_W;

function expPath(buf: Float32Array): { line: string; fill: string } {
  let pts = '';
  for (let i = 0; i < EXP_N; i++) {
    const x = (i / (EXP_N - 1)) * EXP_PANEL_W;
    const y = EXP_PANEL_H - Math.max(0, Math.min(1.02, buf[i])) * EXP_PEAK_PX;
    pts += (i === 0 ? '' : ' L ') + x.toFixed(1) + ',' + y.toFixed(1);
  }
  return {
    line: `M ${pts}`,
    fill: `M 0,${EXP_PANEL_H} L ${pts} L ${EXP_PANEL_W},${EXP_PANEL_H} Z`,
  };
}
const EXP_BASELINE_PATH = expPath(EXP_BASELINE);
const EXP_SIGNAL_PATH = expPath(EXP_SIGNAL);
const EXP_RESULT_PATH = expPath(EXP_RESULT);

// Cheap symmetric receiver-noise sample, same as the hero spectrum.
function expNoise(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * (2 / 3);
}
function expEaseInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

// Storyboard beats and their durations (seconds); the loop runs continuously
// while the intro dialog is open.
const EXP_PHASES = [
  { key: 'baseline', dur: 2.8 },
  { key: 'signal', dur: 2.8 },
  { key: 'overlay', dur: 1.8 },
  { key: 'subtract', dur: 2.0 },
  { key: 'reveal', dur: 3.0 },
] as const;
type ExpPhase = (typeof EXP_PHASES)[number]['key'];
const EXP_TOTAL = EXP_PHASES.reduce((s, p) => s + p.dur, 0);

const EXP_CAPTION: Record<ExpPhase, string> = {
  baseline:
    'Baseline — the receiver’s own bandpass shape plus local RFI spikes. Even pointed at empty sky, this is what you get.',
  signal:
    'Signal — on the real sky a faint hydrogen bump rides on top of that same shape, nearly lost in it.',
  overlay: 'Line the stored baseline up against the live signal…',
  subtract: '…and divide it out. The bandpass and RFI cancel — they’re in both traces.',
  reveal: 'What’s left is the hydrogen line, standing on its own.',
};

const EXP_PANEL_LX = 14; // left panel x-origin in SVG coords
const EXP_PANEL_RX = 270; // right panel x-origin
const EXP_PANEL_Y = 44;

// Renders the looping schematic. All per-frame trace updates are written
// imperatively to path/group attributes via refs so React never reconciles
// during the rAF loop (mirrors HeroSpectrum on the queue page).
function BaselineExplainer() {
  const reduce = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const [phase, setPhase] = useState<ExpPhase>(reduce ? 'reveal' : 'baseline');

  const leftLineRef = useRef<SVGPathElement | null>(null);
  const leftFillRef = useRef<SVGPathElement | null>(null);
  const rightLineRef = useRef<SVGPathElement | null>(null);
  const rightFillRef = useRef<SVGPathElement | null>(null);
  const rightGroupRef = useRef<SVGGElement | null>(null);
  const flyGroupRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (reduce) return;
    const leftBuf = Float32Array.from(EXP_BASELINE);
    const rightBuf = Float32Array.from(EXP_SIGNAL);
    const rightTarget = new Float32Array(EXP_N);
    let raf = 0;
    let startTs = 0;
    let lastTs = 0;
    let prevKey: ExpPhase | null = null;
    const minIntervalMs = 1000 / 20;
    const alpha = 0.22;
    const noiseAmp = 0.05;

    const tick = (ts: number) => {
      raf = requestAnimationFrame(tick);
      if (startTs === 0) startTs = ts;
      if (ts - lastTs < minIntervalMs) return;
      lastTs = ts;

      // Locate the current beat and its local progress.
      let t = ((ts - startTs) / 1000) % EXP_TOTAL;
      let key: ExpPhase = EXP_PHASES[0].key;
      let local = 0;
      for (const ph of EXP_PHASES) {
        if (t < ph.dur) {
          key = ph.key;
          local = t / ph.dur;
          break;
        }
        t -= ph.dur;
      }
      if (key !== prevKey) {
        // Snap working buffers on beat changes so the loop restarts cleanly.
        if (key === 'baseline') {
          leftBuf.set(EXP_BASELINE);
          rightBuf.set(EXP_SIGNAL);
        } else if (key === 'signal') {
          rightBuf.set(EXP_SIGNAL);
        }
        prevKey = key;
        setPhase(key);
      }

      // Left panel: always the breathing baseline.
      for (let i = 0; i < EXP_N; i++) {
        leftBuf[i] += (EXP_BASELINE[i] + expNoise() * noiseAmp - leftBuf[i]) * alpha;
      }
      const lp = expPath(leftBuf);
      leftLineRef.current?.setAttribute('d', lp.line);
      leftFillRef.current?.setAttribute('d', lp.fill);

      // Right panel target depends on the beat: signal, morphing to the
      // corrected result during the subtract beat, then holding on the result.
      if (key === 'subtract') {
        const e = expEaseInOut(local);
        for (let i = 0; i < EXP_N; i++) {
          rightTarget[i] = EXP_SIGNAL[i] + (EXP_RESULT[i] - EXP_SIGNAL[i]) * e;
        }
      } else if (key === 'reveal') {
        rightTarget.set(EXP_RESULT);
      } else {
        rightTarget.set(EXP_SIGNAL);
      }
      const rNoise = key === 'reveal' ? noiseAmp * 0.6 : noiseAmp;
      for (let i = 0; i < EXP_N; i++) {
        rightBuf[i] += (rightTarget[i] + expNoise() * rNoise - rightBuf[i]) * alpha;
      }
      const rp = expPath(rightBuf);
      rightLineRef.current?.setAttribute('d', rp.line);
      rightFillRef.current?.setAttribute('d', rp.fill);

      // Right panel hidden during the baseline-only beat, fading in as the
      // signal arrives, solid thereafter.
      let rightOpacity = 1;
      if (key === 'baseline') rightOpacity = 0;
      else if (key === 'signal') rightOpacity = expEaseInOut(local);
      rightGroupRef.current?.setAttribute('opacity', rightOpacity.toFixed(3));

      // Flying baseline: slides from the left panel onto the right during the
      // overlay beat, then fades as it cancels through the subtract beat.
      let flyOpacity = 0;
      let flyX = EXP_PANEL_LX;
      if (key === 'overlay') {
        flyOpacity = Math.min(1, local * 2);
        flyX = EXP_PANEL_LX + (EXP_PANEL_RX - EXP_PANEL_LX) * expEaseInOut(local);
      } else if (key === 'subtract') {
        flyOpacity = Math.max(0, 1 - local * 1.4);
        flyX = EXP_PANEL_RX;
      }
      flyGroupRef.current?.setAttribute('transform', `translate(${flyX.toFixed(1)},${EXP_PANEL_Y})`);
      flyGroupRef.current?.setAttribute('opacity', flyOpacity.toFixed(3));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  const rightInit = reduce ? EXP_RESULT_PATH : EXP_SIGNAL_PATH;
  const rightLabel = phase === 'subtract' || phase === 'reveal' ? 'CORRECTED' : 'SIGNAL';
  const showHyd = reduce || phase === 'subtract' || phase === 'reveal';

  return (
    <figure className="baseline-explainer">
      <svg
        className="baseline-explainer-svg"
        viewBox="0 0 480 156"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Animation: subtracting the receiver baseline from the live signal leaves the hydrogen line standing on its own."
      >
        {/* ── Left panel: the stored baseline ─────────────────────────────── */}
        <text className="bx-panel-label" x={EXP_PANEL_LX + EXP_PANEL_W / 2} y={EXP_PANEL_Y - 12}>
          BASELINE
        </text>
        <g transform={`translate(${EXP_PANEL_LX},${EXP_PANEL_Y})`}>
          <rect className="bx-panel" x="0" y="0" width={EXP_PANEL_W} height={EXP_PANEL_H} rx="3" />
          <path ref={leftFillRef} className="bx-fill" d={EXP_BASELINE_PATH.fill} />
          <path ref={leftLineRef} className="bx-trace" d={EXP_BASELINE_PATH.line} />
          {EXP_RFI.map(r => (
            <text key={r.c} className="bx-rfi-label" x={r.c * EXP_PANEL_W} y="11">
              RFI
            </text>
          ))}
        </g>

        {/* ── Right panel: live signal → corrected result ─────────────────── */}
        <text className="bx-panel-label" x={EXP_PANEL_RX + EXP_PANEL_W / 2} y={EXP_PANEL_Y - 12}>
          {rightLabel}
        </text>
        <g ref={rightGroupRef} opacity={reduce ? 1 : 0}>
          <g transform={`translate(${EXP_PANEL_RX},${EXP_PANEL_Y})`}>
            <rect className="bx-panel" x="0" y="0" width={EXP_PANEL_W} height={EXP_PANEL_H} rx="3" />
            <path ref={rightFillRef} className="bx-fill" d={rightInit.fill} />
            <path ref={rightLineRef} className="bx-trace" d={rightInit.line} />
            {showHyd && (
              <g className="bx-hyd">
                <line className="bx-hyd-line" x1={EXP_HYD_X} y1="28" x2={EXP_HYD_X} y2={EXP_PANEL_H} />
                <text className="bx-hyd-label" x={EXP_HYD_X} y="22">
                  H I
                </text>
              </g>
            )}
          </g>
        </g>

        {/* ── Flying baseline that slides across and cancels ──────────────── */}
        <g ref={flyGroupRef} transform={`translate(${EXP_PANEL_LX},${EXP_PANEL_Y})`} opacity="0">
          <path className="bx-fly" d={EXP_BASELINE_PATH.line} />
        </g>
      </svg>
      <figcaption className="baseline-explainer-caption">{EXP_CAPTION[phase]}</figcaption>
    </figure>
  );
}

export function BaselineWizard({ open, onOpenChange, frame, onBaselineReady }: Props) {
  const [step, setStep] = useState<Step>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to intro every time the wizard re-opens so we never resume mid-flow
  // from a stale prior session.
  useEffect(() => {
    if (open) {
      setStep('intro');
      setBusy(false);
      setError(null);
      track('baseline_wizard_opened');
    }
  }, [open]);

  // During the 'pick' step we hide the Radix dialog and apply a body-level
  // class. The class triggers a CSS spotlight (box-shadow on .skymap-panel
  // darkens everything outside it) - pure visual, no DOM overlay, so Aladin
  // keeps full pointer interaction (click-to-select, click-and-drag-to-pan,
  // hover tooltips). The pick instructions and the Cancel / confirm buttons
  // live on the sky map's own in-map hint banner; it signals us back through
  // the BASELINE_PICK_* window events below.
  useEffect(() => {
    if (!open || step !== 'pick') return;
    // Scroll the sky map into view BEFORE we lock body scroll, otherwise on
    // mobile (where panels stack vertically) the map can be offscreen and the
    // user has no way to reach it.
    const target = document.querySelector('.skymap-panel');
    // Instant (not smooth) so the scroll completes before we lock body overflow.
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
    document.body.classList.add('rt-baseline-pick');

    const onConfirm = () => { track('baseline_pick_confirmed'); setStep('capture'); };
    const onCancel = () => { track('baseline_pick_cancelled'); onOpenChange(false); };
    window.addEventListener(BASELINE_PICK_CONFIRM_EVENT, onConfirm);
    window.addEventListener(BASELINE_PICK_CANCEL_EVENT, onCancel);
    return () => {
      document.body.classList.remove('rt-baseline-pick');
      window.removeEventListener(BASELINE_PICK_CONFIRM_EVENT, onConfirm);
      window.removeEventListener(BASELINE_PICK_CANCEL_EVENT, onCancel);
    };
  }, [open, step, onOpenChange]);

  function close(reason: 'cancel' | 'done') {
    track('baseline_wizard_closed', { reason, step });
    onOpenChange(false);
  }

  function chooseCapture() {
    window.dispatchEvent(new Event(FORCE_HYDROGEN_SURVEY_EVENT));
    track('baseline_path_chosen', { path: 'capture' });
    setStep('pick');
  }

  // Initial capture averages one live integration window. Re-capture first
  // drops the active baseline, lets the raw stream settle for one window, then
  // averages the next one.
  const expectedWaitSeconds = frame
    ? Math.max(2, Math.ceil((frame.baseline_corrected ? 2 : 1) * frame.integration_seconds + 1))
    : null;

  async function capture() {
    if (!frame) return;
    const startedAt = Date.now();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/spectrum/baseline', { method: 'POST' });
      if (!r.ok) {
        setError(await errorDetail(r));
        track('baseline_capture_result', { result: 'error', status: r.status });
        return;
      }
      const baseline = await r.json() as Baseline;
      onBaselineReady?.(baseline);
      track('baseline_captured', {
        capture_duration_s: Math.round((Date.now() - startedAt) / 1000),
        integration_seconds: frame.integration_seconds,
        capture_samples: baseline.capture_samples ?? null,
      });
      setStep('done');
    } catch {
      setError('Could not reach the telescope to capture a baseline. Check your connection and try again.');
      track('baseline_capture_result', { result: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // While the user is picking on the sky map, hide the Radix dialog so the
  // map is unobscured. The wizard component stays mounted so state survives
  // the round-trip; the pick prompt and its buttons live on the sky map's
  // in-map hint banner instead (see SkyMap/index.tsx).
  const dialogOpen = open && step !== 'pick';

  return (
    <>
      <Dialog.Root open={dialogOpen} onOpenChange={(o) => { if (!o) close('cancel'); else onOpenChange(o); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="baseline-overlay" />
          <Dialog.Content className="baseline-dialog" aria-describedby="baseline-desc">
            <div className="baseline-header">
              <Dialog.Title className="baseline-title">
                {step === 'done' ? tourCopy.baselineWizard.dialog.readyTitle : tourCopy.baselineWizard.dialog.setupTitle}
              </Dialog.Title>
              <Dialog.Close className="baseline-close" aria-label="Close">
                <X size={16} />
              </Dialog.Close>
            </div>

            {step === 'intro' && (
              <div id="baseline-desc" className="baseline-body">
                <p>{tourCopy.baselineWizard.intro.body}</p>
                <BaselineExplainer />
                <p className="baseline-prompt">{tourCopy.baselineWizard.intro.prompt}</p>
                <div className="baseline-actions baseline-actions-stack">
                  <button type="button" className="baseline-btn-primary" onClick={chooseCapture}>
                    <Camera size={14} /> {tourCopy.baselineWizard.intro.buttons.capture}
                  </button>
                  <button type="button" className="baseline-btn-ghost" onClick={() => close('cancel')}>
                    {tourCopy.baselineWizard.intro.buttons.cancel}
                  </button>
                </div>
              </div>
            )}

            {step === 'capture' && (
              <div id="baseline-desc" className="baseline-body">
                <p className="baseline-step-label">{tourCopy.baselineWizard.capture.stepLabel}</p>
                <p>{tourCopy.baselineWizard.capture.body}</p>
                <figure className={`baseline-live${busy ? ' baseline-live-active' : ''}`}>
                  <LiveSpectrum frame={frame} active={busy} />
                  <figcaption className="baseline-live-caption">
                    {busy
                      ? tourCopy.baselineWizard.capture.liveCaptionActive
                      : tourCopy.baselineWizard.capture.liveCaption}
                  </figcaption>
                </figure>
                {busy && expectedWaitSeconds != null && (
                  <div className="baseline-countdown" role="status" aria-live="polite">
                    {tourCopy.baselineWizard.capture.countdownPrefix}
                    {' '}<strong>~{expectedWaitSeconds}s</strong> {tourCopy.baselineWizard.capture.countdownSuffix}
                  </div>
                )}
                {error && !busy && (
                  <p className="baseline-warn" role="alert">{error}</p>
                )}
                {frame && (
                  <p className="baseline-meta">
                    Integration window: {frame.integration_seconds.toFixed(1)} s
                    {' | '}
                    Center: {frame.center_freq_mhz.toFixed(2)} MHz
                  </p>
                )}
                <div className="baseline-actions">
                  <button
                    type="button"
                    className="baseline-btn-ghost"
                    onClick={() => setStep('pick')}
                    disabled={busy}
                  >
                    {tourCopy.baselineWizard.capture.buttons.back}
                  </button>
                  <button
                    type="button"
                    className="baseline-btn-primary"
                    onClick={() => void capture()}
                    disabled={!frame || busy}
                  >
                    <Camera size={14} /> {busy ? tourCopy.baselineWizard.capture.buttons.capturing : tourCopy.baselineWizard.capture.buttons.trigger}
                  </button>
                </div>
              </div>
            )}

            {step === 'done' && (
              <div id="baseline-desc" className="baseline-body">
                <p>{tourCopy.baselineWizard.done.body}</p>
                <p className="baseline-meta">{tourCopy.baselineWizard.done.meta}</p>
                <div className="baseline-actions">
                  <button type="button" className="baseline-btn-primary" onClick={() => close('done')}>
                    {tourCopy.baselineWizard.done.buttons.close}
                  </button>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

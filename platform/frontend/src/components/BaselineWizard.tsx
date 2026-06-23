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
// Sized to match the main SpectrumPanel chart (.spectrum-chart is 215px tall):
// the preview fills the same-shaped box so the bandpass the user sees building
// here reads as the same chart the baseline will be applied to. The viewBox is
// stretched to the CSS box (preserveAspectRatio="none"), so these are just the
// internal drawing resolution and proportion.
const SPARK_W = 720;
const SPARK_H = 215;
const SPARK_PAD = 12;

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
  const leftShoulder = expSmoothstep(0.02, 0.22, u);
  const rightShoulder = expSmoothstep(0.03, 0.22, 1 - u);
  const rolloff = leftShoulder * rightShoulder;
  const crown =
    0.18 * expGauss(u, 0.16, 0.12) +
    0.12 * expGauss(u, 0.52, 0.16) +
    0.15 * expGauss(u, 0.82, 0.10);
  const saddle =
    0.08 * expGauss(u, 0.36, 0.10) +
    0.06 * expGauss(u, 0.68, 0.11);
  const ripple =
    0.022 * Math.sin(u * Math.PI * 5.2 + 0.45) +
    0.014 * Math.sin(u * Math.PI * 13.4 - 0.7);
  return 0.2 + rolloff * (0.48 + crown - saddle + ripple);
}
// Narrow RFI spikes — present in BOTH the baseline and the live signal, which
// is exactly why subtracting the baseline removes them.
const EXP_RFI = [
  { c: 0.24, a: 0.2 },
  { c: 0.48, a: 0.34 },
  { c: 0.62, a: 0.27 },
  { c: 0.80, a: 0.22 },
];
function expRfi(u: number): number {
  let s = 0;
  for (const r of EXP_RFI) s += r.a * expGauss(u, r.c, 0.0045);
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
  EXP_RESULT[i] = 0.1 + 0.28 * expGauss(u, EXP_HYD_C, 0.045);
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
// Clip region used to "delete" the trace during the subtract beat. It's the
// area of the panel ABOVE a cut contour: top edge along y=0, then back across a
// lower boundary. ``raise`` ∈ [0,1] lifts that boundary from the floor (raise=0,
// clips nothing — full trace shows) up to the baseline contour (raise=1, only
// the above-baseline sliver survives). Animating ``raise`` carves the dome away;
// reversing it re-opens the clip as the residual settles onto the axis.
function expClipPath(raise: number): string {
  let d = `M 0,0 L ${EXP_PANEL_W},0`;
  for (let i = EXP_N - 1; i >= 0; i--) {
    const x = (i / (EXP_N - 1)) * EXP_PANEL_W;
    const cutY = EXP_PANEL_H - EXP_BASELINE[i] * EXP_PEAK_PX * raise;
    d += ' L ' + x.toFixed(1) + ',' + cutY.toFixed(1);
  }
  return d + ' Z';
}
// Fully-open clip (raise=0): the whole panel, a no-op for non-subtract frames
// and the reduced-motion static render.
const EXP_CLIP_OPEN = expClipPath(0);
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
const EXP_PANEL_LX = 14; // left panel x-origin in SVG coords
const EXP_PANEL_RX = 270; // right panel x-origin
const EXP_PANEL_Y = 44;

// The lesson is a carousel of four keyframes from the baseline-subtraction
// story. Each slide pairs one schematic panel (or two, on the subtract beat)
// with an explainer; the user advances at their own pace with Continue.

// Single-panel slides reuse the same 480×156 viewBox as the two-panel subtract
// slide so the stage keeps a constant height as the user pages through — the
// lone panel is just centred. EXP_PANEL_W is 196, so x = (480-196)/2.


const EXP_PHASES = [
  { key: 'baseline', dur: 1.4 },
  { key: 'signal', dur: 1.6 },
  { key: 'overlay', dur: 0.9 },
  { key: 'overlap', dur: 1.3 },
  { key: 'subtract', dur: 1.6 },
  { key: 'reveal', dur: 2.6 },
] as const;
type ExpPhase = (typeof EXP_PHASES)[number]['key'];
const EXP_TOTAL = EXP_PHASES.reduce((s, p) => s + p.dur, 0);

// Same visual model as the original looping explainer: baseline on the left,
// live/corrected signal on the right, and a dashed baseline trace flying over
// to cancel. The lesson buttons now drive those original beats manually.
function BaselineExplainer() {
  const reduce = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const leftLineRef = useRef<SVGPathElement | null>(null);
  const leftFillRef = useRef<SVGPathElement | null>(null);
  const rightLineRef = useRef<SVGPathElement | null>(null);
  const rightFillRef = useRef<SVGPathElement | null>(null);
  const rightGroupRef = useRef<SVGGElement | null>(null);
  const flyGroupRef = useRef<SVGGElement | null>(null);
  const overlapRef = useRef<SVGPathElement | null>(null);
  const clipRef = useRef<SVGPathElement | null>(null);
  const [phase, setPhase] = useState<ExpPhase>(
    reduce ? 'reveal' : 'baseline',
  );

  useEffect(() => {
    if (reduce) return;
    const leftBuf = Float32Array.from(EXP_BASELINE);
    const rightBuf = Float32Array.from(EXP_SIGNAL);
    const rightTarget = new Float32Array(EXP_N);
    // Scratch top edge for the subtract beat's trace morph (signal → result).
    const topBuf = new Float32Array(EXP_N);
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
        if (key === 'baseline') {
          leftBuf.set(EXP_BASELINE);
          rightBuf.set(EXP_SIGNAL);
        } else if (key === 'signal') {
          rightBuf.set(EXP_SIGNAL);
        } else if (key === 'reveal') {
          // The subtract morph ends exactly on EXP_RESULT; seed the EMA buffer
          // there so reveal doesn't re-animate from the old signal shape.
          rightBuf.set(EXP_RESULT);
        }
        prevKey = key;
        setPhase(key);
      }

      for (let i = 0; i < EXP_N; i++) {
        leftBuf[i] += (EXP_BASELINE[i] + expNoise() * noiseAmp - leftBuf[i]) * alpha;
      }
      const lp = expPath(leftBuf);
      leftLineRef.current?.setAttribute('d', lp.line);
      leftFillRef.current?.setAttribute('d', lp.fill);

      if (key === 'subtract') {
        // The real trace, drawn once, with an animated clipPath that actually
        // DELETES the part at/below the baseline. Two sub-beats:
        //   cut  (local 0 → 0.5): the clip's lower edge rises from the floor up
        //     to the baseline contour, erasing the dome and RFI spikes (which sit
        //     at their own baseline) and leaving only the H I bump — the one bit
        //     above the baseline — hanging in the air where it was cut from.
        //   drop (local 0.5 → 1): the trace morphs signal→result so the bump
        //     settles onto a flat axis, while the clip re-opens (baseline→floor)
        //     so the corrected floor reforms underneath it.
        const cutProg = expEaseInOut(expSmoothstep(0, 0.5, local));
        const dropProg = expEaseInOut(expSmoothstep(0.5, 1, local));
        for (let i = 0; i < EXP_N; i++) {
          topBuf[i] = EXP_SIGNAL[i] + (EXP_RESULT[i] - EXP_SIGNAL[i]) * dropProg;
        }
        const rp = expPath(topBuf);
        rightLineRef.current?.setAttribute('d', rp.line);
        rightFillRef.current?.setAttribute('d', rp.fill);
        // raise: floor → baseline (cut), then held at baseline and re-opened to
        // floor as the residual lands.
        const raise = cutProg * (1 - dropProg);
        clipRef.current?.setAttribute('d', expClipPath(raise));
      } else {
        rightTarget.set(key === 'reveal' ? EXP_RESULT : EXP_SIGNAL);
        const rNoise = key === 'reveal' ? noiseAmp * 0.6 : noiseAmp;
        for (let i = 0; i < EXP_N; i++) {
          rightBuf[i] += (rightTarget[i] + expNoise() * rNoise - rightBuf[i]) * alpha;
        }
        const rp = expPath(rightBuf);
        rightLineRef.current?.setAttribute('d', rp.line);
        rightFillRef.current?.setAttribute('d', rp.fill);
        // Clip fully open everywhere except the subtract beat.
        clipRef.current?.setAttribute('d', EXP_CLIP_OPEN);
      }

      let rightOpacity = 1;
      if (key === 'baseline') rightOpacity = 0;
      else if (key === 'signal') rightOpacity = expEaseInOut(Math.min(1, local * 1.6));
      rightGroupRef.current?.setAttribute('opacity', rightOpacity.toFixed(3));

      let flyOpacity = 0;
      let overlapOpacity = 0;
      let flyX = EXP_PANEL_LX;
      if (key === 'overlay') {
        flyOpacity = Math.min(1, local * 3);
        flyX = EXP_PANEL_LX + (EXP_PANEL_RX - EXP_PANEL_LX) * expEaseInOut(local);
      } else if (key === 'overlap') {
        flyOpacity = 1;
        overlapOpacity = expSmoothstep(0.1, 0.42, local);
        flyX = EXP_PANEL_RX;
      } else if (key === 'subtract') {
        // Snap-erase: overlap and fly vanish quickly so the "cut" reads as instant deletion.
        flyOpacity = 1 - expSmoothstep(0, 0.32, local);
        overlapOpacity = flyOpacity;
        flyX = EXP_PANEL_RX;
      }
      flyGroupRef.current?.setAttribute('transform', `translate(${flyX.toFixed(1)},${EXP_PANEL_Y})`);
      flyGroupRef.current?.setAttribute('opacity', flyOpacity.toFixed(3));
      overlapRef.current?.setAttribute('opacity', overlapOpacity.toFixed(3));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  const rightLabel = phase === 'subtract' || phase === 'reveal' ? 'CORRECTED' : 'SIGNAL';
  const showHyd = reduce || phase === 'subtract' || phase === 'reveal';

  return (
    <svg
      className="baseline-explainer-svg"
      viewBox="0 0 480 156"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Animation: subtracting the receiver baseline from the live signal leaves the hydrogen line standing on its own."
    >
      <text className="bx-panel-label" x={EXP_PANEL_LX + EXP_PANEL_W / 2} y={EXP_PANEL_Y - 12}>
        BASELINE
      </text>
      <g transform={`translate(${EXP_PANEL_LX},${EXP_PANEL_Y})`}>
        <rect className="bx-panel" x="0" y="0" width={EXP_PANEL_W} height={EXP_PANEL_H} rx="3" />
        <path ref={leftFillRef} className="bx-fill" d={EXP_BASELINE_PATH.fill} />
        <path ref={leftLineRef} className="bx-trace" d={EXP_BASELINE_PATH.line} />
        {EXP_RFI.map(r => (
          <text key={r.c} className="bx-rfi-label" x={r.c * EXP_PANEL_W} y="7">
            RFI
          </text>
        ))}
      </g>

      <text className="bx-panel-label" x={EXP_PANEL_RX + EXP_PANEL_W / 2} y={EXP_PANEL_Y - 12}>
        {rightLabel}
      </text>
      <g ref={rightGroupRef} opacity={reduce ? 1 : 0}>
        <g transform={`translate(${EXP_PANEL_RX},${EXP_PANEL_Y})`}>
          <clipPath id="bx-cut-clip">
            <path ref={clipRef} d={EXP_CLIP_OPEN} />
          </clipPath>
          <rect className="bx-panel" x="0" y="0" width={EXP_PANEL_W} height={EXP_PANEL_H} rx="3" />
          <path ref={rightFillRef} className="bx-fill" d={(reduce ? EXP_RESULT_PATH : EXP_SIGNAL_PATH).fill} clipPath="url(#bx-cut-clip)" />
          <path ref={overlapRef} className="bx-overlap" d={EXP_BASELINE_PATH.fill} opacity="0" />
          <path ref={rightLineRef} className="bx-trace" d={(reduce ? EXP_RESULT_PATH : EXP_SIGNAL_PATH).line} clipPath="url(#bx-cut-clip)" />
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

      <g ref={flyGroupRef} transform={`translate(${EXP_PANEL_LX},${EXP_PANEL_Y})`} opacity="0">
        <path className="bx-fly" d={EXP_BASELINE_PATH.line} />
      </g>
    </svg>
  );
}

// The intro mini-lesson: a paged carousel of keyframes with explainers. The
// final Continue hands off to the capture flow via onContinue; Cancel closes.
function BaselineLesson({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  const btn = tourCopy.baselineWizard.intro.buttons;

  return (
    <div id="baseline-desc" className="baseline-body">
      <figure className="baseline-explainer baseline-lesson">
        <BaselineExplainer />
        <figcaption className="baseline-lesson-text">
          <span className="baseline-lesson-step-title">Baseline correction</span>
          <span className="baseline-explainer-caption">
            A cold-sky baseline records the receiver's bandpass shape and local RFI, then divides that shape out of the live spectrum so real sky features like the hydrogen line stand out.
          </span>
        </figcaption>
      </figure>

      <div className="baseline-actions baseline-lesson-actions">
        <button type="button" className="baseline-btn-ghost" onClick={onCancel}>
          {btn.cancel}
        </button>
        <div className="baseline-lesson-actions-right">
          <button type="button" className="baseline-btn-primary" onClick={onContinue}>
            <Camera size={14} /> {btn.capture}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BaselineWizard({ open, onOpenChange, frame, onBaselineReady }: Props) {
  const [step, setStep] = useState<Step>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `building` gates the live trace on the capture step. We only draw it once a
  // *fresh* (post-reset) frame has arrived, so the preview shows the integration
  // rebuilding from scratch instead of flashing the already-settled spectrum
  // that was on screen when the user hit Trigger. See `capture()` and the
  // freshness effect below.
  const [building, setBuilding] = useState(false);
  // `frames_seen` of the last frame observed when capture started. After the
  // reset flushes the rolling average, `frames_seen` restarts near zero; the
  // first frame below this marker is our cue that the rebuild has begun.
  const captureFramesMarkerRef = useRef<number | null>(null);

  // Reset to intro every time the wizard re-opens so we never resume mid-flow
  // from a stale prior session.
  useEffect(() => {
    if (open) {
      setStep('intro');
      setBusy(false);
      setError(null);
      setBuilding(false);
      track('baseline_wizard_opened');
    }
  }, [open]);

  // Detect the first post-reset frame so the preview starts drawing the rebuild.
  // `capture()` flushes the live integration, after which `frames_seen` drops
  // back near zero; once we see that (or there was no prior frame to wait on),
  // flip `building` on and leave it on for the rest of the capture.
  useEffect(() => {
    if (!busy || building || !frame) return;
    const marker = captureFramesMarkerRef.current;
    if (marker == null || frame.frames_seen < marker) setBuilding(true);
  }, [busy, building, frame]);

  // During the 'pick' step we hide the Radix dialog and take the sky map
  // fullscreen via the Fullscreen API, so the user picks their quiet patch on
  // an unobstructed, full-viewport map (no header, no surrounding panels). We
  // also keep the body-level `rt-baseline-pick` class: SkyMap reads it to show
  // its in-map hint banner and gate the Continue button, and its CSS spotlight
  // is a graceful fallback if the browser rejects the fullscreen request.
  // The pick instructions and the Cancel / confirm buttons live on the sky
  // map's own in-map hint banner (visible inside the fullscreen panel); it
  // signals us back through the BASELINE_PICK_* window events below.
  useEffect(() => {
    if (!open || step !== 'pick') return;
    document.body.classList.add('rt-baseline-pick');
    // The sky map is always the first thing on the page; take its panel
    // fullscreen. Best-effort: a rejected request (no user activation, or
    // unsupported) just falls back to the CSS spotlight above.
    const panel = document.querySelector('.skymap-panel');
    void (panel as HTMLElement | null)?.requestFullscreen?.().catch(() => {});

    const onConfirm = () => { track('baseline_pick_confirmed'); setStep('capture'); };
    const onCancel = () => { track('baseline_pick_cancelled'); onOpenChange(false); };
    window.addEventListener(BASELINE_PICK_CONFIRM_EVENT, onConfirm);
    window.addEventListener(BASELINE_PICK_CANCEL_EVENT, onCancel);
    return () => {
      document.body.classList.remove('rt-baseline-pick');
      // Exit fullscreen when the step ends (confirm/cancel/unmount). Guard on
      // fullscreenElement so we don't reject when the user already pressed Esc.
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
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

  // Every capture restarts the raw flowgraph, lets it settle for one
  // integration window, then averages the next one — so budget two windows
  // regardless of whether a baseline was already applied.
  const expectedWaitSeconds = frame
    ? Math.max(2, Math.ceil(2 * frame.integration_seconds + 1))
    : null;

  async function capture() {
    const startedAt = Date.now();
    setBusy(true);
    setBuilding(false);
    captureFramesMarkerRef.current = frame?.frames_seen ?? null;
    setError(null);
    try {
      // The capture itself flushes the live integration server-side (it always
      // respawns the raw flowgraph), so `frames_seen` drops back to zero and the
      // preview rebuilds from scratch. The freshness effect above watches for
      // that drop to switch `building` on — no separate reset call needed.
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
        integration_seconds: frame?.integration_seconds ?? null,
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
              <BaselineLesson onContinue={chooseCapture} onCancel={() => close('cancel')} />
            )}

            {step === 'capture' && (
              <div id="baseline-desc" className="baseline-body">
                <p className="baseline-step-label">{tourCopy.baselineWizard.capture.stepLabel}</p>
                <p>{tourCopy.baselineWizard.capture.body}</p>
                <figure className={`baseline-live${busy ? ' baseline-live-active' : ''}`}>
                  <LiveSpectrum frame={frame} active={building} />
                  <figcaption className="baseline-live-caption">
                    {busy
                      ? (building
                        ? tourCopy.baselineWizard.capture.liveCaptionActive
                        : 'Restarting the integration…')
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
                    disabled={busy}
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

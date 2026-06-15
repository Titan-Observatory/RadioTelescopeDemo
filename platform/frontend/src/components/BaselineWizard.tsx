import * as Dialog from '@radix-ui/react-dialog';
import { Camera, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { track } from '../analytics';
import tourCopy from '../data/tourCopy.json';

// 21 cm neutral-hydrogen rest frequency (MHz). Mirrors HYDROGEN_LINE_MHZ in
// lib/astro.ts / the hardware service — used only to mark the line position on
// the capture-step preview, so a hand-synced copy is fine.
const HYDROGEN_LINE_MHZ = 1420.4058;

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

// A compact live trace of the spectrum currently streaming, shown on the
// capture step. Because capture now integrates the live stream (the SDR is
// never paused), this keeps updating frame-by-frame while the baseline is
// measured, so the user watches the bandpass settle. Self-contained SVG — no
// axes or interaction, just the shape.
const SPARK_W = 320;
const SPARK_H = 104;
const SPARK_PAD = 6;

function LiveSpectrum({ frame }: { frame: SpectrumFrame | null }) {
  const geom = useMemo(() => {
    const ys = frame?.power_db;
    if (!ys || ys.length < 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of ys) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    const span = hi - lo || 1;
    const n = ys.length;
    const innerW = SPARK_W - 2 * SPARK_PAD;
    const innerH = SPARK_H - 2 * SPARK_PAD;
    const x = (i: number) => SPARK_PAD + (i / (n - 1)) * innerW;
    const y = (v: number) => SPARK_PAD + (1 - (v - lo) / span) * innerH;
    const points = ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

    // Mark the 21 cm line if it falls inside the displayed (cropped) window.
    const freqs = frame.freqs_mhz;
    let hLineX: number | null = null;
    if (freqs && freqs.length === n
        && HYDROGEN_LINE_MHZ >= freqs[0] && HYDROGEN_LINE_MHZ <= freqs[n - 1]) {
      let nearest = 0;
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(freqs[i] - HYDROGEN_LINE_MHZ);
        if (d < best) { best = d; nearest = i; }
      }
      hLineX = x(nearest);
    }
    return { points, hLineX };
  }, [frame]);

  if (!geom) {
    return (
      <div className="baseline-live-spectrum baseline-live-spectrum-empty" role="status">
        {tourCopy.baselineWizard.capture.liveWaiting}
      </div>
    );
  }
  return (
    <svg
      className="baseline-live-spectrum"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Live spectrum being integrated"
    >
      {geom.hLineX != null && (
        <line
          className="baseline-live-hline"
          x1={geom.hLineX} y1={SPARK_PAD} x2={geom.hLineX} y2={SPARK_H - SPARK_PAD}
        />
      )}
      <polyline
        className="baseline-live-trace"
        points={geom.points}
        fill="none"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
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

  // Server-side capture collects one full integration window of fresh samples
  // before responding. Show a generous wait estimate so the user knows the
  // request hasn't hung - round up and add a small buffer for round-tripping.
  const expectedWaitSeconds = frame
    ? Math.max(2, Math.ceil(frame.integration_seconds + 1))
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
                {frame && (
                  <figure className={`baseline-live${busy ? ' baseline-live-active' : ''}`}>
                    <LiveSpectrum frame={frame} />
                    <figcaption className="baseline-live-caption">
                      {busy
                        ? tourCopy.baselineWizard.capture.liveCaptionActive
                        : tourCopy.baselineWizard.capture.liveCaption}
                    </figcaption>
                  </figure>
                )}
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
                {!frame && (
                  <p className="baseline-warn">
                    {tourCopy.baselineWizard.capture.noFrame}
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

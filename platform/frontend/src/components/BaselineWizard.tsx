import * as Dialog from '@radix-ui/react-dialog';
import { Camera, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { track } from '../analytics';
import tourCopy from '../data/tourCopy.json';

const FORCE_HYDROGEN_SURVEY_EVENT = 'rt-force-hydrogen-survey';

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
  onBaselineReady: (baseline: Baseline) => void;
}

type Step = 'intro' | 'pick' | 'capture' | 'done';

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
  // hover tooltips). The popover next to the map is rendered by React
  // (BaselinePickPopover) and positioned from .skymap-panel's bounding box.
  useEffect(() => {
    if (!open || step !== 'pick') return;
    // Scroll the sky map into view BEFORE we lock body scroll, otherwise on
    // mobile (where panels stack vertically) the map can be offscreen and the
    // user has no way to reach it.
    const target = document.querySelector('.skymap-panel');
    // Instant (not smooth) so the scroll completes before we lock body overflow.
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
    document.body.classList.add('rt-baseline-pick');
    return () => document.body.classList.remove('rt-baseline-pick');
  }, [open, step]);

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
      onBaselineReady(baseline);
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
  // the round-trip, and a custom popover (rendered below) takes the dialog's
  // place - positioned next to the sky map without blocking it.
  const dialogOpen = open && step !== 'pick';

  return (
    <>
      {open && step === 'pick' && (
        <BaselinePickPopover
          onCancel={() => { track('baseline_pick_cancelled'); onOpenChange(false); }}
          onConfirm={() => { track('baseline_pick_confirmed'); setStep('capture'); }}
        />
      )}
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

// Replacement for driver.js's popover in the pick step. Renders a fixed-
// position card on the right edge of .skymap-panel, kept in sync with that
// element's bounding box on resize. Uses no SVG overlay so it doesn't
// interfere with Aladin's pointer-event handling.
function BaselinePickPopover({ onCancel, onConfirm }: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const target = document.querySelector('.skymap-panel');
    if (!target) return;
    const update = () => setRect(target.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const ro = new ResizeObserver(update);
    ro.observe(target);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      ro.disconnect();
    };
  }, []);

  if (!rect) return null;

  // Prefer the right side of the map. If there isn't room beside it (narrow
  // viewport / mobile stack), drop the popover BELOW the map so it doesn't
  // cover the very thing the user is trying to click.
  const POPOVER_WIDTH = 340;
  const MARGIN = 16;
  const fitsRight = rect.right + MARGIN + POPOVER_WIDTH + MARGIN <= window.innerWidth;
  const style: React.CSSProperties = fitsRight
    ? { left: rect.right + MARGIN, top: rect.top + 12, width: POPOVER_WIDTH }
    : {
        // Bottom-sheet style: the map fills most of a phone viewport, so
        // pinning the popover to the bottom edge keeps the map clickable
        // above it regardless of where the panel sits in the page.
        left: MARGIN,
        right: MARGIN,
        bottom: MARGIN,
        width: 'auto',
        maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
      };

  return createPortal(
    <div className="baseline-pick-popover" style={style} role="dialog" aria-modal="false">
      <strong className="baseline-pick-popover-title">{tourCopy.baselineWizard.pick.title}</strong>
      <p className="baseline-pick-popover-desc">
        {tourCopy.baselineWizard.pick.description}
      </p>
      <div className="baseline-pick-popover-actions">
        <button type="button" className="rt-tour-btn rt-tour-btn-ghost" onClick={onCancel}>
          {tourCopy.baselineWizard.pick.buttons.cancel}
        </button>
        <button type="button" className="rt-tour-btn rt-tour-btn-primary" onClick={onConfirm}>
          {tourCopy.baselineWizard.pick.buttons.confirm}
        </button>
      </div>
    </div>,
    document.body,
  );
}

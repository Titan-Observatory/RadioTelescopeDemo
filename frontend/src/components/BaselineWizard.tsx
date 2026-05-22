import * as Dialog from '@radix-ui/react-dialog';
import { Camera, FolderOpen, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { track } from '../analytics';

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
}

export interface Baseline {
  captured_at: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  freqs_mhz: number[];
  power_db: number[];
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frame: SpectrumFrame | null;
  onBaselineReady: (baseline: Baseline) => void;
}

type Step = 'intro' | 'pick' | 'settle' | 'done' | 'load_failed';
type Path = 'capture' | 'load';

// Seconds the wizard suggests waiting once the user is back from picking.
// The FFT integration needs a moment to settle on the empty-sky shape;
// capture is always enabled, this is just guidance.
const SETTLE_SECONDS = 15;

export function BaselineWizard({ open, onOpenChange, frame, onBaselineReady }: Props) {
  const [step, setStep] = useState<Step>('intro');
  const [path, setPath] = useState<Path | null>(null);
  const [busy, setBusy] = useState(false);
  const [settleRemaining, setSettleRemaining] = useState(SETTLE_SECONDS);
  const settleStartedAtRef = useRef<number | null>(null);

  // Reset to intro every time the wizard re-opens so we never resume mid-flow
  // from a stale prior session.
  useEffect(() => {
    if (open) {
      setStep('intro');
      setPath(null);
      setBusy(false);
      setSettleRemaining(SETTLE_SECONDS);
      settleStartedAtRef.current = null;
      track('baseline_wizard_opened');
    }
  }, [open]);

  // During the 'pick' step we hide the Radix dialog and apply a body-level
  // class. The class triggers a CSS spotlight (box-shadow on .skymap-panel
  // darkens everything outside it) — pure visual, no DOM overlay, so Aladin
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

  // Drive the settle countdown. Doesn't block capture — just an on-screen hint.
  useEffect(() => {
    if (step !== 'settle') return;
    if (settleStartedAtRef.current == null) settleStartedAtRef.current = Date.now();
    const tick = () => {
      const elapsed = Math.floor((Date.now() - (settleStartedAtRef.current ?? Date.now())) / 1000);
      setSettleRemaining(Math.max(0, SETTLE_SECONDS - elapsed));
    };
    tick();
    const handle = window.setInterval(tick, 250);
    return () => window.clearInterval(handle);
  }, [step]);

  function close(reason: 'cancel' | 'done') {
    track('baseline_wizard_closed', { reason, step, path });
    onOpenChange(false);
  }

  function chooseCapture() {
    track('baseline_path_chosen', { path: 'capture' });
    setPath('capture');
    setStep('pick');
  }

  async function chooseLoad() {
    track('baseline_path_chosen', { path: 'load' });
    setPath('load');
    setBusy(true);
    try {
      const r = await fetch('/api/spectrum/baseline');
      if (r.status === 404) {
        track('baseline_load_result', { result: 'not_found' });
        setStep('load_failed');
        return;
      }
      if (!r.ok) {
        track('baseline_load_result', { result: 'error', status: r.status });
        setStep('load_failed');
        return;
      }
      const baseline = await r.json() as Baseline;
      onBaselineReady(baseline);
      track('baseline_load_result', { result: 'success' });
      setStep('done');
    } catch {
      track('baseline_load_result', { result: 'error' });
      setStep('load_failed');
    } finally {
      setBusy(false);
    }
  }

  function capture() {
    if (!frame) return;
    const baseline: Baseline = {
      captured_at: Date.now() / 1000,
      center_freq_mhz: frame.center_freq_mhz,
      sample_rate_mhz: frame.sample_rate_mhz,
      integration_frames: frame.integration_frames,
      freqs_mhz: frame.freqs_mhz,
      power_db: frame.power_db,
    };
    onBaselineReady(baseline);
    track('baseline_captured', {
      seconds_waited: settleStartedAtRef.current
        ? Math.floor((Date.now() - settleStartedAtRef.current) / 1000)
        : 0,
      integration_seconds: frame.integration_seconds,
    });
    setStep('done');
  }

  // While the user is picking on the sky map, hide the Radix dialog so the
  // map is unobscured. The wizard component stays mounted so state survives
  // the round-trip, and a custom popover (rendered below) takes the dialog's
  // place — positioned next to the sky map without blocking it.
  const dialogOpen = open && step !== 'pick';

  return (
    <>
    {open && step === 'pick' && (
      <BaselinePickPopover
        onCancel={() => { track('baseline_pick_cancelled'); onOpenChange(false); }}
        onConfirm={() => { track('baseline_pick_confirmed'); setStep('settle'); }}
      />
    )}
    <Dialog.Root open={dialogOpen} onOpenChange={(o) => { if (!o) close('cancel'); else onOpenChange(o); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="baseline-overlay" />
        <Dialog.Content className="baseline-dialog" aria-describedby="baseline-desc">
          <div className="baseline-header">
            <Dialog.Title className="baseline-title">
              {step === 'done' ? 'Baseline ready' : 'Set up baseline'}
            </Dialog.Title>
            <Dialog.Close className="baseline-close" aria-label="Close">
              <X size={16} />
            </Dialog.Close>
          </div>

          {step === 'intro' && (
            <div id="baseline-desc" className="baseline-body">
              <p>
                Radio receivers have their own "shape" — even with no signal at all, the spectrum
                from a real antenna isn't flat. <strong>Baseline subtraction</strong> stores a
                reference trace of that shape and subtracts it from live data, so real features
                like the hydrogen line stand out instead of getting lost in the bandpass curve.
              </p>
              <p className="baseline-prompt">
                We'll capture one by pointing somewhere quiet and freezing the trace. If you just
                want to see the effect, you can load a saved baseline instead.
              </p>
              <div className="baseline-actions baseline-actions-stack">
                <button type="button" className="baseline-btn-primary" onClick={chooseCapture}>
                  <Camera size={14} /> Walk me through capturing one
                </button>
                <button
                  type="button"
                  className="baseline-btn-secondary"
                  onClick={() => void chooseLoad()}
                  disabled={busy}
                >
                  <FolderOpen size={14} /> {busy ? 'Loading…' : 'Load a saved baseline'}
                </button>
                <button type="button" className="baseline-btn-ghost" onClick={() => close('cancel')}>
                  Not right now
                </button>
              </div>
            </div>
          )}

          {step === 'settle' && (
            <div id="baseline-desc" className="baseline-body">
              <p className="baseline-step-label">Step 2 of 2 — Wait, then capture</p>
              <p>
                Once the dish has finished slewing, give the rolling spectrum integration a few
                seconds to settle on the empty-sky shape. Then freeze the current trace.
              </p>
              <div className="baseline-countdown" role="status">
                {settleRemaining > 0
                  ? <>Settling… <strong>{settleRemaining}s</strong> recommended wait</>
                  : <>Ready to capture.</>}
              </div>
              {frame && (
                <p className="baseline-meta">
                  Current integration: {frame.integration_seconds.toFixed(1)} s
                  {' · '}
                  Center: {frame.center_freq_mhz.toFixed(2)} MHz
                </p>
              )}
              {!frame && (
                <p className="baseline-warn">
                  No spectrum frame received yet — wait a moment for the first one to arrive.
                </p>
              )}
              <div className="baseline-actions">
                <button type="button" className="baseline-btn-ghost" onClick={() => setStep('pick')}>
                  Back to map
                </button>
                <button
                  type="button"
                  className="baseline-btn-primary"
                  onClick={capture}
                  disabled={!frame}
                >
                  <Camera size={14} /> Capture now
                </button>
              </div>
            </div>
          )}

          {step === 'done' && (
            <div id="baseline-desc" className="baseline-body">
              <p>
                Done — the live spectrum is now drawn with this baseline subtracted. The bandpass
                curve should flatten out, so anything left poking up is a real feature in the sky
                rather than the receiver's shape.
              </p>
              <p className="baseline-meta">
                Look around 1420.4 MHz: a narrow bump that <em>persists</em> as a vertical streak
                in the waterfall is the hydrogen line.
              </p>
              <div className="baseline-actions">
                <button type="button" className="baseline-btn-primary" onClick={() => close('done')}>
                  Close
                </button>
              </div>
            </div>
          )}

          {step === 'load_failed' && (
            <div id="baseline-desc" className="baseline-body">
              <p>
                There's no saved baseline on the server yet (or it couldn't be loaded). You can
                capture your own — it only takes a minute.
              </p>
              <div className="baseline-actions">
                <button type="button" className="baseline-btn-ghost" onClick={() => close('cancel')}>
                  Cancel
                </button>
                <button type="button" className="baseline-btn-primary" onClick={chooseCapture}>
                  <Camera size={14} /> Capture instead
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
      <strong className="baseline-pick-popover-title">Pick an empty patch of sky</strong>
      <p className="baseline-pick-popover-desc">
        Use the sky map to choose somewhere quiet — high in the sky, away from the Sun and
        the bright band of the Milky Way. Click a point on the map to load it as your
        target, then hit the Slew button to drive the dish there.
      </p>
      <div className="baseline-pick-popover-actions">
        <button type="button" className="rt-tour-btn rt-tour-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="rt-tour-btn rt-tour-btn-primary" onClick={onConfirm}>
          I've picked a spot
        </button>
      </div>
    </div>,
    document.body,
  );
}

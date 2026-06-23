import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';


const POLL_INTERVAL_MS = 350;   // ~3 fps target
const REQUEST_TIMEOUT_MS = 4000; // give up on a stalled fetch and try again
const MAX_FAILURES = 8;          // before declaring offline

export function CameraPip() {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState('Cam A');
  const [error, setError] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [minimized, setMinimized] = useState(false);
  const prevUrlRef = useRef<string | null>(null);

  useEffect(() => {
    fetch('/api/camera/status')
      .then((r) => r.json())
      .then((d: { enabled: boolean; label: string }) => {
        setEnabled(d.enabled);
        setLabel(d.label);
      })
      .catch(() => {/* non-critical */});
  }, []);

  // Snapshot polling. Each frame is its own request — if one stalls we abort
  // it after REQUEST_TIMEOUT_MS and start a new one. The displayed frame only
  // updates when a *fresh* image finishes loading, so a slow network reduces
  // FPS rather than accumulating latency the way an MJPEG stream would.
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let failures = 0;
    let timer: number | undefined;
    let activeController: AbortController | null = null;

    const tick = async () => {
      if (cancelled || document.hidden) {
        // Skip polling while the tab is hidden; the browser may freeze us
        // anyway and we don't want a burst of pending requests on resume.
        timer = window.setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }

      const controller = new AbortController();
      activeController = controller;
      const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch('/api/camera/frame', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (cancelled) {
          URL.revokeObjectURL(URL.createObjectURL(blob));
        } else {
          const url = URL.createObjectURL(blob);
          const prev = prevUrlRef.current;
          prevUrlRef.current = url;
          setFrameUrl(url);
          if (prev) URL.revokeObjectURL(prev);
          failures = 0;
          setError(false);
        }
      } catch {
        failures += 1;
        if (failures >= MAX_FAILURES) setError(true);
      } finally {
        window.clearTimeout(timeoutId);
        if (activeController === controller) activeController = null;
      }

      if (!cancelled) timer = window.setTimeout(tick, POLL_INTERVAL_MS);
    };

    tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      if (activeController) activeController.abort();
      if (prevUrlRef.current) {
        URL.revokeObjectURL(prevUrlRef.current);
        prevUrlRef.current = null;
      }
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className={`cam-pip${error ? ' cam-pip-error' : ''}${minimized ? ' cam-pip-minimized' : ''}`}>
      {!minimized && (
        <>
          {frameUrl ? (
            <img className="cam-pip-feed" src={frameUrl} alt="Camera feed" />
          ) : (
            <div className="cam-pip-feed" />
          )}
          {error ? (
            <div className="cam-pip-offline">No signal</div>
          ) : (
            <div className="cam-pip-live"><span className="cam-pip-dot" />LIVE</div>
          )}
        </>
      )}
      <div className="cam-pip-label">
        <span>{label}</span>
        <button
          type="button"
          className="cam-pip-minimize"
          aria-label={minimized ? 'Restore camera overlay' : 'Minimize camera overlay'}
          onClick={() => setMinimized((value) => !value)}
          title={minimized ? 'Restore camera overlay' : 'Minimize camera overlay'}
        >
          {minimized ? <Maximize2 size={14} strokeWidth={2} /> : <Minimize2 size={14} strokeWidth={2} />}
        </button>
      </div>
    </div>
  );
}

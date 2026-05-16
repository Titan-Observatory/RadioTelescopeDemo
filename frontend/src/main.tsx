import './styles/main.css';

import {
  Activity, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  HelpCircle, Maximize2, MessageSquare, Minimize2, Monitor, Navigation, X, Zap,
} from 'lucide-react';
import React, { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { api, ApiError } from './api';
import { BRAND } from './branding';
import { SkyMap } from './components/SkyMap';
import { SpectrumPanel } from './components/SpectrumPanel';
import { QueuePage } from './components/QueuePage';
import { startTour, maybePromptFirstVisit } from './tour';
import { startGuidedObservation } from './guidedObservation';
import { FeedbackDialog } from './components/FeedbackDialog';
import { setAnalyticsContext, track } from './analytics';
import { useJsonSocket } from './lib/useJsonSocket';
import type { QueueConfig, QueueStatus } from './queue';
import type { CommandInfo, LnaStatus, RoboClawTelemetry, TelescopeConfig } from './types';

interface RfStatus {
  lna?: LnaStatus;
}

// Apply branding to the document head so favicon + title share the same source as the TopBar.
document.title = BRAND.name;
const favicon = document.getElementById('favicon') as HTMLLinkElement | null;
if (favicon) favicon.href = BRAND.faviconUrl;

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [telemetry, setTelemetry] = useState<RoboClawTelemetry | null>(null);
  const [lnaStatus, setLnaStatus] = useState<LnaStatus | null>(null);
  const [lnaChanging, setLnaChanging] = useState(false);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [telescopeConfig, setTelescopeConfig] = useState<TelescopeConfig | null>(null);
  const [targetAz, setTargetAz] = useState(0);
  const [targetAlt, setTargetAlt] = useState(45);
  const [hasMapTarget, setHasMapTarget] = useState(false);
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [queueConfig, setQueueConfig] = useState<QueueConfig | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const prevIsActiveRef = useRef<boolean | null>(null);
  const lastLeaseRemainingRef = useRef<number | null>(null);
  const skymapPanelRef = useRef<HTMLElement>(null);
  const [isSkymapFullscreen, setIsSkymapFullscreen] = useState(false);

  // Errors are tracked for analytics but never surfaced to the demo user —
  // public visitors see a quiet UI even when the controller is misbehaving.
  // Dedup last (source, message) to avoid flooding the events log on a flap.
  const lastErrorRef = useRef<{ source: string; message: string } | null>(null);
  const trackErrorOnce = (source: string, message: string) => {
    const last = lastErrorRef.current;
    if (last && last.source === source && last.message === message) return;
    lastErrorRef.current = { source, message };
    track('error_shown', { source, message: message.slice(0, 200) });
  };

  // Bootstrap queue state and telemetry. Telemetry is read-only and visible
  // to spectators as well as the active controller.
  useEffect(() => {
    void api.queueConfig().then(setQueueConfig).catch(() => {/* queue may be disabled */});
    void api.queueStatus().then(setQueueStatus).catch(() => {/* not joined yet */});

    void api.status().then((next) => {
      setTelemetry(next);
      if (next.last_error) trackErrorOnce('RoboClaw', next.last_error);
    }).catch((err) => trackErrorOnce('API', errorMessage(err)));
    void api.commands().then(setCommands).catch((err) => trackErrorOnce('API', errorMessage(err)));
    void api.telescopeConfig().then(setTelescopeConfig).catch(() => {/* non-critical */});
  }, []);

  // Telemetry websocket. The hook handles protocol selection, JSON parsing,
  // and teardown — we only own the "what to do with each frame" callback.
  useJsonSocket<RoboClawTelemetry>('/ws/roboclaw', {
    onMessage: (next) => {
      setTelemetry(next);
      if (next.last_error) trackErrorOnce('RoboClaw', next.last_error);
    },
    onError: () => trackErrorOnce('WebSocket', 'RoboClaw telemetry websocket disconnected.'),
  });

  const refreshLnaStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/spectrum/status');
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const next = await resp.json() as RfStatus;
      setLnaStatus(next.lna ?? null);
    } catch {
      setLnaStatus({ state: 'unknown', label: 'Unknown', detail: 'RF status unavailable' });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (cancelled) return;
      await refreshLnaStatus();
    };
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshLnaStatus]);

  const toggleLna = async () => {
    if (lnaChanging) return;
    const enabled = lnaStatus?.state !== 'on';
    setLnaChanging(true);
    setLnaStatus({
      state: enabled ? 'on' : 'off',
      label: enabled ? 'On' : 'Off',
      detail: enabled ? 'Turning Airspy bias tee on' : 'Turning Airspy bias tee off',
    });
    try {
      const result = await api.setSpectrumLna(enabled);
      setLnaStatus(result.lna);
      track('lna_toggled', { enabled, ok: result.ok });
    } catch (err) {
      track('lna_toggle_failed', { enabled, message: errorMessage(err).slice(0, 200) });
      await refreshLnaStatus();
    } finally {
      setLnaChanging(false);
    }
  };

  // Subscribe to queue status updates as long as we have a session cookie.
  const queueWsEnabled = queueStatus != null && queueStatus.position >= 0;
  const { send: sendQueueActivity } = useJsonSocket<QueueStatus>('/ws/queue', {
    enabled: queueWsEnabled,
    onMessage: (next) => {
      if (typeof next.position === 'number') setQueueStatus(next);
    },
  });

  // Treat any UI activity (click, scroll, keypress, pointer) as a heartbeat
  // that resets the server-side idle countdown. Throttled so we send at
  // most once every few seconds while the user is interacting.
  useEffect(() => {
    if (!queueWsEnabled) return;
    let lastSent = 0;
    const sendActivity = () => {
      const now = Date.now();
      if (now - lastSent < 5000) return;
      lastSent = now;
      sendQueueActivity('a');
    };
    const events: (keyof DocumentEventMap)[] = ['click', 'scroll', 'keydown', 'pointerdown', 'wheel', 'touchstart'];
    for (const e of events) {
      document.addEventListener(e, sendActivity, { passive: true, capture: true });
    }
    return () => {
      for (const e of events) {
        document.removeEventListener(e, sendActivity, { capture: true });
      }
    };
  }, [queueWsEnabled, sendQueueActivity]);

  // Track the last known lease time so we can distinguish lease expiry from
  // idle timeout when the session drops.
  useEffect(() => {
    if (queueStatus?.lease_remaining_s != null) {
      lastLeaseRemainingRef.current = queueStatus.lease_remaining_s;
    }
  }, [queueStatus?.lease_remaining_s]);

  // Auto-refresh only on hard lease expiry with an empty queue. An idle
  // timeout leaves plenty of lease time remaining, so lastLeaseRemainingRef
  // will still be high — correctly skipping the reload in that case.
  useEffect(() => {
    const wasActive = prevIsActiveRef.current;
    prevIsActiveRef.current = queueStatus?.is_active ?? null;
    if (
      wasActive === true &&
      queueStatus?.is_active === false &&
      queueStatus.queue_length === 0 &&
      lastLeaseRemainingRef.current != null &&
      lastLeaseRemainingRef.current < 15
    ) {
      window.location.reload();
    }
  }, [queueStatus?.is_active, queueStatus?.queue_length]);

  useEffect(() => {
    const handler = () => setIsSkymapFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleSkymapFullscreen = () => {
    if (!document.fullscreenElement) {
      skymapPanelRef.current?.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  };

  const handleJoin = async (turnstileToken: string | null) => {
    setJoining(true);
    setJoinError(null);
    track('queue_join_attempt', { turnstile: turnstileToken != null });
    try {
      const next = await api.joinQueue(turnstileToken);
      setQueueStatus(next);
      track('queue_joined', { position: next.position, queue_length: next.queue_length });
    } catch (err) {
      const message = errorMessage(err);
      setJoinError(message);
      track('queue_join_failed', { message: message.slice(0, 200) });
    } finally {
      setJoining(false);
    }
  };

  const commandById = useMemo(
    () => Object.fromEntries(commands.map((c) => [c.id, c])),
    [commands],
  );

  const runCommand = async (commandId: string, args: Record<string, number | boolean>) => {
    const command = commandById[commandId];
    if (!command) {
      track('command_failed', { command_id: commandId, message: 'unavailable' });
      return;
    }
    try {
      await api.execute(command.id, args);
      setTelemetry(await api.status());
    } catch (err) {
      track('command_failed', { command_id: commandId, message: errorMessage(err).slice(0, 200) });
    }
  };

  const gotoAltAz = async (altDeg: number, azDeg: number) => {
    track('goto_submitted', { alt_deg: altDeg, az_deg: azDeg });
    try {
      await api.gotoAltAz(altDeg, azDeg);
      setTelemetry(await api.status());
    } catch (err) {
      track('goto_failed', { message: errorMessage(err).slice(0, 200) });
    }
  };

  const stopMotion = async () => {
    track('motion_stop');
    try {
      await api.stop();
      setTelemetry(await api.status());
    } catch (err) {
      track('command_failed', { command_id: 'stop', message: errorMessage(err).slice(0, 200) });
    }
  };

  const startObservationGuide = useCallback(() => {
    startGuidedObservation(async (raDeg, decDeg) => {
      track('goto_radec_submitted', { ra_deg: raDeg, dec_deg: decDeg });
      try {
        await api.gotoRaDec({ ra_deg: raDeg, dec_deg: decDeg });
        setTelemetry(await api.status());
      } catch (err) {
        track('goto_radec_failed', { message: errorMessage(err).slice(0, 200) });
        throw err;
      }
    });
  }, []);

  const handleMapTarget = useCallback((az: number, alt: number) => {
    setTargetAz(Math.round(az * 1000) / 1000);
    setTargetAlt(Math.round(alt * 1000) / 1000);
    setHasMapTarget(true);
    track('map_target_picked', { alt_deg: alt, az_deg: az });
  }, []);

  // Queue gating: when the queue is enabled and we are not the active
  // controller, render the spectator/queue page instead of the control UI.
  // Position 0 = active controller; -1 = not in queue; >0 = waiting.
  const queueEnabled = queueConfig?.enabled ?? false;
  const hasControl = !queueEnabled || queueStatus?.is_active === true;
  const [continueAcked, setContinueAcked] = useState(false);
  const isActiveController = hasControl && (!queueEnabled || continueAcked);

  // Keep analytics context current so every tracked event is tagged with
  // queue position and controller status without per-call boilerplate.
  useEffect(() => {
    setAnalyticsContext({
      isActiveController,
      queuePosition: queueStatus?.position ?? null,
    });
  }, [isActiveController, queueStatus?.position]);

  // One session_start per tab — fires after the queue state is known so the
  // controller/spectator split is captured on the first row.
  const sessionStartedRef = useRef(false);
  useEffect(() => {
    if (sessionStartedRef.current) return;
    if (queueEnabled && queueStatus == null) return;
    sessionStartedRef.current = true;
    track('session_start', {
      queue_enabled: queueEnabled,
      entered_as: isActiveController ? 'controller' : 'spectator',
    });
  }, [queueEnabled, queueStatus, isActiveController]);

  // Offer the first-visit guided tour once the user actually has the controls
  // in front of them — no point prompting while they're still on the queue page.
  useEffect(() => {
    if (!isActiveController) return;
    const t = setTimeout(() => maybePromptFirstVisit(startObservationGuide), 600);
    return () => clearTimeout(t);
  }, [isActiveController, startObservationGuide]);

  if (queueEnabled && !isActiveController) {
    return (
      <QueuePage
        status={queueStatus}
        joining={joining}
        joinError={joinError}
        siteKey={queueConfig?.turnstile_site_key ?? null}
        turnstileEnabled={queueConfig?.turnstile_enabled ?? false}
        onJoin={handleJoin}
        hasControl={hasControl}
        onContinue={() => setContinueAcked(true)}
      />
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        telemetry={telemetry}
        leaseStatus={queueEnabled && queueStatus?.is_active ? queueStatus : null}
      />

      <main className="dashboard">
        <section className="panel skymap-panel" ref={skymapPanelRef}>
          <SkyMap
            telemetry={telemetry}
            config={telescopeConfig}
            onNotice={() => { /* errors suppressed for demo */ }}
            onTarget={handleMapTarget}
            tooltipsEnabled={true}
          />
          <div className="skymap-bottom-dock">
            <button
              type="button"
              className="skymap-mobile-fullscreen-btn"
              onClick={toggleSkymapFullscreen}
              aria-label={isSkymapFullscreen ? 'Exit full screen' : 'Full screen'}
              title={isSkymapFullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {isSkymapFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <div className="skymap-overlay-controls">
              <MotionControls
                runCommand={runCommand}
                gotoAltAz={gotoAltAz}
                targetAz={targetAz}
                targetAlt={targetAlt}
                setTargetAz={setTargetAz}
                setTargetAlt={setTargetAlt}
                onStop={stopMotion}
              />
            </div>
            {hasMapTarget && (
              <button
                type="button"
                className="skymap-slew-target"
                onClick={() => { track('slew_from_map', { alt_deg: targetAlt, az_deg: targetAz }); void gotoAltAz(targetAlt, targetAz); }}
                title={`Slew to Az ${targetAz.toFixed(3)} deg, Alt ${targetAlt.toFixed(3)} deg`}
              >
                Slew
              </button>
            )}
          </div>
        </section>
        <div className="dashboard-rightcol">
          <section className="panel spectrum-panel-host">
            <SpectrumPanel onStartGuided={startObservationGuide} />
          </section>
          <section className="panel status-side-panel">
            <TelemetryDashboard telemetry={telemetry} lnaStatus={lnaStatus} lnaChanging={lnaChanging} onToggleLna={toggleLna} />
          </section>
        </div>
      </main>

      <InfoSection />
      <MobileHint />
    </div>
  );
}

// ─── Mobile hint ─────────────────────────────────────────────────────────────

const MOBILE_HINT_KEY = 'rt-mobile-hint-dismissed';

function MobileHint() {
  const [visible, setVisible] = useState(() =>
    typeof window !== 'undefined' &&
    window.innerWidth <= 640 &&
    !localStorage.getItem(MOBILE_HINT_KEY),
  );

  if (!visible) return null;

  const dismiss = () => {
    localStorage.setItem(MOBILE_HINT_KEY, '1');
    setVisible(false);
  };

  return (
    <div className="mobile-hint" role="dialog" aria-label="Desktop recommendation">
      <Monitor size={16} className="mobile-hint-icon" aria-hidden="true" />
      <p className="mobile-hint-text">
        For the best experience, open this page on a desktop browser.
      </p>
      <button type="button" className="mobile-hint-close" onClick={dismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}

function LeaseChip({ status }: { status: QueueStatus }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const remaining = Math.max(0, Math.round(status.lease_remaining_s ?? 0));
  const idle = status.idle_remaining_s == null ? null : Math.max(0, Math.round(status.idle_remaining_s));
  return (
    <button
      type="button"
      className={`topbar-lease${detailOpen ? ' topbar-lease-open' : ''}`}
      aria-label="Session time limit explanation"
      aria-expanded={detailOpen}
      aria-describedby="session-limit-popover"
      onClick={() => setDetailOpen((open) => !open)}
      onBlur={() => setDetailOpen(false)}
    >
      <Activity size={12} />
      <span className="topbar-lease-label">Session</span>
      <strong>{formatSeconds(remaining)}</strong>
      {idle != null && idle < 30 && (
        <span className="topbar-lease-idle">· idle {idle}s</span>
      )}
      <span id="session-limit-popover" className="topbar-lease-popover" role="tooltip">
        <strong>Why sessions are timed</strong>
        <span>
          This demo is limited to give everyone an opportunity to use it.
          When your timer ends, control passes to the next visitor.
        </span>
      </span>
    </button>
  );
}

function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

// ─── TopBar ──────────────────────────────────────────────────────────────────

function TopBar({
  telemetry,
  leaseStatus,
}: {
  telemetry: RoboClawTelemetry | null;
  leaseStatus: QueueStatus | null;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <>
      <header className="topbar">
        <a className="topbar-brand" href={BRAND.homepage} target="_blank" rel="noreferrer">
          <img src={BRAND.logoUrl} alt={BRAND.name} className="brand-logo" />
        </a>
        <div className="topbar-status">
          {leaseStatus && <LeaseChip status={leaseStatus} />}
          <button
            type="button"
            className="topbar-feedback"
            onClick={() => { track('feedback_opened'); setFeedbackOpen(true); }}
            title="Share feedback about the telescope experience"
          >
            <MessageSquare size={14} /> Feedback
          </button>
          <button
            type="button"
            className="topbar-help"
            onClick={() => { track('tour_button_clicked'); startTour('button'); }}
            title="Take a guided tour of the controls"
          >
            <HelpCircle size={14} /> Tour
          </button>
          <span className="topbar-time" title="Time at the telescope (EST)">
            <span className="topbar-time-label">Telescope time</span>
            {telemetry
              ? `${new Date(telemetry.timestamp * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })} EST`
              : '—'}
          </span>
        </div>
      </header>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}

// ─── Telescope controls ───────────────────────────────────────────────────────

// Combined floating control surface. A sliding segmented toggle picks between
// the press-and-hold jog pad and the numeric GoTo form so a single overlay
// holds both interaction modes without doubling the on-screen real estate.
function MotionControls({
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

// ─── Pointing pad + axis status ───────────────────────────────────────────────

// RoboClaw's firmware serial-timeout failsafe stops the motors if no command
// arrives within ~1 s. Re-issuing the drive command at this cadence is safely
// inside that window while still being light on the bus.
const JOG_REPEAT_MS = 200;

function PointingPad({ runCommand, speed }: {
  runCommand: (id: string, args: Record<string, number | boolean>) => Promise<void>;
  speed: number;
}) {
  // Track on press only (not every repeat tick) — useJog's start fires every
  // JOG_REPEAT_MS while held, which would flood the events log otherwise.
  const onPress = (direction: 'west' | 'east' | 'up' | 'down') =>
    track('jog_pressed', { direction, speed });

  const west = useJog(() => runCommand('backward_m1', { speed }), () => runCommand('backward_m1', { speed: 0 }), () => onPress('west'));
  const east = useJog(() => runCommand('forward_m1',  { speed }), () => runCommand('forward_m1',  { speed: 0 }), () => onPress('east'));
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

// ─── Telemetry dashboard ─────────────────────────────────────────────────────

function TelemetryDashboard({
  telemetry,
  lnaStatus,
  lnaChanging,
  onToggleLna,
}: {
  telemetry: RoboClawTelemetry | null;
  lnaStatus: LnaStatus | null;
  lnaChanging: boolean;
  onToggleLna: () => void;
}) {
  const systemPower = minReading(telemetry?.main_battery_v, telemetry?.logic_battery_v);
  const roboclawTemp = maxReading(telemetry?.temperature_c, telemetry?.temperature_2_c);
  const motorOutput = maxAbsReading(telemetry?.motors.m1?.pwm, telemetry?.motors.m2?.pwm);
  const motorSpeed = maxAbsReading(telemetry?.motors.m1?.speed_qpps, telemetry?.motors.m2?.speed_qpps);

  return (
    <>
      <div className="telemetry-dense">
        <DenseReadout title="System" icon={<Activity size={11} />} rows={[
          ['Connection', telemetry?.connection?.connected === false ? 'Issue' : 'Stable', telemetry?.connection?.connected === false ? 'val-crit' : 'val-ok'],
          ['LNA', <LnaPill status={lnaStatus} changing={lnaChanging} onToggle={onToggleLna} />],
          ['Power', volts(systemPower), voltClass(systemPower)],
          ['RoboClaw temp', celsius(roboclawTemp), tempClass(roboclawTemp)],
          ['Pi temp', celsius(telemetry?.host.cpu_temp_c), tempClass(telemetry?.host.cpu_temp_c)],
        ]} />
        <DenseReadout title="Pointing" icon={<Navigation size={11} />} rows={[
          ['Azimuth', telemetry?.azimuth_deg == null ? '—' : `${telemetry.azimuth_deg.toFixed(2)}°`],
          ['Elevation', telemetry?.altitude_deg == null ? '—' : `${telemetry.altitude_deg.toFixed(2)}°`],
        ]} />
        <DenseReadout title="Drive" icon={<Zap size={11} />} rows={[
          ['State', motorState(motorSpeed, motorOutput)],
          ['Azimuth amps', amps(telemetry?.motors.m1?.current_a)],
          ['Elevation amps', amps(telemetry?.motors.m2?.current_a)],
          ['Azimuth encoder', encoder(telemetry?.motors.m1?.encoder)],
          ['Elevation encoder', encoder(telemetry?.motors.m2?.encoder)],
        ]} />
      </div>
    </>
  );
}

// ─── Dense readout ────────────────────────────────────────────────────────────

type ReadoutRow = [label: string, value: React.ReactNode, valueClass?: string];

function DenseReadout({ title, icon, rows }: { title?: string; icon?: React.ReactNode; rows: ReadoutRow[] }) {
  return (
    <div className="dense-readout">
      {title && (
        <h3>
          {icon && <span className="readout-icon">{icon}</span>}
          {title}
        </h3>
      )}
      <dl>
        {rows.map(([label, val, cls]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd className={cls ?? ''}>{val}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

function LnaPill({
  status,
  changing,
  onToggle,
}: {
  status: LnaStatus | null | undefined;
  changing: boolean;
  onToggle: () => void;
}) {
  const state = status?.state ?? 'unknown';
  const label = changing ? '...' : (status?.label ?? 'Unknown');
  const next = state === 'on' ? 'off' : 'on';
  return (
    <button
      type="button"
      className={`lna-status-pill lna-status-${state}`}
      title={status?.detail ?? `Turn LNA ${next}`}
      aria-label={`Turn LNA ${next}`}
      aria-pressed={state === 'on'}
      disabled={changing}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function volts(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(2)} V`;
}

function celsius(input: number | null | undefined): string {
  return input == null ? '—' : `${input.toFixed(1)} °C`;
}

function amps(input: number | null | undefined): string {
  return input == null ? '—' : `${Math.abs(input).toFixed(2)} A`;
}

function encoder(input: number | null | undefined): string {
  return input == null ? '—' : input.toLocaleString();
}

function minReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length === 0 ? null : Math.min(...present);
}

function maxReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length === 0 ? null : Math.max(...present);
}

function maxAbsReading(...values: Array<number | null | undefined>): number | null {
  const present = values.filter((v): v is number => v != null).map(Math.abs);
  return present.length === 0 ? null : Math.max(...present);
}

function motorState(speed: number | null, output: number | null): string {
  if (speed == null && output == null) return '—';
  return (speed ?? 0) > 0 || (output ?? 0) > 0 ? 'Moving' : 'Idle';
}

// ─── Status classifiers ──────────────────────────────────────────────────────

function voltClass(v: number | null | undefined): string {
  if (v == null) return '';
  if (v < 10) return 'val-crit';
  if (v < 11.5) return 'val-warn';
  return 'val-ok';
}

function tempClass(c: number | null | undefined): string {
  if (c == null) return '';
  if (c > 75) return 'val-crit';
  if (c > 60) return 'val-warn';
  return '';
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

// ─── Info section ────────────────────────────────────────────────────────────

const PLANNED_FEATURES = [
  'Multi-user scheduling — reserve observation windows days in advance',
  'RA/Dec & object-name GoTo — point at Andromeda by name',
  'Pulsar timing — detect rotational slow-down of known pulsars',
  'Hydrogen-line mapping — image the galactic plane in 21 cm',
  'Interferometry baseline — phase-coherent linking of multiple dishes',
  'Real-time sky subtraction & RFI excision pipeline',
  'Educational live-stream mode with annotated overlays',
  'Automated nightly observation queue with public data archive',
];

function InfoSection() {
  return (
    <section className="info-section">
      <div className="info-section-inner">

        <div className="info-col info-col-about">
          <h2 className="info-col-heading">About this demo</h2>
          <p>
            Titan Observatory is a community radio telescope built on a Raspberry Pi,
            a motorised dish, and a software-defined radio receiver. This page gives you
            live remote access to the real hardware — the sky map and spectrum panel
            update in real time from the telescope's position and RF front-end.
          </p>
          <p>
            The queue system ensures fair access: each visitor gets a timed session
            at the controls while spectators watch along. Commands are rate-limited
            and safety interlocks prevent the dish from leaving its allowed range.
          </p>
          <p className="info-note">
            All data leaving the server is anonymised. Session tokens are ephemeral
            and no personal information is stored.
          </p>
        </div>

        <div className="info-col info-col-features">
          <h2 className="info-col-heading">Roadmap</h2>
          <p className="info-col-sub">Features we're building toward for the full observatory:</p>
          <ul className="feature-list">
            {PLANNED_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>

        <div className="info-col info-col-donate">
          <h2 className="info-col-heading">Support the observatory</h2>
          <p>
            Titan Observatory runs entirely on community donations. Every dollar goes
            toward hardware, hosting, and expanding capacity — more dishes, more bandwidth,
            more time online for everyone.
          </p>
          <ul className="donate-impact-list">
            <li><strong>$10</strong> keeps the server running for a week</li>
            <li><strong>$50</strong> funds a new low-noise amplifier</li>
            <li><strong>$250</strong> contributes toward a second dish</li>
          </ul>
          <a
            className="donate-cta"
            href={BRAND.homepage}
            target="_blank"
            rel="noreferrer"
            onClick={() => track('donate_clicked')}
          >
            Donate to Titan Observatory
          </a>
          <p className="info-note">
            Titan Observatory is a volunteer-run project. All contributions are
            used directly for observatory operations and development.
          </p>
        </div>

      </div>
    </section>
  );
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);

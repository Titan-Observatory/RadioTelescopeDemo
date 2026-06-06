import { Maximize2, Minimize2, Navigation } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { setAnalyticsContext, track } from './analytics';
import { BRAND } from './branding';
import { InfoSection } from './components/InfoSection';
import { MobileHint } from './components/MobileHint';
import { MotionControls } from './components/MotionControls';
import { AdminPage } from './components/AdminPage';
import { QueuePage } from './components/QueuePage';
import { SkyMap } from './components/SkyMap';
import { SpectrumPanel } from './components/SpectrumPanel';
import { TelemetryDashboard } from './components/TelemetryDashboard';
import { TopBar } from './components/TopBar';
import { useBackendCatalog } from './lib/useBackendCatalog';
import { useErrorTracking } from './lib/useErrorTracking';
import { useFullscreen } from './lib/useFullscreen';
import { useLna } from './lib/useLna';
import { useMapTarget } from './lib/useMapTarget';
import { useMotionCommands } from './lib/useMotionCommands';
import { useQueueLease } from './lib/useQueueLease';
import { useTelemetry } from './lib/useTelemetry';
import { maybePromptFirstVisit } from './tour';

// Apply branding to the document head so favicon + title share the same source as the TopBar.
document.title = BRAND.name;
const favicon = document.getElementById('favicon') as HTMLLinkElement | null;
if (favicon) favicon.href = BRAND.faviconUrl;

interface ControlUIProps {
  queue: ReturnType<typeof useQueueLease>;
}

function ControlUI({ queue }: ControlUIProps) {
  const { trackErrorOnce } = useErrorTracking();
  const liveControlsEnabled = useAfterInitialPaint();
  const { telemetry, setTelemetry } = useTelemetry({ enabled: liveControlsEnabled, onError: trackErrorOnce });
  const { lnaStatus } = useLna(liveControlsEnabled);
  const { commands, telescopeConfig } = useBackendCatalog({ enabled: liveControlsEnabled, onError: trackErrorOnce });
  const map = useMapTarget();
  const motion = useMotionCommands(commands, setTelemetry);

  const skymapPanelRef = useRef<HTMLElement>(null);
  const { isFullscreen: isSkymapFullscreen, toggle: toggleSkymapFullscreen } = useFullscreen(skymapPanelRef);

  // One session_start per tab, only once the user reaches the live controls.
  const sessionStartedRef = useRef(false);
  useEffect(() => {
    if (sessionStartedRef.current) return;
    sessionStartedRef.current = true;
    track('session_start', {
      queue_enabled: queue.queueEnabled,
      entered_as: queue.isActiveController ? 'controller' : 'spectator',
    });
  }, [queue.queueEnabled, queue.isActiveController]);

  // Offer the first-visit guided tour once the user actually has the controls.
  useEffect(() => {
    const t = setTimeout(() => maybePromptFirstVisit(motion.startObservationGuide), 600);
    return () => clearTimeout(t);
  }, [motion.startObservationGuide]);

  return (
    <div className="app-shell">
      <TopBar
        telemetry={telemetry}
        leaseStatus={queue.queueEnabled && queue.queueStatus?.is_active ? queue.queueStatus : null}
      />

      <main className="dashboard">
        <section className="panel skymap-panel" ref={skymapPanelRef}>
          <SkyMap
            telemetry={telemetry}
            config={telescopeConfig}
            onNotice={() => { /* errors suppressed for demo */ }}
            onTarget={map.setTarget}
            onClearTarget={map.clearTarget}
            tooltipsEnabled={true}
            toolbarLeading={(
              <button
                type="button"
                className="skymap-fullscreen-btn"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSkymapFullscreen();
                }}
                aria-label={isSkymapFullscreen ? 'Exit full screen' : 'Full screen'}
                title={isSkymapFullscreen ? 'Exit full screen' : 'Full screen'}
              >
                {isSkymapFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}
          />
          <div className="skymap-bottom-dock">
            <div className="skymap-overlay-controls">
              <MotionControls
                jog={motion.jog}
                stopJog={motion.stopJog}
                gotoAltAz={motion.gotoAltAz}
                targetAz={map.targetAz}
                targetAlt={map.targetAlt}
                setTargetAz={map.setTargetAz}
                setTargetAlt={map.setTargetAlt}
                onStop={motion.stopMotion}
              />
            </div>
            {map.hasMapTarget && (
              <button
                type="button"
                className="skymap-slew-target"
                onClick={() => { track('slew_from_map', { alt_deg: map.targetAlt, az_deg: map.targetAz }); void motion.gotoAltAz(map.targetAlt, map.targetAz); }}
                title={`Slew to Az ${map.targetAz.toFixed(3)} deg, Alt ${map.targetAlt.toFixed(3)} deg`}
              >
                <Navigation size={15} />
                <span>Slew</span>
              </button>
            )}
          </div>
        </section>
        <div className="dashboard-rightcol">
          <section className="panel spectrum-panel-host">
            <SpectrumPanel enabled={liveControlsEnabled} onStartGuided={motion.startObservationGuide} />
          </section>
          <section className="panel status-side-panel">
            <TelemetryDashboard
              telemetry={telemetry}
              config={telescopeConfig}
              lnaStatus={lnaStatus}
            />
          </section>
        </div>
      </main>

      <InfoSection />
      <MobileHint />
    </div>
  );
}

function useAfterInitialPaint() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let firstFrame = 0;
    let secondFrame = 0;

    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!cancelled) setReady(true);
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, []);

  return ready;
}

export default function App() {
  // Tiny path-based router. The admin surface is LAN-only on the server side
  // (require_lan_admin returns 404 for non-LAN clients), so it's safe to expose
  // the route here unconditionally — the panel just fails to load data.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
    return <AdminPage />;
  }

  const queue = useQueueLease();

  // Keep analytics context current so every tracked event is tagged with
  // queue position and controller status without per-call boilerplate.
  useEffect(() => {
    setAnalyticsContext({
      isActiveController: queue.isActiveController,
      queuePosition: queue.queueStatus?.position ?? null,
    });
  }, [queue.isActiveController, queue.queueStatus?.position]);

  // Queue gating: when the queue is enabled and we are not the active
  // controller, render the spectator/queue page instead of the control UI.
  if (!queue.queueReady || (queue.queueEnabled && !queue.isActiveController)) {
    return (
      <QueuePage
        status={queue.queueStatus}
        joining={queue.joining}
        joinError={queue.joinError}
        joinRateLimitedSec={queue.joinRateLimitedSec}
        siteKey={queue.queueConfig?.turnstile_site_key ?? null}
        turnstileEnabled={queue.queueConfig?.turnstile_enabled ?? false}
        betaPasswordEnabled={queue.queueConfig?.beta_password_enabled ?? false}
        onJoin={queue.join}
        hasControl={queue.hasControl}
        onContinue={queue.acknowledgeContinue}
        loading={!queue.queueReady}
        telescopeStatus={queue.queueConfig?.telescope_status ?? null}
      />
    );
  }

  return <ControlUI queue={queue} />;
}

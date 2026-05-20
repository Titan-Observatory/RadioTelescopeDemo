import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { setAnalyticsContext, track } from './analytics';
import { BRAND } from './branding';
import { DopplerRenderHarness } from './components/DopplerRenderHarness';
import { InfoSection } from './components/InfoSection';
import { MobileHint } from './components/MobileHint';
import { MotionControls } from './components/MotionControls';
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

function App() {
  const { trackErrorOnce } = useErrorTracking();
  const { telemetry, setTelemetry } = useTelemetry({ onError: trackErrorOnce });
  const { lnaStatus, lnaChanging, toggleLna } = useLna();
  const { commands, telescopeConfig } = useBackendCatalog({ onError: trackErrorOnce });
  const queue = useQueueLease();
  const map = useMapTarget();
  const motion = useMotionCommands(commands, setTelemetry);

  const skymapPanelRef = useRef<HTMLElement>(null);
  const { isFullscreen: isSkymapFullscreen, toggle: toggleSkymapFullscreen } = useFullscreen(skymapPanelRef);

  // Keep analytics context current so every tracked event is tagged with
  // queue position and controller status without per-call boilerplate.
  useEffect(() => {
    setAnalyticsContext({
      isActiveController: queue.isActiveController,
      queuePosition: queue.queueStatus?.position ?? null,
    });
  }, [queue.isActiveController, queue.queueStatus?.position]);

  // One session_start per tab — fires after the queue state is known so the
  // controller/spectator split is captured on the first row.
  const sessionStartedRef = useRef(false);
  useEffect(() => {
    if (sessionStartedRef.current) return;
    if (!queue.queueReady) return;
    if (queue.queueEnabled && queue.queueStatus == null) return;
    sessionStartedRef.current = true;
    track('session_start', {
      queue_enabled: queue.queueEnabled,
      entered_as: queue.isActiveController ? 'controller' : 'spectator',
    });
  }, [queue.queueReady, queue.queueEnabled, queue.queueStatus, queue.isActiveController]);

  // Offer the first-visit guided tour once the user actually has the controls
  // in front of them — no point prompting while they're still on the queue page.
  useEffect(() => {
    if (!queue.isActiveController) return;
    const t = setTimeout(() => maybePromptFirstVisit(motion.startObservationGuide), 600);
    return () => clearTimeout(t);
  }, [queue.isActiveController, motion.startObservationGuide]);

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
      />
    );
  }

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
                homeElevation={motion.homeElevation}
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
                Slew
              </button>
            )}
          </div>
        </section>
        <div className="dashboard-rightcol">
          <section className="panel spectrum-panel-host">
            <SpectrumPanel onStartGuided={motion.startObservationGuide} />
          </section>
          <section className="panel status-side-panel">
            <TelemetryDashboard
              telemetry={telemetry}
              lnaStatus={lnaStatus}
              lnaChanging={lnaChanging}
              onToggleLna={toggleLna}
            />
          </section>
        </div>
      </main>

      <InfoSection />
      <MobileHint />
    </div>
  );
}

export default function LiveShell() {
  const params = new URLSearchParams(window.location.search);
  const renderTarget = params.get('render');
  return renderTarget === 'doppler' ? <DopplerRenderHarness /> : <App />;
}

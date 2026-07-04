import { Layers, Telescope } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import tourCopy from '../../data/tourCopy.json';
import { altAzToRaDec, raDecToAltAz, validateBaselinePointing } from '../../lib/astro';
import type { RaDecTarget, RoboClawTelemetry, SkyOverlay, TelescopeConfig } from '../../types';

import { CameraPip } from './CameraPip';
import { useAladinInit } from './aladin/useAladinInit';
import { useHorizonCanvas } from './horizon/useHorizonCanvas';
import { LightSpectrumSurveySelector } from './spectrum/SurveySelector';
import {
  HYDROGEN_SURVEY_ID,
  resolveHydrogenSurveySource,
  SURVEYS,
  type SurveyId,
  surveyToneClass,
} from './spectrum/surveys';

const FORCE_HYDROGEN_SURVEY_EVENT = 'rt-force-hydrogen-survey';
// Baseline "pick a spot" controls now live on the in-map galactic-band hint
// (the wizard's separate popover card is gone). The buttons can't reach the
// wizard directly, so they signal it via window events — same loose coupling
// as FORCE_HYDROGEN_SURVEY_EVENT. Mirrored in BaselineWizard.tsx.
const BASELINE_PICK_CONFIRM_EVENT = 'rt-baseline-pick-confirm';
const BASELINE_PICK_CANCEL_EVENT = 'rt-baseline-pick-cancel';


// ─── Component ────────────────────────────────────────────────────────────────
interface SkyMapProps {
  telemetry: RoboClawTelemetry | null;
  config: TelescopeConfig | null;
  onNotice: (msg: string | null) => void;
  onTarget: (az: number, alt: number, raDeg: number, decDeg: number) => void;
  onClearTarget?: () => void;
  /** Currently selected target (from a click or the typed GoTo). Drives the pin. */
  pendingTarget?: RaDecTarget | null;
  tooltipsEnabled: boolean;
  overlays?: SkyOverlay[];
  toolbarLeading?: ReactNode;
}

export function SkyMap({ telemetry, config, onNotice, onTarget, onClearTarget, pendingTarget = null, tooltipsEnabled, overlays = [], toolbarLeading }: SkyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const configRef       = useRef<TelescopeConfig | null>(null);
  const telemetryRef    = useRef<RoboClawTelemetry | null>(null);
  const pendingRef      = useRef<RaDecTarget | null>(null);
  const overlaysRef     = useRef<SkyOverlay[]>([]);
  const horizonCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const onTargetRef = useRef<((az: number, alt: number, raDeg: number, decDeg: number) => void) | null>(null);
  const onClearTargetRef = useRef<(() => void) | null>(null);
  // Mirrored so the init effect doesn't re-run (and tear down its event handlers)
  // every time the parent passes a fresh inline callback.
  const onNoticeRef = useRef<((msg: string | null) => void) | null>(null);
  // Latest selected survey, mirrored into a ref so the click handler (attached
  // once in the init effect) can check it without being rebuilt.
  const surveyRef = useRef<SurveyId>(HYDROGEN_SURVEY_ID);
  const [ready, setReady] = useState(false);
  // True while the baseline wizard's "pick a quiet patch" step is active. The
  // wizard signals it by toggling the `rt-baseline-pick` class on <body> (the
  // same hook it uses for its CSS spotlight), which lets us react without
  // threading the wizard's internal step state up from SpectrumPanel. When set
  // we shade the galactic-plane band and reject clicks that land inside it.
  const [galacticRestrict, setGalacticRestrict] = useState(false);
  const galacticExclusionRef = useRef(false);
  useEffect(() => { galacticExclusionRef.current = galacticRestrict; }, [galacticRestrict]);
  useEffect(() => {
    const sync = () => setGalacticRestrict(document.body.classList.contains('rt-baseline-pick'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  // The selected target is owned by the parent (map clicks and the typed GoTo
  // both flow through onTarget/onClearTarget), so the pin is fully controlled.
  const pending = pendingTarget;
  const [survey, setSurvey] = useState<SurveyId>(HYDROGEN_SURVEY_ID);
  const [viewSelectorOpen, setViewSelectorOpen] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<
    | { kind: 'sun' | 'beam' | 'pending' | 'satellite'; x: number; y: number; fwhm?: number; label?: string }
    | null
  >(null);

  useEffect(() => { configRef.current    = config;    }, [config]);
  useEffect(() => { telemetryRef.current = telemetry; }, [telemetry]);
  useEffect(() => { pendingRef.current   = pending;   }, [pending]);
  useEffect(() => { overlaysRef.current  = overlays;  }, [overlays]);
  useEffect(() => { onTargetRef.current  = onTarget;  }, [onTarget]);
  useEffect(() => { onClearTargetRef.current = onClearTarget ?? null; }, [onClearTarget]);
  useEffect(() => { onNoticeRef.current  = onNotice;  }, [onNotice]);
  useEffect(() => { surveyRef.current    = survey;    }, [survey]);
  useEffect(() => {
    const forceHydrogenSurvey = () => {
      setSurvey(HYDROGEN_SURVEY_ID);
      setViewSelectorOpen(false);
    };
    window.addEventListener(FORCE_HYDROGEN_SURVEY_EVENT, forceHydrogenSurvey);
    return () => window.removeEventListener(FORCE_HYDROGEN_SURVEY_EVENT, forceHydrogenSurvey);
  }, []);
  useEffect(() => {
    if (!tooltipsEnabled) setHoverTooltip(null);
  }, [tooltipsEnabled]);

  const {
    aladinRef,
    aladinModuleRef,
    beamOverlayRef,
    pendingOverlayRef,
    horizonOverlayRef,
    targetCatalogRef,
  } = useAladinInit({
    containerRef,
    config,
    configRef,
    telemetryRef,
    surveyRef,
    onTargetRef,
    onClearTargetRef,
    onNoticeRef,
    galacticExclusionRef,
    setReady,
    setHoverTooltip,
  });

  // Change survey
  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (survey === HYDROGEN_SURVEY_ID) {
      void resolveHydrogenSurveySource().then((source) => {
        if (!aladinRef.current || !aladinModuleRef.current) return;
        // The local mirror's PNG tiles are pre-rendered with the inferno
        // colormap baked in (see scripts/colorize_hips.py), so we load PNG
        // directly instead of fetching the 32-bit-float FITS tiles and
        // colormapping them per-frame — far lighter on pan/zoom. The remote
        // fallback HiPS carries the same png+fits formats, so png is valid
        // either way; only the local copy is recolored.
        aladinRef.current.setImageLayer(
          aladinModuleRef.current.imageHiPS(source, {
            name: 'HI4PI colorized hydrogen line',
            imgFormat: 'png',
          }),
        );
      });
      return;
    }

    aladinRef.current.setImageSurvey(survey);
  }, [survey, ready]);

  // Cardinal labels and horizon line are drawn by the canvas overlay below.
  // Clear the Aladin graphic overlay so it doesn't add noise.
  useEffect(() => {
    if (!ready || !horizonOverlayRef.current) return;
    horizonOverlayRef.current.removeAll();
  }, [ready]);

  const { sunZoneRef, beamZoneRef, pendingZoneRef, satelliteZoneRef } = useHorizonCanvas({
    ready,
    config,
    containerRef,
    canvasRef: horizonCanvasRef,
    aladinRef,
    configRef,
    telemetryRef,
    pendingRef,
    overlaysRef,
    galacticExclusionRef,
    surveyRef,
  });

  // Update beam circle on every telemetry tick
  useEffect(() => {
    if (!ready || !beamOverlayRef.current) return;
    const fwhm = config?.beam_fwhm_deg ?? 6.5;

    // Always derive RA/Dec from Alt/Az on the client so the round-trip stays
    // consistent with the click handler (both go through raDecToAltAz/altAzToRaDec).
    // Backend katpoint RA/Dec uses full corrections and disagrees by ~1° near the
    // horizon, which would make the beam land in the wrong place after "Set as Current".
    let ra_deg: number | null = null;
    let dec_deg: number | null = null;
    if (config && telemetry?.altitude_deg != null && telemetry?.azimuth_deg != null) {
      const pt = altAzToRaDec(
        { altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg },
        config, new Date(),
      );
      ra_deg  = pt.ra_deg;
      dec_deg = pt.dec_deg;
    } else {
      ra_deg  = telemetry?.ra_deg  ?? null;
      dec_deg = telemetry?.dec_deg ?? null;
    }

    beamOverlayRef.current.removeAll();
    if (ra_deg != null && dec_deg != null) {
      // Outer glow ring (2× FWHM radius, translucent)
      beamOverlayRef.current.add(
        aladinModuleRef.current!.circle(ra_deg, dec_deg, fwhm, { color: 'rgba(114,224,173,0.10)', lineWidth: 1 }),
      );
      // FWHM boundary ring
      beamOverlayRef.current.add(
        aladinModuleRef.current!.circle(ra_deg, dec_deg, fwhm / 2, { color: 'rgba(114,224,173,0.85)', lineWidth: 2 }),
      );
      // Centre dot
      beamOverlayRef.current.add(
        aladinModuleRef.current!.circle(ra_deg, dec_deg, 0.04, { color: '#72e0ad', lineWidth: 3 }),
      );
    }
  }, [telemetry, config, ready]);

  // Update the selected target marker and its FWHM footprint.
  useEffect(() => {
    if (!ready || !pendingOverlayRef.current) return;

    pendingOverlayRef.current.removeAll();
    if (pending) {
      const fwhm = config?.beam_fwhm_deg ?? 6.5;
      pendingOverlayRef.current.add(
        aladinModuleRef.current!.circle(pending.ra_deg, pending.dec_deg, fwhm / 2, {
          color: 'rgba(243,204,107,0.9)',
          lineWidth: 2,
        }),
      );
      pendingOverlayRef.current.add(
        aladinModuleRef.current!.circle(pending.ra_deg, pending.dec_deg, 0.04, {
          color: '#f3cc6b',
          lineWidth: 3,
        }),
      );
    }
  }, [pending, config, ready]);

  // Named target markers supplied by the backend or parent component.
  useEffect(() => {
    if (!ready || !targetCatalogRef.current) return;

    targetCatalogRef.current.removeAll();
    targetCatalogRef.current.addSources(
      overlays.filter((overlay) => overlay.kind !== 'satellite').map((overlay) =>
        aladinModuleRef.current!.source(overlay.ra_deg, overlay.dec_deg, {
          name: overlay.label,
          id: overlay.id,
          color: overlay.color,
        }),
      ),
    );
  }, [overlays, ready]);

  const fmtAltAz = (alt: number, az: number) =>
    `Az ${az.toFixed(1)}°  ·  Alt ${alt.toFixed(1)}°`;

  const pendingAltAz = pending && config
    ? raDecToAltAz(pending.ra_deg, pending.dec_deg, config, new Date())
    : null;

  // During the baseline "pick" step the Continue button is gated on where the
  // dish is *actually* pointed (live telemetry), not the clicked target — the
  // user slews the real telescope onto a quiet patch and we validate that
  // position against the same overlays drawn on the map (Milky Way band, sun
  // exclusion, pointing limits / horizon). Recomputed each telemetry tick.
  // null = no position yet (can't validate, button stays disabled).
  const baselineValidity = galacticRestrict && config
    && telemetry?.altitude_deg != null && telemetry?.azimuth_deg != null
    ? validateBaselinePointing(
        { altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg },
        config, new Date(),
      )
    : null;

  const handleSolarHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (!tooltipsEnabled) { setHoverTooltip(null); return; }

    // Prefer the smallest ring under the cursor so the pending target wins
    // when it overlaps the (larger) solar exclusion zone.
    const candidates: { kind: 'sun' | 'beam' | 'pending' | 'satellite'; r: number; fwhm?: number; label?: string }[] = [];
    for (const satellite of satelliteZoneRef.current) {
      if (Math.hypot(mx - satellite.cx, my - satellite.cy) < satellite.r) {
        candidates.push({ kind: 'satellite', r: satellite.r, label: satellite.overlay.label });
      }
    }
    const beam = beamZoneRef.current;
    if (beam && Math.hypot(mx - beam.cx, my - beam.cy) < beam.r) {
      candidates.push({ kind: 'beam', r: beam.r, fwhm: beam.fwhm });
    }
    const pend = pendingZoneRef.current;
    if (pend && Math.hypot(mx - pend.cx, my - pend.cy) < pend.r) {
      candidates.push({ kind: 'pending', r: pend.r, fwhm: pend.fwhm });
    }
    const sun = sunZoneRef.current;
    if (sun && Math.hypot(mx - sun.cx, my - sun.cy) < sun.r) {
      candidates.push({ kind: 'sun', r: sun.r });
    }
    if (candidates.length === 0) { setHoverTooltip(null); return; }
    candidates.sort((a, b) => a.r - b.r);
    const pick = candidates[0];
    setHoverTooltip({ kind: pick.kind, x: mx, y: my, fwhm: pick.fwhm, label: pick.label });
  };

  const handleSkyMapClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!config) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const satellite = satelliteZoneRef.current.find((zone) =>
      Math.hypot(mx - zone.cx, my - zone.cy) < zone.r,
    );
    if (!satellite) return;

    e.preventDefault();
    e.stopPropagation();
    const overlay = satellite.overlay;
    const altAz = overlay.altitude_deg != null && overlay.azimuth_deg != null
      ? { altitude_deg: overlay.altitude_deg, azimuth_deg: overlay.azimuth_deg }
      : raDecToAltAz(satellite.ra_deg, satellite.dec_deg, config, new Date());
    const skyPoint = overlay.altitude_deg != null && overlay.azimuth_deg != null
      ? altAzToRaDec(altAz, config, new Date())
      : { ra_deg: satellite.ra_deg, dec_deg: satellite.dec_deg };

    onNotice(null);
    onTarget(altAz.azimuth_deg, altAz.altitude_deg, skyPoint.ra_deg, skyPoint.dec_deg);
  };

  const handleSkyMapLeave = () => {
    setHoverTooltip(null);
  };

  return (
    <div
      className={`skymap-wrapper${survey !== HYDROGEN_SURVEY_ID ? ' skymap-wrapper-explore' : ''}`}
      onMouseMove={handleSolarHover}
      onMouseLeave={handleSkyMapLeave}
      onClickCapture={handleSkyMapClickCapture}
    >
      <div className="skymap-aladin" ref={containerRef} />
      <canvas className="skymap-horizon-canvas" ref={horizonCanvasRef} />

      <div className="skymap-toolbar" aria-label="Sky map controls">
        {toolbarLeading}
        <div className="skymap-layer-control">
          <button
            type="button"
            className={`skymap-control-label${viewSelectorOpen ? ' active' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setViewSelectorOpen((open) => !open);
            }}
            aria-expanded={viewSelectorOpen}
            aria-controls="skymap-spectrum-selector"
            title={viewSelectorOpen ? 'Hide survey selector' : 'Show survey selector'}
          >
            <Layers size={13} />
            View
          </button>
          {viewSelectorOpen && (
            <LightSpectrumSurveySelector activeSurvey={survey} onSelectSurvey={setSurvey} disabled={!ready} />
          )}
        </div>
      </div>

      {viewSelectorOpen && (
        <div className="skymap-surveys skymap-surveys-mobile" role="group" aria-label="Sky survey">
          {SURVEYS.filter((s) => s.id === HYDROGEN_SURVEY_ID || s.id === 'CDS/P/Mellinger/color').map((s) => (
            <button
              key={s.id}
              type="button"
              className={`skymap-survey-btn${surveyToneClass(s)}${survey === s.id ? ' active' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setSurvey(s.id);
              }}
              title={s.title}
              disabled={!ready}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {(pendingAltAz || (telemetry?.altitude_deg != null && telemetry.azimuth_deg != null)) && (
        <div className="skymap-altaz-chip">
          {pendingAltAz ? (
            <span className="skymap-altaz-target">{fmtAltAz(pendingAltAz.altitude_deg, pendingAltAz.azimuth_deg)}</span>
          ) : (
            <span>{fmtAltAz(telemetry!.altitude_deg!, telemetry!.azimuth_deg!)}</span>
          )}
          {survey !== HYDROGEN_SURVEY_ID && (
            <span className="skymap-explore-badge" title="Pointing is locked on exploration surveys — switch to H I 1420 to set a target.">
              Explore only
            </span>
          )}
        </div>
      )}

      {galacticRestrict && (
        <div className="skymap-galactic-hint" role="dialog" aria-label={tourCopy.baselineWizard.pick.title}>
          <p className="skymap-galactic-hint-text">
            Point the dish at an empty patch of sky, <strong>avoiding the Milky Way and the Sun</strong> so that the baseline is clean.
          </p>
          <div className="skymap-galactic-hint-actions">
            <button
              type="button"
              className="rt-tour-btn rt-tour-btn-ghost"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new Event(BASELINE_PICK_CANCEL_EVENT));
              }}
            >
              {tourCopy.baselineWizard.pick.buttons.cancel}
            </button>
            <button
              type="button"
              className="rt-tour-btn rt-tour-btn-primary"
              disabled={!baselineValidity?.valid}
              title={baselineValidity?.valid ? undefined : 'Move the telescope to a valid spot to continue'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new Event(BASELINE_PICK_CONFIRM_EVENT));
              }}
            >
              {tourCopy.baselineWizard.pick.buttons.confirm}
            </button>
          </div>
        </div>
      )}

      {!ready && (
        <div className="skymap-loading">
          <Telescope size={24} className="skymap-loading-icon" />
          <span>Loading sky atlas</span>
        </div>
      )}

      {tooltipsEnabled && hoverTooltip && (
        <div
          className="skymap-solar-tooltip"
          style={{ left: hoverTooltip.x + 14, top: hoverTooltip.y + 14 }}
        >
          {hoverTooltip.kind === 'sun' && (
            <>
              <strong>Range of Solar Influence</strong>
              <p>Pointing within 15 deg of the Sun will likely overwhelm the hydrogen signal</p>
            </>
          )}
          {hoverTooltip.kind === 'beam' && (
            <>
              <strong>Telescope Beam (FWHM)</strong>
              <p>
                Half-power footprint at the current pointing
                {hoverTooltip.fwhm != null ? ` - ${hoverTooltip.fwhm.toFixed(2)} deg full width` : ''}.
                Sources inside this ring contribute most of the received power.
              </p>
            </>
          )}
          {hoverTooltip.kind === 'pending' && (
            <>
              <strong>Target Beam (FWHM)</strong>
              <p>
                Projected half-power footprint at the selected target
                {hoverTooltip.fwhm != null ? ` - ${hoverTooltip.fwhm.toFixed(2)} deg full width` : ''}.
              </p>
            </>
          )}
          {hoverTooltip.kind === 'satellite' && (
            <>
              <strong>{hoverTooltip.label ?? 'Satellite'}</strong>
              <p>Select satellite target</p>
            </>
          )}
        </div>
      )}

      <CameraPip />
    </div>
  );
}

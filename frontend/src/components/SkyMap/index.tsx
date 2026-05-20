import { Layers, Telescope } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { altAzToRaDec, raDecToAltAz } from '../../lib/astro';
import type { RaDecTarget, RoboClawTelemetry, SkyOverlay, TelescopeConfig } from '../../types';

import { CameraPip } from './CameraPip';
import { useAladinInit } from './aladin/useAladinInit';
import { useHorizonCanvas } from './horizon/useHorizonCanvas';
import { LightSpectrumSurveySelector } from './spectrum/SurveySelector';
import {
  HYDROGEN_SURVEY_ID,
  SURVEYS,
  type SurveyId,
  surveyToneClass,
} from './spectrum/surveys';


// ─── Component ────────────────────────────────────────────────────────────────
interface SkyMapProps {
  telemetry: RoboClawTelemetry | null;
  config: TelescopeConfig | null;
  onNotice: (msg: string | null) => void;
  onTarget: (az: number, alt: number) => void;
  onClearTarget?: () => void;
  tooltipsEnabled: boolean;
  overlays?: SkyOverlay[];
  toolbarLeading?: ReactNode;
}

export function SkyMap({ telemetry, config, onNotice, onTarget, onClearTarget, tooltipsEnabled, overlays = [], toolbarLeading }: SkyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const configRef       = useRef<TelescopeConfig | null>(null);
  const telemetryRef    = useRef<RoboClawTelemetry | null>(null);
  const pendingRef      = useRef<RaDecTarget | null>(null);
  const horizonCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const onTargetRef = useRef<((az: number, alt: number) => void) | null>(null);
  const onClearTargetRef = useRef<(() => void) | null>(null);
  // Mirrored so the init effect doesn't re-run (and tear down its event handlers)
  // every time the parent passes a fresh inline callback.
  const onNoticeRef = useRef<((msg: string | null) => void) | null>(null);
  // Latest selected survey, mirrored into a ref so the click handler (attached
  // once in the init effect) can check it without being rebuilt.
  const surveyRef = useRef<SurveyId>(HYDROGEN_SURVEY_ID);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<RaDecTarget | null>(null);
  const [survey, setSurvey] = useState<SurveyId>(HYDROGEN_SURVEY_ID);
  const [viewSelectorOpen, setViewSelectorOpen] = useState(false);
  const [cameraSwapped, setCameraSwapped] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<
    | { kind: 'sun' | 'beam' | 'pending'; x: number; y: number; fwhm?: number }
    | null
  >(null);

  useEffect(() => { configRef.current    = config;    }, [config]);
  useEffect(() => { telemetryRef.current = telemetry; }, [telemetry]);
  useEffect(() => { pendingRef.current   = pending;   }, [pending]);
  useEffect(() => { onTargetRef.current  = onTarget;  }, [onTarget]);
  useEffect(() => { onClearTargetRef.current = onClearTarget ?? null; }, [onClearTarget]);
  useEffect(() => { onNoticeRef.current  = onNotice;  }, [onNotice]);
  useEffect(() => { surveyRef.current    = survey;    }, [survey]);
  useEffect(() => {
    if (!tooltipsEnabled) setHoverTooltip(null);
  }, [tooltipsEnabled]);

  const {
    aladinRef,
    aladinModuleRef,
    beamOverlayRef,
    limitOverlayRef,
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
    setReady,
    setPending,
    setHoverTooltip,
  });

  // Change survey
  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (survey === HYDROGEN_SURVEY_ID) {
      aladinRef.current.setImageLayer(
        aladinModuleRef.current!.imageHiPS('CDS/P/HI4PI/NHI', {
          name: 'HI4PI colorized hydrogen line',
          colormap: 'inferno',
          stretch: 'asinh',
        }),
      );
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

  const { sunZoneRef, beamZoneRef, pendingZoneRef } = useHorizonCanvas({
    ready,
    config,
    containerRef,
    canvasRef: horizonCanvasRef,
    aladinRef,
    configRef,
    telemetryRef,
    pendingRef,
  });

  // Project the fixed Alt/Az pointing-limit triangle onto the current sky.
  useEffect(() => {
    if (!ready || !limitOverlayRef.current) return;

    limitOverlayRef.current.removeAll();
    if (config && config.pointing_limit_altaz.length === 3) {
      const date = telemetry?.timestamp != null
        ? new Date(telemetry.timestamp * 1000)
        : new Date();
      const vertices = config.pointing_limit_altaz.map((point) => altAzToRaDec(point, config, date));
      const polyline = vertices.map((point): [number, number] => [point.ra_deg, point.dec_deg]);
      limitOverlayRef.current.add(
        aladinModuleRef.current!.polyline([...polyline, polyline[0]], {
          color: 'rgba(255,126,89,0.9)',
          lineWidth: 2,
        }),
      );
      vertices.forEach((point) => {
        limitOverlayRef.current?.add(
          aladinModuleRef.current!.circle(point.ra_deg, point.dec_deg, 0.08, {
            color: '#ff7e59',
            lineWidth: 2,
          }),
        );
      });
    }
  }, [config, ready, telemetry?.timestamp]);

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
      overlays.map((overlay) =>
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

  const handleSolarHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (!tooltipsEnabled) { setHoverTooltip(null); return; }

    // Prefer the smallest ring under the cursor so the pending target wins
    // when it overlaps the (larger) solar exclusion zone.
    const candidates: { kind: 'sun' | 'beam' | 'pending'; r: number; fwhm?: number }[] = [];
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
    setHoverTooltip({ kind: pick.kind, x: mx, y: my, fwhm: pick.fwhm });
  };

  const handleSkyMapLeave = () => {
    setHoverTooltip(null);
  };

  return (
    <div
      className={`skymap-wrapper${cameraSwapped ? ' skymap-wrapper-swapped' : ''}${
        survey !== HYDROGEN_SURVEY_ID ? ' skymap-wrapper-explore' : ''
      }`}
      onMouseMove={handleSolarHover}
      onMouseLeave={handleSkyMapLeave}
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
          {SURVEYS.filter((s) => s.id === HYDROGEN_SURVEY_ID || s.id === 'CDS/P/DSS2/color').map((s) => (
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
        </div>
      )}

      <CameraPip swapped={cameraSwapped} onToggleSwap={() => setCameraSwapped((v) => !v)} />
    </div>
  );
}

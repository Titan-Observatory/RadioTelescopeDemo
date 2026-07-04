import { type RefObject, useEffect, useRef } from 'react';

import type { RaDecTarget, RoboClawTelemetry, SkyOverlay, TelescopeConfig } from '../../../types';
import { HYDROGEN_SURVEY_ID, type SurveyId } from '../spectrum/surveys';
import {
  type AladinInstance,
  type FrameState,
  type Layer,
  EMPTY_SAFE_WINDOW,
  buildAltitudeBandLoop,
  buildHorizonSamples,
  computeFwhmHoverZones,
  computeGroundIsInside,
  computeSafeWindow,
  drawAltitudeLimitOverlay,
  drawAltAzGrid,
  drawCardinals,
  drawGalacticExclusion,
  drawGround,
  drawHorizonLine,
  drawSatelliteOverlays,
  drawSlewPath,
  drawSunAndMoon,
  projectHorizonPolygon,
  type SatelliteHoverZone,
} from './layers';


interface UseHorizonCanvasOptions {
  ready: boolean;
  config: TelescopeConfig | null;
  containerRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  aladinRef: RefObject<AladinInstance | null>;
  configRef: RefObject<TelescopeConfig | null>;
  telemetryRef: RefObject<RoboClawTelemetry | null>;
  pendingRef: RefObject<RaDecTarget | null>;
  overlaysRef: RefObject<SkyOverlay[]>;
  /** Shade the galactic-plane exclusion band (baseline wizard pick step). */
  galacticExclusionRef: RefObject<boolean>;
  /** Current sky survey — the hardware-limit shading only draws on hydrogen. */
  surveyRef: RefObject<SurveyId>;
}


// Layer pipeline — adding a new visual layer is a one-line change here plus a
// new function in layers.ts. Order is the painter's algorithm: earlier layers
// sit underneath later ones. computeFwhmHoverZones must run last so it sees
// the final pending/telemetry state for that frame.
const LAYERS: Layer[] = [
  drawGalacticExclusion,
  drawGround,
  drawAltitudeLimitOverlay,
  drawAltAzGrid,
  drawHorizonLine,
  drawCardinals,
  drawSlewPath,
  drawSunAndMoon,
  drawSatelliteOverlays,
  computeFwhmHoverZones,
];


/**
 * Drives the canvas overlay: horizon polygon, alt/az grid, cardinals, sun/moon,
 * slew path, and hover-zone publication. The hover-zone refs are owned here
 * (only the draw loop writes them) and returned for SkyMap's hit-test handler.
 */
export function useHorizonCanvas(opts: UseHorizonCanvasOptions) {
  const {
    ready,
    config,
    containerRef,
    canvasRef,
    aladinRef,
    configRef,
    telemetryRef,
    pendingRef,
    overlaysRef,
    galacticExclusionRef,
    surveyRef,
  } = opts;

  const sunZoneRef = useRef<{ cx: number; cy: number; r: number } | null>(null);
  const beamZoneRef = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);
  const pendingZoneRef = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);
  const satelliteZoneRef = useRef<SatelliteHoverZone[]>([]);

  useEffect(() => {
    if (!ready || !config) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let horizonRaDec: RaDecTarget[] = [];
    let almucantars: { altitude_deg: number; samples: RaDecTarget[] }[] = [];
    let meridians: { azimuth_deg: number; samples: RaDecTarget[] }[] = [];
    let safeWindowRaDec: RaDecTarget[] = [];
    let lastSampleTime = -Infinity;

    // Sample caching: the horizon polygon, alt/az grid, and hard-limits
    // safe-window boundary all rotate with Earth. Recompute roughly twice a
    // minute — visually indistinguishable from real-time but cheap.
    const refreshSamples = () => {
      const date = new Date();
      const samples = buildHorizonSamples(config, date);
      horizonRaDec = samples.horizonRaDec;
      almucantars  = samples.almucantars;
      meridians    = samples.meridians;
      const limits = config.hard_safety_limits;
      safeWindowRaDec = buildAltitudeBandLoop(
        config, date,
        limits.altitude_min_deg, limits.altitude_max_deg,
        limits.azimuth_min_deg, limits.azimuth_max_deg,
      );
      lastSampleTime = Date.now();
    };

    let frameId: number;
    const hoverZones = { sun: sunZoneRef, beam: beamZoneRef, pending: pendingZoneRef, satellites: satelliteZoneRef };

    // Redraw gating. The overlay only needs to repaint when something visible
    // changed: the Aladin view moved (pan/zoom/rotate), the beam/pending target
    // moved, an overlay set changed, or a mode flag flipped. Reprojecting the
    // whole grid every animation frame regardless — the old behaviour — pinned a
    // core at 60 fps even while idle and starved Aladin's own render during pans.
    // We capture a cheap signature (two projection calls vs ~1900 for a full
    // redraw) and skip when it's unchanged, except: a pending slew animates its
    // marching-ants dash (repainted at ~15 fps — the dash offset is wall-clock
    // driven, so the ant speed is unchanged), and a slow heartbeat lets the
    // sun/moon and the Earth-rotating grid catch up while the view sits still
    // (sidereal drift is ~0.04 px/s at typical zoom, so even 5 s between
    // repaints stays well under a pixel).
    let lastSig: string | null = null;
    let lastDrawTime = 0;
    const IDLE_REDRAW_MS = 5000;
    const DASH_REDRAW_MS = 66;

    const viewSignature = (aladin: AladinInstance, w: number, h: number): string => {
      // Centre catches pan; an on-screen off-centre point catches zoom (its sky
      // distance from centre changes) and rotation (it swings around centre).
      // Both stay on the projection at any reasonable view, unlike a corner.
      const c = aladin.pix2world(w / 2, h / 2);
      const e = aladin.pix2world(w / 2, h / 4);
      const fov = aladin.getFov?.();
      const t = telemetryRef.current;
      const p = pendingRef.current;
      return [
        w, h,
        c?.[0], c?.[1], e?.[0], e?.[1], fov?.[0],
        t?.altitude_deg, t?.azimuth_deg,
        p?.ra_deg, p?.dec_deg,
        overlaysRef.current?.length ?? 0,
        galacticExclusionRef.current ? 1 : 0,
        surveyRef.current,
      ].join(',');
    };

    const draw = () => {
      if (Date.now() - lastSampleTime > 30_000) refreshSamples();

      const aladin = aladinRef.current;
      if (!aladin) { frameId = requestAnimationFrame(draw); return; }

      const rect = container.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);

      // A pending slew keeps animating its dashed path, but the ants only need
      // ~15 fps; otherwise skip the heavy redraw when the signature matches and
      // the idle heartbeat hasn't elapsed. A signature change (pan/zoom, dish
      // motion, new overlays) always repaints immediately.
      const animating = !!(pendingRef.current && telemetryRef.current);
      const now = Date.now();
      const sig = viewSignature(aladin, w, h);
      if (sig === lastSig && now - lastDrawTime < (animating ? DASH_REDRAW_MS : IDLE_REDRAW_MS)) {
        frameId = requestAnimationFrame(draw);
        return;
      }
      lastSig = sig;
      lastDrawTime = now;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width  = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) { frameId = requestAnimationFrame(draw); return; }
      ctx.clearRect(0, 0, w, h);

      const horizonPx = projectHorizonPolygon(aladin, horizonRaDec);
      if (horizonPx.length < 4) { frameId = requestAnimationFrame(draw); return; }

      const date = new Date();
      const cfg = configRef.current ?? config;
      const groundIsInside = computeGroundIsInside(aladin, cfg, date, horizonPx);

      // Project the hard-limits safe window once and share it with both layers
      // that clip to it. Skipped entirely on exploration surveys, where neither
      // the limit shading nor the galactic band draws.
      const galacticExclusion = galacticExclusionRef.current ?? false;
      const showHardwareLimits = (surveyRef.current ?? HYDROGEN_SURVEY_ID) === HYDROGEN_SURVEY_ID;
      const safeWindow = galacticExclusion || showHardwareLimits
        ? computeSafeWindow(aladin, cfg, date, safeWindowRaDec, w, h)
        : EMPTY_SAFE_WINDOW;

      // Reset zones each frame; drawSunAndMoon + computeFwhmHoverZones re-populate.
      sunZoneRef.current = null;
      beamZoneRef.current = null;
      pendingZoneRef.current = null;
      satelliteZoneRef.current = [];

      const state: FrameState = {
        ctx,
        aladin,
        date,
        w, h,
        config: cfg,
        telemetry: telemetryRef.current,
        pending: pendingRef.current,
        overlays: overlaysRef.current,
        fwhmDeg: configRef.current?.beam_fwhm_deg ?? 6.5,
        horizonPx,
        almucantars,
        meridians,
        groundIsInside,
        hoverZones,
        safeWindow,
        galacticExclusion,
        showHardwareLimits,
      };

      for (const layer of LAYERS) layer(state);

      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [ready, config]);

  return { sunZoneRef, beamZoneRef, pendingZoneRef, satelliteZoneRef };
}

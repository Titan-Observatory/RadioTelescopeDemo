import { type RefObject, useEffect, useRef } from 'react';

import type { RaDecTarget, RoboClawTelemetry, TelescopeConfig } from '../../../types';
import {
  type AladinInstance,
  type FrameState,
  type Layer,
  buildHorizonSamples,
  computeFwhmHoverZones,
  computeGroundIsInside,
  drawAltAzGrid,
  drawCardinals,
  drawGround,
  drawHorizonLine,
  drawSlewPath,
  drawSunAndMoon,
  projectHorizonPolygon,
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
}


// Layer pipeline — adding a new visual layer is a one-line change here plus a
// new function in layers.ts. Order is the painter's algorithm: earlier layers
// sit underneath later ones. computeFwhmHoverZones must run last so it sees
// the final pending/telemetry state for that frame.
const LAYERS: Layer[] = [
  drawGround,
  drawAltAzGrid,
  drawHorizonLine,
  drawCardinals,
  drawSlewPath,
  drawSunAndMoon,
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
  } = opts;

  const sunZoneRef = useRef<{ cx: number; cy: number; r: number } | null>(null);
  const beamZoneRef = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);
  const pendingZoneRef = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);

  useEffect(() => {
    if (!ready || !config) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    let horizonRaDec: RaDecTarget[] = [];
    let almucantars: { altitude_deg: number; samples: RaDecTarget[] }[] = [];
    let meridians: { azimuth_deg: number; samples: RaDecTarget[] }[] = [];
    let lastSampleTime = -Infinity;

    // Sample caching: the horizon polygon + alt/az grid rotate with Earth.
    // Recompute roughly twice a minute — visually indistinguishable from real-time
    // but cheap.
    const refreshSamples = () => {
      const samples = buildHorizonSamples(config, new Date());
      horizonRaDec = samples.horizonRaDec;
      almucantars  = samples.almucantars;
      meridians    = samples.meridians;
      lastSampleTime = Date.now();
    };

    let frameId: number;
    const dashOffset = { current: 0 };
    const hoverZones = { sun: sunZoneRef, beam: beamZoneRef, pending: pendingZoneRef };

    const draw = () => {
      if (Date.now() - lastSampleTime > 30_000) refreshSamples();

      const aladin = aladinRef.current;
      if (!aladin) { frameId = requestAnimationFrame(draw); return; }

      const rect = container.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
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

      // Reset zones each frame; drawSunAndMoon + computeFwhmHoverZones re-populate.
      sunZoneRef.current = null;
      beamZoneRef.current = null;
      pendingZoneRef.current = null;

      const state: FrameState = {
        ctx,
        aladin,
        date,
        w, h,
        config: cfg,
        telemetry: telemetryRef.current,
        pending: pendingRef.current,
        fwhmDeg: configRef.current?.beam_fwhm_deg ?? 6.5,
        horizonPx,
        almucantars,
        meridians,
        groundIsInside,
        hoverZones,
        dashOffset,
      };

      for (const layer of LAYERS) layer(state);

      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [ready, config]);

  return { sunZoneRef, beamZoneRef, pendingZoneRef };
}

import type A from 'aladin-lite';
import type { MutableRefObject } from 'react';

import {
  DEG2RAD,
  GALACTIC_PLANE_EXCLUSION_DEG,
  SUN_EXCLUSION_DEG,
  altAzToRaDec,
  galacticToRaDec,
  moonIllumination,
  moonRaDec,
  raDecToAltAz,
  raDecToGalactic,
  sunRaDec,
} from '../../../lib/astro';
import type { RaDecTarget, RoboClawTelemetry, SkyOverlay, TelescopeConfig } from '../../../types';
import { drawMoonIcon, drawSatelliteIcon, drawSunIcon, pointInPolygon } from './icons';


export type AladinInstance = ReturnType<typeof A.aladin>;

export type HoverZone = { cx: number; cy: number; r: number; fwhm?: number };
export type SatelliteHoverZone = HoverZone & {
  overlay: SkyOverlay;
  ra_deg: number;
  dec_deg: number;
};

export interface HoverZoneRefs {
  sun: MutableRefObject<{ cx: number; cy: number; r: number } | null>;
  beam: MutableRefObject<{ cx: number; cy: number; r: number; fwhm: number } | null>;
  pending: MutableRefObject<{ cx: number; cy: number; r: number; fwhm: number } | null>;
  satellites: MutableRefObject<SatelliteHoverZone[]>;
}

/**
 * Snapshot of everything a layer function needs for one frame.
 *
 * Each layer is `(state: FrameState) => void`; layers run in sequence from the
 * draw loop, so adding (say) a panorama background or a planet overlay is a
 * matter of writing one new layer function and inserting it in the sequence.
 *
 * Mutable fields:
 *  - `hoverZones`  — populated by drawSunAndMoon (sun) + computeFwhmHoverZones
 */
export interface FrameState {
  ctx: CanvasRenderingContext2D;
  aladin: AladinInstance;
  date: Date;
  w: number;
  h: number;
  config: TelescopeConfig;
  telemetry: RoboClawTelemetry | null;
  pending: RaDecTarget | null;
  overlays: SkyOverlay[];
  fwhmDeg: number;
  horizonPx: [number, number][];
  almucantars: { altitude_deg: number; samples: RaDecTarget[] }[];
  meridians: { azimuth_deg: number; samples: RaDecTarget[] }[];
  groundIsInside: boolean;
  hoverZones: HoverZoneRefs;
  /**
   * The hard-limits safe window projected once per frame — shared by
   * drawAltitudeLimitOverlay and drawGalacticExclusion so neither re-projects
   * the boundary loop itself.
   */
  safeWindow: SafeWindow;
  /** When true, shade the galactic-plane band the baseline wizard excludes. */
  galacticExclusion: boolean;
  /**
   * False on exploration surveys (anything but the hydrogen line), where the
   * pointing is locked and the hardware-limit shading is just clutter.
   */
  showHardwareLimits: boolean;
}


export type Layer = (state: FrameState) => void;


// ─── Sample caching (horizon polygon + alt/az grid) ──────────────────────────

const ALT_RINGS = [15, 30, 45, 60, 75];
const AZ_LINES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

export function buildHorizonSamples(config: TelescopeConfig, date: Date): {
  horizonRaDec: RaDecTarget[];
  almucantars: { altitude_deg: number; samples: RaDecTarget[] }[];
  meridians: { azimuth_deg: number; samples: RaDecTarget[] }[];
} {
  const horizonRaDec: RaDecTarget[] = [];
  for (let az = 0; az < 360; az += 2) {
    horizonRaDec.push(altAzToRaDec({ altitude_deg: 0, azimuth_deg: az }, config, date));
  }
  const almucantars = ALT_RINGS.map((alt) => {
    const samples: RaDecTarget[] = [];
    for (let az = 0; az < 360; az += 4) {
      samples.push(altAzToRaDec({ altitude_deg: alt, azimuth_deg: az }, config, date));
    }
    return { altitude_deg: alt, samples };
  });
  const meridians = AZ_LINES.map((az) => {
    const samples: RaDecTarget[] = [];
    for (let alt = 0; alt <= 88; alt += 2) {
      samples.push(altAzToRaDec({ altitude_deg: alt, azimuth_deg: az }, config, date));
    }
    return { azimuth_deg: az, samples };
  });
  return { horizonRaDec, almucantars, meridians };
}


export function projectHorizonPolygon(aladin: AladinInstance, horizonRaDec: RaDecTarget[]): [number, number][] {
  const px: [number, number][] = [];
  for (const { ra_deg, dec_deg } of horizonRaDec) {
    const p = aladin.world2pix(ra_deg, dec_deg);
    if (p && isFinite(p[0]) && isFinite(p[1])) px.push([p[0], p[1]]);
  }
  return px;
}


/**
 * Probe a point well below the horizon to decide which side of the
 * polygon is "ground". When the view rotates / pans so the projection
 * centre is below the horizon, the polygon's *interior* in screen space
 * becomes the ground; otherwise the *exterior* is ground.
 */
export function computeGroundIsInside(
  aladin: AladinInstance,
  config: TelescopeConfig,
  date: Date,
  horizonPx: [number, number][],
): boolean {
  for (const probeAz of [180, 0, 90, 270]) {
    const probe = altAzToRaDec({ altitude_deg: -45, azimuth_deg: probeAz }, config, date);
    const pp = aladin.world2pix(probe.ra_deg, probe.dec_deg);
    if (pp && isFinite(pp[0]) && isFinite(pp[1])) {
      return pointInPolygon(pp[0], pp[1], horizonPx);
    }
  }
  return false;
}


// ─── Drawing primitives ──────────────────────────────────────────────────────

// Project a run of sky samples to pixels once. Returns null for any sample that
// is unprojectable (off the projection / non-finite), so callers can both stroke
// the polyline and reuse the same pixels (e.g. for label placement) without
// paying for world2pix — the JS↔WASM boundary call — twice.
type ProjectedPoint = [number, number] | null;

function projectSamples(aladin: AladinInstance, samples: RaDecTarget[]): ProjectedPoint[] {
  const out: ProjectedPoint[] = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const p = aladin.world2pix(samples[i].ra_deg, samples[i].dec_deg);
    out[i] = p && isFinite(p[0]) && isFinite(p[1]) ? [p[0], p[1]] : null;
  }
  return out;
}

function strokeProjectedPoints(
  ctx: CanvasRenderingContext2D,
  points: ProjectedPoint[],
  wrap: boolean,
  w: number,
  h: number,
): void {
  // Split into segments wherever:
  //  (a) a sample is off-screen / unprojectable, or
  //  (b) two consecutive samples are absurdly far apart in pixels (the
  //      projection wrapped behind us — connecting them would streak).
  const margin = 40;
  const maxSegmentPx = Math.max(w, h);
  let prev: [number, number] | null = null;
  let firstOnscreen: [number, number] | null = null;
  ctx.beginPath();
  for (const point of points) {
    const offscreen = !point ||
      point[0] < -margin || point[0] > w + margin || point[1] < -margin || point[1] > h + margin;
    if (offscreen) { prev = null; continue; }
    if (prev == null || Math.hypot(point[0] - prev[0], point[1] - prev[1]) > maxSegmentPx) {
      ctx.moveTo(point[0], point[1]);
      if (firstOnscreen == null) firstOnscreen = point;
    } else {
      ctx.lineTo(point[0], point[1]);
    }
    prev = point;
  }
  // For closed shapes, only connect the last point back to the first if the
  // whole loop stayed on-screen (single sub-path) and the closing chord is short.
  if (wrap && prev && firstOnscreen &&
      Math.hypot(prev[0] - firstOnscreen[0], prev[1] - firstOnscreen[1]) < maxSegmentPx) {
    ctx.lineTo(firstOnscreen[0], firstOnscreen[1]);
  }
  ctx.stroke();
}

function drawProjectedPolyline(
  ctx: CanvasRenderingContext2D,
  aladin: AladinInstance,
  samples: RaDecTarget[],
  wrap: boolean,
  w: number,
  h: number,
): void {
  strokeProjectedPoints(ctx, projectSamples(aladin, samples), wrap, w, h);
}


// ─── Layers ──────────────────────────────────────────────────────────────────
// To swap in a real panorama, replace the fillStyle block in drawGround with
// ctx.drawImage(panoramaImg, …) mapped to the same clipping polygon.

function buildAltitudeBoundary(
  config: TelescopeConfig,
  date: Date,
  altitudeDeg: number,
  minAzDeg: number,
  maxAzDeg: number,
  stepDeg = 3,
): RaDecTarget[] {
  const samples: RaDecTarget[] = [];
  for (let az = minAzDeg; az < maxAzDeg; az += stepDeg) {
    samples.push(altAzToRaDec({ altitude_deg: altitudeDeg, azimuth_deg: az }, config, date));
  }
  samples.push(altAzToRaDec({ altitude_deg: altitudeDeg, azimuth_deg: maxAzDeg }, config, date));
  return samples;
}

function buildAzimuthBoundary(
  config: TelescopeConfig,
  date: Date,
  azimuthDeg: number,
  minAltDeg: number,
  maxAltDeg: number,
  stepDeg = 2,
): RaDecTarget[] {
  const samples: RaDecTarget[] = [];
  for (let alt = minAltDeg; alt < maxAltDeg; alt += stepDeg) {
    samples.push(altAzToRaDec({ altitude_deg: alt, azimuth_deg: azimuthDeg }, config, date));
  }
  samples.push(altAzToRaDec({ altitude_deg: maxAltDeg, azimuth_deg: azimuthDeg }, config, date));
  return samples;
}

/**
 * The full safe-window boundary as one closed loop, walked clockwise:
 * alt_max (az ascending) → az_max (alt descending) → alt_min (az descending)
 * → az_min (alt ascending). Built from the same per-edge samplers the boundary
 * *strokes* use, so the filled region's edge is identical to the stroked curve —
 * no chord-vs-curve gap between the hatch and the outline.
 *
 * Exported so useHorizonCanvas can cache the RA/Dec samples alongside the
 * horizon/grid samples (they drift with Earth rotation at the same rate)
 * instead of rebuilding them every frame.
 */
export function buildAltitudeBandLoop(
  config: TelescopeConfig,
  date: Date,
  minAltDeg: number,
  maxAltDeg: number,
  minAzDeg: number,
  maxAzDeg: number,
): RaDecTarget[] {
  const top = buildAltitudeBoundary(config, date, maxAltDeg, minAzDeg, maxAzDeg);
  const right = buildAzimuthBoundary(config, date, maxAzDeg, minAltDeg, maxAltDeg).reverse();
  const bottom = buildAltitudeBoundary(config, date, minAltDeg, minAzDeg, maxAzDeg).reverse();
  const left = buildAzimuthBoundary(config, date, minAzDeg, minAltDeg, maxAltDeg);
  return [...top, ...right, ...bottom, ...left];
}

/**
 * The safe window projected to screen space for one frame. `ok` is false when
 * any loop vertex is unprojectable or blew up (the window is partly behind us),
 * in which case `quads` carries the per-quad fallback tiling (empty otherwise).
 * Used both to fill/stroke the altitude-limit overlay and to clip the galactic
 * band, so the band's edge tracks the same smooth curve as the safe-window
 * outline. Computed once per frame in useHorizonCanvas and shared via
 * FrameState so the two layers don't project the boundary twice.
 */
export interface SafeWindow {
  loopPx: [number, number][];
  ok: boolean;
  quads: [number, number][][];
}

export const EMPTY_SAFE_WINDOW: SafeWindow = { loopPx: [], ok: false, quads: [] };

export function computeSafeWindow(
  aladin: AladinInstance,
  config: TelescopeConfig,
  date: Date,
  loopSamples: RaDecTarget[],
  w: number,
  h: number,
): SafeWindow {
  const maxCoord = 50 * Math.max(w, h);
  const loopPx: [number, number][] = [];
  let ok = true;
  for (const { ra_deg, dec_deg } of loopSamples) {
    const p = aladin.world2pix(ra_deg, dec_deg);
    if (!p || !isFinite(p[0]) || !isFinite(p[1]) || Math.abs(p[0]) > maxCoord || Math.abs(p[1]) > maxCoord) {
      ok = false;
      break;
    }
    loopPx.push([p[0], p[1]]);
  }
  if (loopPx.length < 3) ok = false;
  if (ok) return { loopPx, ok, quads: [] };

  const limits = config.hard_safety_limits;
  const quads = buildAltitudeBandQuads(
    aladin, config, date,
    limits.altitude_min_deg, limits.altitude_max_deg,
    limits.azimuth_min_deg, limits.azimuth_max_deg,
    w, h,
  );
  return { loopPx, ok, quads };
}

function buildAltitudeBandQuads(
  aladin: AladinInstance,
  config: TelescopeConfig,
  date: Date,
  minAltDeg: number,
  maxAltDeg: number,
  minAzDeg: number,
  maxAzDeg: number,
  w: number,
  h: number,
): [number, number][][] {
  const maxCoord = 50 * Math.max(w, h);
  const project = (altitude_deg: number, azimuth_deg: number): [number, number] | null => {
    const { ra_deg, dec_deg } = altAzToRaDec({ altitude_deg, azimuth_deg }, config, date);
    const p = aladin.world2pix(ra_deg, dec_deg);
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
    if (Math.abs(p[0]) > maxCoord || Math.abs(p[1]) > maxCoord) return null;
    return [p[0], p[1]];
  };

  const overlapsScreen = (quad: [number, number][]) =>
    Math.max(...quad.map(([x]) => x)) >= 0 &&
    Math.min(...quad.map(([x]) => x)) <= w &&
    Math.max(...quad.map(([, y]) => y)) >= 0 &&
    Math.min(...quad.map(([, y]) => y)) <= h;

  const quads: [number, number][][] = [];
  let prevMin = project(minAltDeg, minAzDeg);
  let prevMax = project(maxAltDeg, minAzDeg);
  for (let az = minAzDeg + 3; az <= maxAzDeg; az += 3) {
    const nextAz = Math.min(az, maxAzDeg);
    const min = project(minAltDeg, nextAz);
    const max = project(maxAltDeg, nextAz);
    if (prevMin && prevMax && min && max) {
      const quad = [prevMin, min, max, prevMax];
      if (overlapsScreen(quad)) quads.push(quad);
    }
    prevMin = min;
    prevMax = max;
  }
  return quads;
}

let altitudeUnavailablePattern: CanvasPattern | null = null;
let altitudeUnavailablePatternCtx: CanvasRenderingContext2D | null = null;
function altitudeLimitPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (altitudeUnavailablePattern && altitudeUnavailablePatternCtx === ctx) return altitudeUnavailablePattern;
  const size = 14;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const tctx = tile.getContext('2d');
  if (!tctx) return null;
  tctx.strokeStyle = 'rgba(220, 228, 236, 0.24)';
  tctx.lineWidth = 1.2;
  tctx.lineCap = 'square';
  tctx.beginPath();
  tctx.moveTo(-2, size + 2);
  tctx.lineTo(size + 2, -2);
  tctx.stroke();
  altitudeUnavailablePattern = ctx.createPattern(tile, 'repeat');
  altitudeUnavailablePatternCtx = ctx;
  return altitudeUnavailablePattern;
}

export const drawAltitudeLimitOverlay: Layer = ({
  ctx,
  aladin,
  w,
  h,
  config,
  date,
  horizonPx,
  groundIsInside,
  safeWindow,
  showHardwareLimits,
}) => {
  if (!showHardwareLimits) return;
  const limits = config.hard_safety_limits;

  // The boundary as a single closed loop, projected once per frame upstream.
  // When every vertex projects cleanly (the common case: the window is in
  // front of us) we fill and stroke from this one path, so the hatch edge and
  // the outline are pixel-identical.
  const { loopPx, ok: loopOk, quads } = safeWindow;

  ctx.save();
  ctx.beginPath();
  if (groundIsInside) ctx.rect(0, 0, w, h);
  ctx.moveTo(horizonPx[0][0], horizonPx[0][1]);
  for (const [x, y] of horizonPx.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.clip(groundIsInside ? 'evenodd' : 'nonzero');

  // Fill everything outside the safe window (rect minus window, evenodd).
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  if (loopOk) {
    ctx.moveTo(loopPx[0][0], loopPx[0][1]);
    for (const [x, y] of loopPx.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
  } else {
    // Fallback: the window is partly behind the projection, where the loop
    // would streak. Tile it from independent quads (slight chord error here,
    // but the region is off-screen or clipped, so it doesn't read).
    for (const quad of quads) {
      ctx.moveTo(quad[0][0], quad[0][1]);
      for (const [x, y] of quad.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
    }
  }
  ctx.fillStyle = 'rgba(3, 6, 10, 0.22)';
  ctx.fill('evenodd');

  const hatch = altitudeLimitPattern(ctx);
  if (hatch) {
    ctx.fillStyle = hatch;
    ctx.fill('evenodd');
  }

  ctx.strokeStyle = 'rgba(232, 238, 244, 0.62)';
  ctx.lineWidth = 1.35;
  if (loopOk) {
    // Stroke the same loop the fill used — guaranteed to track the hatch edge.
    ctx.beginPath();
    ctx.moveTo(loopPx[0][0], loopPx[0][1]);
    for (const [x, y] of loopPx.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.stroke();
  } else {
    for (const alt of [limits.altitude_min_deg, limits.altitude_max_deg]) {
      drawProjectedPolyline(
        ctx,
        aladin,
        buildAltitudeBoundary(config, date, alt, limits.azimuth_min_deg, limits.azimuth_max_deg),
        false,
        w,
        h,
      );
    }
    for (const az of [limits.azimuth_min_deg, limits.azimuth_max_deg]) {
      drawProjectedPolyline(
        ctx,
        aladin,
        buildAzimuthBoundary(config, date, az, limits.altitude_min_deg, limits.altitude_max_deg),
        false,
        w,
        h,
      );
    }
  }
  ctx.restore();
};

export const drawGround: Layer = ({ ctx, w, h, horizonPx, groundIsInside }) => {
  ctx.beginPath();
  if (!groundIsInside) {
    // Fill area outside polygon (default: looking at the sky from above).
    ctx.rect(0, 0, w, h);
  }
  ctx.moveTo(horizonPx[0][0], horizonPx[0][1]);
  for (const [x, y] of horizonPx.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(18, 38, 14, 0.94)';
  ctx.fill('evenodd');
};


export const drawAltAzGrid: Layer = ({ ctx, aladin, w, h, almucantars, meridians }) => {
  ctx.save();
  ctx.strokeStyle = 'rgba(114, 224, 173, 0.28)';
  ctx.lineWidth = 1;
  // Project each almucantar once and reuse the pixels for the stroke *and* the
  // altitude-label placement below (the same trick the meridians use), so the
  // labels can ride the ring to wherever it crosses the left edge.
  const almucantarPx = almucantars.map((ring) => projectSamples(aladin, ring.samples));
  for (const points of almucantarPx) {
    strokeProjectedPoints(ctx, points, true, w, h);
  }
  // Project each meridian once and reuse the pixels for the stroke *and* the
  // azimuth-label placement below — projecting was the single biggest per-frame
  // cost in this overlay, and the label pass used to re-project every sample.
  const meridianPx = meridians.map((meridian) => projectSamples(aladin, meridian.samples));
  for (const points of meridianPx) {
    strokeProjectedPoints(ctx, points, false, w, h);
  }

  // Azimuth labels — pinned to the top edge, sliding along each meridian
  // as the user pans so the bearing of every visible line stays readable.
  const AZ_LABEL_Y = 18;
  const maxSegmentPx = Math.max(w, h);
  ctx.font         = '11px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth    = 3;
  for (let m = 0; m < meridians.length; m++) {
    const meridian = meridians[m];
    let prev: [number, number] | null = null;
    let labelX: number | null = null;
    for (const point of meridianPx[m]) {
      if (!point) { prev = null; continue; }
      if (prev) {
        const [x0, y0] = prev;
        const [x1, y1] = point;
        const straddles = (y0 - AZ_LABEL_Y) * (y1 - AZ_LABEL_Y) <= 0;
        const continuous = Math.hypot(x1 - x0, y1 - y0) < maxSegmentPx;
        if (straddles && continuous && y0 !== y1) {
          const t = (AZ_LABEL_Y - y0) / (y1 - y0);
          const x = x0 + t * (x1 - x0);
          if (x >= 0 && x <= w) { labelX = x; break; }
        }
      }
      prev = point;
    }
    if (labelX != null) {
      const label = `+${Math.round(meridian.azimuth_deg).toString().padStart(3, '0')}°`;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.strokeText(label, labelX, AZ_LABEL_Y);
      ctx.fillStyle = 'rgba(114, 224, 173, 0.85)';
      ctx.fillText(label, labelX, AZ_LABEL_Y);
    }
  }

  // Altitude labels — pinned to both side edges, sliding along each almucantar
  // as the user pans so every visible ring's altitude stays readable. Mirrors
  // the azimuth labels above (which ride the top edge along each meridian).
  const ALT_LABEL_X = 22;

  // All on-screen y's where this ring crosses the vertical line at x = edgeX.
  // A ring crosses a given vertical line at most twice (upper + lower arc).
  const ringEdgeCrossings = (points: ProjectedPoint[], edgeX: number): number[] => {
    const ys: number[] = [];
    let prev: [number, number] | null = null;
    for (const point of points) {
      if (!point) { prev = null; continue; }
      if (prev) {
        const [x0, y0] = prev;
        const [x1, y1] = point;
        const straddles = (x0 - edgeX) * (x1 - edgeX) <= 0;
        const continuous = Math.hypot(x1 - x0, y1 - y0) < maxSegmentPx;
        if (straddles && continuous && x0 !== x1) {
          const t = (edgeX - x0) / (x1 - x0);
          const y = y0 + t * (y1 - y0);
          if (y >= 0 && y <= h) ys.push(y);
        }
      }
      prev = point;
    }
    return ys;
  };

  // All on-screen x's where this ring crosses the horizontal line at y = lineY.
  // A ring clipped at the top crosses it twice (its left + right rising tips),
  // so we label both, the same way the azimuth labels ride the top edge.
  const ringPinXs = (points: ProjectedPoint[], lineY: number): number[] => {
    const xs: number[] = [];
    let prev: [number, number] | null = null;
    for (const point of points) {
      if (!point) { prev = null; continue; }
      if (prev) {
        const [x0, y0] = prev;
        const [x1, y1] = point;
        const straddles = (y0 - lineY) * (y1 - lineY) <= 0;
        const continuous = Math.hypot(x1 - x0, y1 - y0) < maxSegmentPx;
        if (straddles && continuous && y0 !== y1) {
          const t = (lineY - y0) / (y1 - y0);
          const x = x0 + t * (x1 - x0);
          if (x >= 0 && x <= w) xs.push(x);
        }
      }
      prev = point;
    }
    return xs;
  };

  const drawAltLabel = (text: string, x: number, y: number, align: CanvasTextAlign) => {
    ctx.textAlign = align;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = 'rgba(114, 224, 173, 0.85)';
    ctx.fillText(text, x, y);
  };

  ctx.font         = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineWidth    = 3;
  for (let a = 0; a < almucantars.length; a++) {
    const label = `${almucantars[a].altitude_deg}°`;
    const leftYs  = ringEdgeCrossings(almucantarPx[a], ALT_LABEL_X);
    const rightYs = ringEdgeCrossings(almucantarPx[a], w - ALT_LABEL_X);
    if (leftYs.length)  drawAltLabel(label, ALT_LABEL_X, leftYs[0], 'left');
    if (rightYs.length) drawAltLabel(label, w - ALT_LABEL_X, rightYs[0], 'right');

    // Rings that don't reach either side edge: pin the label to the top, like
    // the azimuth labels. If the ring's top is clipped off-screen it crosses a
    // near-top horizontal line — ride that crossing (azimuth-style). Otherwise
    // the whole ring is on-screen, so anchor to the top of its centre-line arc.
    if (!leftYs.length && !rightYs.length) {
      const ALT_TOP_PIN_Y = 38;
      const topXs = ringPinXs(almucantarPx[a], ALT_TOP_PIN_Y);
      if (topXs.length) {
        for (const topX of topXs) drawAltLabel(label, topX, ALT_TOP_PIN_Y, 'center');
      } else {
        const centreYs = ringEdgeCrossings(almucantarPx[a], w / 2);
        if (centreYs.length) {
          drawAltLabel(label, w / 2, Math.max(10, Math.min(...centreYs) - 7), 'center');
        }
      }
    }
  }
  ctx.restore();
};


export const drawHorizonLine: Layer = ({ ctx, horizonPx }) => {
  ctx.beginPath();
  ctx.moveTo(horizonPx[0][0], horizonPx[0][1]);
  for (const [x, y] of horizonPx.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255, 126, 89, 0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
};


// ─── Galactic-plane exclusion band ───────────────────────────────────────────
// During the baseline wizard's "pick a quiet patch" step we shade the strip of
// sky within ±GALACTIC_PLANE_EXCLUSION_DEG of the galactic plane, where diffuse
// Milky Way H I would contaminate the bandpass reference. The band is filled as
// quads between the two constant-latitude curves (b = ±limit). Sampling is
// localised to the visible sky and the step scales with the field of view, so
// the band stays correct (and the sample count bounded) at any zoom — a fixed
// global step instead leaves it undersampled when zoomed in.
const GAL_MAX_QUADS = 400;

// A diagonal red hatch, built once into a small repeating tile. The main
// diagonal plus the two corner stubs make the stripes wrap seamlessly across
// tile boundaries, so the pattern reads as continuous when it fills the band.
// Cached per CanvasRenderingContext2D since createPattern is context-bound.
let stripePattern: CanvasPattern | null = null;
let stripePatternCtx: CanvasRenderingContext2D | null = null;
function galacticStripePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (stripePattern && stripePatternCtx === ctx) return stripePattern;
  const size = 9;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const tctx = tile.getContext('2d');
  if (!tctx) return null;
  tctx.strokeStyle = 'rgba(255, 72, 56, 0.55)';
  tctx.lineWidth = 2.5;
  tctx.lineCap = 'square';
  tctx.beginPath();
  tctx.moveTo(0, size);
  tctx.lineTo(size, 0);
  tctx.moveTo(-1, 1);
  tctx.lineTo(1, -1);
  tctx.moveTo(size - 1, size + 1);
  tctx.lineTo(size + 1, size - 1);
  tctx.stroke();
  stripePattern = ctx.createPattern(tile, 'repeat');
  stripePatternCtx = ctx;
  return stripePattern;
}

export const drawGalacticExclusion: Layer = ({ ctx, aladin, w, h, safeWindow, galacticExclusion }) => {
  if (!galacticExclusion) return;

  const L = GALACTIC_PLANE_EXCLUSION_DEG;
  const maxCoord = 50 * Math.max(w, h); // reject points the projection blew up
  const project = (l: number, b: number): [number, number] | null => {
    const { ra_deg, dec_deg } = galacticToRaDec(l, b);
    const p = aladin.world2pix(ra_deg, dec_deg);
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) return null;
    if (Math.abs(p[0]) > maxCoord || Math.abs(p[1]) > maxCoord) return null;
    return [p[0], p[1]];
  };

  // Localise the galactic-longitude window to what the current view can show.
  const fov = aladin.getFov();
  const fovX = fov && isFinite(fov[0]) ? fov[0] : 80;
  const fovY = fov && isFinite(fov[1]) ? fov[1] : fovX;
  const screenRadiusDeg = 0.5 * Math.hypot(fovX, fovY);
  let lStart = 0;
  let lEnd = 360;
  const center = aladin.pix2world(w / 2, h / 2);
  if (center && isFinite(center[0]) && isFinite(center[1])) {
    const g = raDecToGalactic(center[0], center[1]);
    // If the band is entirely outside the field there's nothing to draw.
    if (Math.abs(g.b_deg) - L > screenRadiusDeg + 8) return;
    // Longitude is compressed by cos(b); widen the window to compensate, capped
    // at a full hemisphere on either side (≥ that and we just sample globally).
    const cosB = Math.max(Math.cos(g.b_deg * DEG2RAD), 0.08);
    const halfSpanL = Math.min(180, (screenRadiusDeg + 8) / cosB);
    lStart = g.l_deg - halfSpanL;
    lEnd = g.l_deg + halfSpanL;
  }

  // Step scales with the FoV, clamped so we never blow past GAL_MAX_QUADS even
  // when the window is a full hemisphere.
  const span = lEnd - lStart;
  const step = Math.max(fovX / 120, span / GAL_MAX_QUADS, 0.02);
  // Clip the band to the safe window. Prefer the smooth boundary loop so the
  // hatch reaches exactly to the safe-window outline (the quad approximation
  // bows inside it on the curved edges, leaving a visible gap); fall back to
  // the quad tiling when the window is partly behind the projection. Both are
  // projected once per frame upstream and shared with drawAltitudeLimitOverlay.
  const { loopPx: windowLoop, ok: windowOk, quads: hardWindowQuads } = safeWindow;
  if (!windowOk && hardWindowQuads.length === 0) return;

  ctx.save();
  ctx.beginPath();
  if (windowOk) {
    ctx.moveTo(windowLoop[0][0], windowLoop[0][1]);
    for (const [x, y] of windowLoop.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
  } else {
    for (const quad of hardWindowQuads) {
      ctx.moveTo(quad[0][0], quad[0][1]);
      for (const [x, y] of quad.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
    }
  }
  ctx.clip();

  // A quad is on-screen iff its bounding box overlaps the viewport. (The old
  // "all four corners off-screen" test wrongly culled the screen-spanning quad
  // you get when zoomed inside the band — its corners are all off-screen.)
  const overlapsScreen = (a: number[], b: number[], c: number[], d: number[]) =>
    Math.max(a[0], b[0], c[0], d[0]) >= 0 && Math.min(a[0], b[0], c[0], d[0]) <= w &&
    Math.max(a[1], b[1], c[1], d[1]) >= 0 && Math.min(a[1], b[1], c[1], d[1]) <= h;

  const baseTint = 'rgba(255, 86, 64, 0.12)';
  const stripes = galacticStripePattern(ctx);
  ctx.save();
  let prevTop = project(lStart, L);
  let prevBot = project(lStart, -L);
  for (let l = lStart + step; l <= lEnd + step / 2; l += step) {
    const top = project(l, L);
    const bot = project(l, -L);
    if (prevTop && prevBot && top && bot && overlapsScreen(prevTop, top, bot, prevBot)) {
      ctx.beginPath();
      ctx.moveTo(prevTop[0], prevTop[1]);
      ctx.lineTo(top[0], top[1]);
      ctx.lineTo(bot[0], bot[1]);
      ctx.lineTo(prevBot[0], prevBot[1]);
      ctx.closePath();
      // Flat tint for legibility, then the diagonal hatch on top. The pattern
      // is in screen space, so it stays continuous across adjacent quads.
      ctx.fillStyle = baseTint;
      ctx.fill();
      if (stripes) {
        ctx.fillStyle = stripes;
        ctx.fill();
      }
    }
    prevTop = top;
    prevBot = bot;
  }
  ctx.restore();

  // Dashed boundary at b = ±limit so the edge of the no-go strip is legible.
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 132, 110, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  for (const b of [L, -L]) {
    const samples: RaDecTarget[] = [];
    for (let l = lStart; l <= lEnd + step / 2; l += step) samples.push(galacticToRaDec(l, b));
    drawProjectedPolyline(ctx, aladin, samples, span >= 360, w, h);
  }
  ctx.restore();

  // Label the band on the on-screen stretch of the plane closest to centre.
  const onScreen = (p: [number, number]) => p[0] >= 0 && p[0] <= w && p[1] >= 0 && p[1] <= h;
  let best: { p: [number, number]; d: number } | null = null;
  for (let l = lStart; l <= lEnd + step / 2; l += step) {
    const p = project(l, 0);
    if (!p || !onScreen(p)) continue;
    const d = Math.hypot(p[0] - w / 2, p[1] - h / 2);
    if (!best || d < best.d) best = { p, d };
  }
  if (best) {
    ctx.save();
    ctx.font = '12px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText('Milky Way', best.p[0], best.p[1]);
    ctx.fillStyle = 'rgba(255, 168, 150, 0.95)';
    ctx.fillText('Milky Way', best.p[0], best.p[1]);
    ctx.restore();
  }
  ctx.restore();
};


// Drawn just below the horizon line so they sit in the ground fill.
const CARDINALS: { label: string; az: number; bold: boolean }[] = [
  { label: 'N',  az: 0,   bold: true  },
  { label: 'NE', az: 45,  bold: false },
  { label: 'E',  az: 90,  bold: true  },
  { label: 'SE', az: 135, bold: false },
  { label: 'S',  az: 180, bold: true  },
  { label: 'SW', az: 225, bold: false },
  { label: 'W',  az: 270, bold: true  },
  { label: 'NW', az: 315, bold: false },
];

export const drawCardinals: Layer = ({ ctx, aladin, w, h, config, date }) => {
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  for (const { label, az, bold } of CARDINALS) {
    const { ra_deg: lRa, dec_deg: lDec } = altAzToRaDec(
      { altitude_deg: -4, azimuth_deg: az }, config, date,
    );
    const lp = aladin.world2pix(lRa, lDec);
    if (!lp || !isFinite(lp[0]) || !isFinite(lp[1])) continue;
    if (lp[0] < -30 || lp[0] > w + 30 || lp[1] < -30 || lp[1] > h + 30) continue;

    const fontSize = bold ? 14 : 11;
    ctx.font      = `${bold ? 'bold ' : ''}${fontSize}px "IBM Plex Sans", system-ui, sans-serif`;
    // Subtle dark halo so labels read over both sky and ground
    ctx.lineWidth   = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.strokeText(label, lp[0], lp[1]);
    ctx.fillStyle   = 'rgba(255, 126, 89, 0.92)';
    ctx.fillText(label, lp[0], lp[1]);
  }
};


export const drawSlewPath: Layer = ({ ctx, aladin, config, date, telemetry, pending }) => {
  if (!pending || !telemetry) return;

  // Resolve telescope RA/Dec via the same conversion the click handler uses,
  // so the line lands on the same pixel as the beam circle.
  let telRa: number | null = null;
  let telDec: number | null = null;
  if (telemetry.altitude_deg != null && telemetry.azimuth_deg != null) {
    const pt = altAzToRaDec({ altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg }, config, date);
    telRa  = pt.ra_deg;
    telDec = pt.dec_deg;
  } else {
    telRa  = telemetry.ra_deg  ?? null;
    telDec = telemetry.dec_deg ?? null;
  }
  if (telRa == null || telDec == null) return;

  const pTel     = aladin.world2pix(telRa, telDec);
  const pPending = aladin.world2pix(pending.ra_deg, pending.dec_deg);
  if (!pTel     || !isFinite(pTel[0])     || !isFinite(pTel[1])) return;
  if (!pPending || !isFinite(pPending[0]) || !isFinite(pPending[1])) return;

  // Marching-ants offset derived from wall clock (24 px/s — the old
  // 0.4 px/frame at 60 fps), so the ant speed is independent of how often the
  // throttled draw loop repaints. Modulo the dash period ([7, 5] → 12 px) so
  // the wrap is seamless.
  const dashOffset = (date.getTime() * 0.024) % 12;

  ctx.save();
  ctx.setLineDash([7, 5]);
  ctx.lineDashOffset = -dashOffset;
  ctx.strokeStyle    = 'rgba(243, 204, 107, 0.75)';
  ctx.lineWidth      = 1.5;
  ctx.lineCap        = 'round';
  ctx.beginPath();
  ctx.moveTo(pTel[0],     pTel[1]);
  ctx.lineTo(pPending[0], pPending[1]);
  ctx.stroke();
  ctx.restore();
};


// Body pixel radii: project a point one apparent radius away in
// declination and measure the pixel distance — accurate at any zoom level.
const SUN_ANG_RADIUS_DEG  = 0.2655;
const MOON_ANG_RADIUS_DEG = 0.2591;

export const drawSunAndMoon: Layer = ({ ctx, aladin, w, h, config, date, hoverZones }) => {
  const sunPos  = sunRaDec(date);
  const moonPos = moonRaDec(date);
  const { fraction, waxing } = moonIllumination(sunPos, moonPos);

  const pSunEdge      = aladin.world2pix(sunPos.ra_deg, sunPos.dec_deg + SUN_ANG_RADIUS_DEG);
  const pMoonEdge     = aladin.world2pix(moonPos.ra_deg, moonPos.dec_deg + MOON_ANG_RADIUS_DEG);
  const pSunExclusion = aladin.world2pix(sunPos.ra_deg, sunPos.dec_deg + SUN_EXCLUSION_DEG);

  const bodies = [
    { pos: sunPos,  alt: raDecToAltAz(sunPos.ra_deg,  sunPos.dec_deg,  config, date).altitude_deg, isSun: true  },
    { pos: moonPos, alt: raDecToAltAz(moonPos.ra_deg, moonPos.dec_deg, config, date).altitude_deg, isSun: false },
  ];
  for (const body of bodies) {
    if (body.alt <= 0) continue;
    const p = aladin.world2pix(body.pos.ra_deg, body.pos.dec_deg);
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
    if (p[0] < -60 || p[0] > w + 60 || p[1] < -60 || p[1] > h + 60) continue;

    let iconR = 9; // fallback if an edge projection is unavailable
    if (body.isSun && pSunEdge && isFinite(pSunEdge[0]) && isFinite(pSunEdge[1])) {
      iconR = Math.max(3, Math.hypot(pSunEdge[0] - p[0], pSunEdge[1] - p[1]));

      // ── Solar exclusion zone ────────────────────────────────────────────
      if (pSunExclusion && isFinite(pSunExclusion[0]) && isFinite(pSunExclusion[1])) {
        const exclR = Math.hypot(pSunExclusion[0] - p[0], pSunExclusion[1] - p[1]);
        hoverZones.sun.current = { cx: p[0], cy: p[1], r: exclR };

        const exclGrad = ctx.createRadialGradient(p[0], p[1], iconR, p[0], p[1], exclR);
        exclGrad.addColorStop(0,    'rgba(255, 130, 0, 0.38)');
        exclGrad.addColorStop(0.45, 'rgba(255, 100, 0, 0.18)');
        exclGrad.addColorStop(1,    'rgba(255,  70, 0, 0)');
        ctx.beginPath();
        ctx.arc(p[0], p[1], exclR, 0, 2 * Math.PI);
        ctx.fillStyle = exclGrad;
        ctx.fill();
      }

      drawSunIcon(ctx, p[0], p[1], iconR);
    } else if (!body.isSun) {
      if (pMoonEdge && isFinite(pMoonEdge[0]) && isFinite(pMoonEdge[1])) {
        iconR = Math.max(3, Math.hypot(pMoonEdge[0] - p[0], pMoonEdge[1] - p[1]));
      }
      drawMoonIcon(ctx, p[0], p[1], iconR, fraction, waxing);
    }

    // Label — sits just below the disc edge
    const label  = body.isSun ? 'Sun' : 'Moon';
    const colour = body.isSun ? '#ffd020' : '#c8d8ff';
    const labelY = p[1] + iconR + 4;
    ctx.font         = '11px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth    = 3;
    ctx.strokeStyle  = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(label, p[0], labelY);
    ctx.fillStyle    = colour;
    ctx.fillText(label, p[0], labelY);
  }
};


export const drawSatelliteOverlays: Layer = ({ ctx, aladin, w, h, config, date, overlays, hoverZones }) => {
  for (const overlay of overlays) {
    if (overlay.kind !== 'satellite') continue;
    const position = overlay.altitude_deg != null && overlay.azimuth_deg != null
      ? altAzToRaDec(
        { altitude_deg: overlay.altitude_deg, azimuth_deg: overlay.azimuth_deg },
        config,
        date,
      )
      : overlay;
    const p = aladin.world2pix(position.ra_deg, position.dec_deg);
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
    if (p[0] < -60 || p[0] > w + 60 || p[1] < -60 || p[1] > h + 60) continue;

    const iconSize = 13;
    drawSatelliteIcon(ctx, p[0], p[1], iconSize, overlay.color);
    hoverZones.satellites.current.push({
      cx: p[0],
      cy: p[1],
      r: iconSize * 1.45,
      overlay,
      ra_deg: position.ra_deg,
      dec_deg: position.dec_deg,
    });

    ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.strokeText(overlay.label, p[0], p[1] + 17);
    ctx.fillStyle = overlay.color;
    ctx.fillText(overlay.label, p[0], p[1] + 17);
  }
};


/**
 * Project ring centres + a point one FWHM/2 away in declination so the
 * pixel radius matches what Aladin draws for the overlay circles.
 *
 * Does not paint — just publishes the hover-zone refs so SkyMap's mouse
 * handler can answer "what ring is the cursor over?" without a hit-test loop.
 */
export const computeFwhmHoverZones: Layer = ({ aladin, telemetry, pending, config, fwhmDeg, hoverZones }) => {
  if (telemetry?.altitude_deg != null && telemetry?.azimuth_deg != null) {
    const beamRaDec = altAzToRaDec(
      { altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg },
      config, new Date(),
    );
    const pCen = aladin.world2pix(beamRaDec.ra_deg, beamRaDec.dec_deg);
    const pEdge = aladin.world2pix(beamRaDec.ra_deg, beamRaDec.dec_deg + fwhmDeg / 2);
    if (pCen && pEdge && isFinite(pCen[0]) && isFinite(pEdge[0])) {
      hoverZones.beam.current = {
        cx: pCen[0], cy: pCen[1],
        r: Math.max(6, Math.hypot(pEdge[0] - pCen[0], pEdge[1] - pCen[1])),
        fwhm: fwhmDeg,
      };
    }
  }

  if (pending) {
    const pCen = aladin.world2pix(pending.ra_deg, pending.dec_deg);
    const pEdge = aladin.world2pix(pending.ra_deg, pending.dec_deg + fwhmDeg / 2);
    if (pCen && pEdge && isFinite(pCen[0]) && isFinite(pEdge[0])) {
      hoverZones.pending.current = {
        cx: pCen[0], cy: pCen[1],
        r: Math.max(6, Math.hypot(pEdge[0] - pCen[0], pEdge[1] - pCen[1])),
        fwhm: fwhmDeg,
      };
    }
  }
};

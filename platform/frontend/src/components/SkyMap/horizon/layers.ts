import type A from 'aladin-lite';
import type { MutableRefObject } from 'react';

import {
  DEG2RAD,
  GALACTIC_PLANE_EXCLUSION_DEG,
  altAzToRaDec,
  galacticToRaDec,
  moonIllumination,
  moonRaDec,
  raDecToAltAz,
  raDecToGalactic,
  sunRaDec,
} from '../../../lib/astro';
import type { RaDecTarget, RoboClawTelemetry, TelescopeConfig } from '../../../types';
import { drawMoonIcon, drawSunIcon, pointInPolygon } from './icons';


export type AladinInstance = ReturnType<typeof A.aladin>;

export type HoverZone = { cx: number; cy: number; r: number; fwhm?: number };

export interface HoverZoneRefs {
  sun: MutableRefObject<{ cx: number; cy: number; r: number } | null>;
  beam: MutableRefObject<{ cx: number; cy: number; r: number; fwhm: number } | null>;
  pending: MutableRefObject<{ cx: number; cy: number; r: number; fwhm: number } | null>;
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
 *  - `dashOffset.current` — incremented by drawSlewPath for its dash animation
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
  fwhmDeg: number;
  horizonPx: [number, number][];
  almucantars: { altitude_deg: number; samples: RaDecTarget[] }[];
  meridians: { azimuth_deg: number; samples: RaDecTarget[] }[];
  groundIsInside: boolean;
  hoverZones: HoverZoneRefs;
  dashOffset: { current: number };
  /** When true, shade the galactic-plane band the baseline wizard excludes. */
  galacticExclusion: boolean;
}


export type Layer = (state: FrameState) => void;


// ─── Sample caching (horizon polygon + alt/az grid) ──────────────────────────

const ALT_RINGS = [15, 30, 45, 60, 75];
const AZ_LINES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const ALTITUDE_LIMIT_MIN_DEG = 30;
const ALTITUDE_LIMIT_MAX_DEG = 70;

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

function drawProjectedPolyline(
  ctx: CanvasRenderingContext2D,
  aladin: AladinInstance,
  samples: RaDecTarget[],
  wrap: boolean,
  w: number,
  h: number,
): void {
  // Project to pixels, splitting into segments wherever:
  //  (a) a sample is off-screen / unprojectable, or
  //  (b) two consecutive samples are absurdly far apart in pixels (the
  //      projection wrapped behind us — connecting them would streak).
  const margin = 40;
  const maxSegmentPx = Math.max(w, h);
  let prev: [number, number] | null = null;
  let firstOnscreen: [number, number] | null = null;
  ctx.beginPath();
  for (const { ra_deg, dec_deg } of samples) {
    const p = aladin.world2pix(ra_deg, dec_deg);
    const offscreen = !p || !isFinite(p[0]) || !isFinite(p[1]) ||
      p[0] < -margin || p[0] > w + margin || p[1] < -margin || p[1] > h + margin;
    if (offscreen) { prev = null; continue; }
    const point = p as [number, number];
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


// ─── Layers ──────────────────────────────────────────────────────────────────
// To swap in a real panorama, replace the fillStyle block in drawGround with
// ctx.drawImage(panoramaImg, …) mapped to the same clipping polygon.

function buildAltitudeRing(config: TelescopeConfig, date: Date, altitudeDeg: number, stepDeg = 3): RaDecTarget[] {
  const samples: RaDecTarget[] = [];
  for (let az = 0; az < 360; az += stepDeg) {
    samples.push(altAzToRaDec({ altitude_deg: altitudeDeg, azimuth_deg: az }, config, date));
  }
  return samples;
}

function buildAltitudeBandQuads(
  aladin: AladinInstance,
  config: TelescopeConfig,
  date: Date,
  minAltDeg: number,
  maxAltDeg: number,
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
  let prevMin = project(minAltDeg, 0);
  let prevMax = project(maxAltDeg, 0);
  for (let az = 3; az <= 360; az += 3) {
    const nextAz = az === 360 ? 0 : az;
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

export const drawAltitudeLimitOverlay: Layer = ({ ctx, aladin, w, h, config, date }) => {
  const validBandQuads = buildAltitudeBandQuads(
    aladin,
    config,
    date,
    ALTITUDE_LIMIT_MIN_DEG,
    ALTITUDE_LIMIT_MAX_DEG,
    w,
    h,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  for (const quad of validBandQuads) {
    ctx.moveTo(quad[0][0], quad[0][1]);
    for (const [x, y] of quad.slice(1)) ctx.lineTo(x, y);
    ctx.closePath();
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
  ctx.fill('evenodd');

  ctx.strokeStyle = 'rgba(232, 238, 244, 0.72)';
  ctx.lineWidth = 1.5;
  for (const alt of [ALTITUDE_LIMIT_MIN_DEG, ALTITUDE_LIMIT_MAX_DEG]) {
    drawProjectedPolyline(ctx, aladin, buildAltitudeRing(config, date, alt), true, w, h);
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


export const drawAltAzGrid: Layer = ({ ctx, aladin, w, h, config, date, almucantars, meridians }) => {
  ctx.save();
  ctx.strokeStyle = 'rgba(114, 224, 173, 0.28)';
  ctx.lineWidth = 1;
  for (const ring of almucantars) {
    drawProjectedPolyline(ctx, aladin, ring.samples, true, w, h);
  }
  for (const meridian of meridians) {
    drawProjectedPolyline(ctx, aladin, meridian.samples, false, w, h);
  }

  // Azimuth labels — pinned to the top edge, sliding along each meridian
  // as the user pans so the bearing of every visible line stays readable.
  const AZ_LABEL_Y = 18;
  const maxSegmentPx = Math.max(w, h);
  ctx.font         = '11px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth    = 3;
  for (const meridian of meridians) {
    let prev: [number, number] | null = null;
    let labelX: number | null = null;
    for (const { ra_deg, dec_deg } of meridian.samples) {
      const p = aladin.world2pix(ra_deg, dec_deg);
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) { prev = null; continue; }
      if (prev) {
        const [x0, y0] = prev;
        const [x1, y1] = p;
        const straddles = (y0 - AZ_LABEL_Y) * (y1 - AZ_LABEL_Y) <= 0;
        const continuous = Math.hypot(x1 - x0, y1 - y0) < maxSegmentPx;
        if (straddles && continuous && y0 !== y1) {
          const t = (AZ_LABEL_Y - y0) / (y1 - y0);
          const x = x0 + t * (x1 - x0);
          if (x >= 0 && x <= w) { labelX = x; break; }
        }
      }
      prev = [p[0], p[1]];
    }
    if (labelX != null) {
      const label = `+${Math.round(meridian.azimuth_deg).toString().padStart(3, '0')}°`;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.strokeText(label, labelX, AZ_LABEL_Y);
      ctx.fillStyle = 'rgba(114, 224, 173, 0.85)';
      ctx.fillText(label, labelX, AZ_LABEL_Y);
    }
  }

  // Almucantar altitude labels — placed on opposite meridians for readability
  ctx.fillStyle    = 'rgba(114, 224, 173, 0.55)';
  ctx.font         = '10px "IBM Plex Sans", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const az of [180, 0]) {
    ctx.textAlign = az === 180 ? 'left' : 'right';
    const xOffset = az === 180 ? 4 : -4;
    for (const ring of almucantars) {
      const labelPos = altAzToRaDec({ altitude_deg: ring.altitude_deg, azimuth_deg: az }, config, date);
      const lp = aladin.world2pix(labelPos.ra_deg, labelPos.dec_deg);
      if (lp && isFinite(lp[0]) && isFinite(lp[1]) &&
          lp[0] >= 0 && lp[0] <= w && lp[1] >= 0 && lp[1] <= h) {
        ctx.fillText(`${ring.altitude_deg}°`, lp[0] + xOffset, lp[1]);
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

export const drawGalacticExclusion: Layer = ({ ctx, aladin, w, h, galacticExclusion }) => {
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
    ctx.strokeText('Milky Way — too noisy', best.p[0], best.p[1]);
    ctx.fillStyle = 'rgba(255, 168, 150, 0.95)';
    ctx.fillText('Milky Way — too noisy', best.p[0], best.p[1]);
    ctx.restore();
  }
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


export const drawSlewPath: Layer = ({ ctx, aladin, config, date, telemetry, pending, dashOffset }) => {
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

  dashOffset.current = (dashOffset.current + 0.4) % 22;

  ctx.save();
  ctx.setLineDash([7, 5]);
  ctx.lineDashOffset = -dashOffset.current;
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
const SUN_EXCLUSION_DEG   = 15;

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

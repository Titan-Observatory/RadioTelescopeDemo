// Shared astronomy + coordinate helpers used by the sky map and spectrum
// panels. The Python backend has its own (higher-precision) versions in
// `radiotelescope.pointing` / `radiotelescope.geometry`; the implementations
// here are deliberately the low-precision ones (~1° accuracy) appropriate
// for synchronous client-side feedback while the user drags the map.

import type { AltAzPoint, RaDecTarget, TelescopeConfig } from '../types';

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

/** Rest frequency of the 21 cm neutral-hydrogen line (MHz). */
export const HYDROGEN_LINE_MHZ = 1420.4058;

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Shift `deg` by multiples of 360 to land within 180° of `reference`. */
export function unwrapDeg(deg: number, reference: number): number {
  let value = deg;
  while (value - reference > 180) value -= 360;
  while (value - reference < -180) value += 360;
  return value;
}

/** Half-plane sign test for point-in-triangle (matches the Python copy). */
export function isInsideTriangle(point: AltAzPoint, triangle: AltAzPoint[]): boolean {
  if (triangle.length !== 3) return true;

  const reference = triangle[0].azimuth_deg;
  const px = unwrapDeg(point.azimuth_deg, reference);
  const py = point.altitude_deg;
  const vertices = triangle.map((vertex) => ({
    x: unwrapDeg(vertex.azimuth_deg, reference),
    y: vertex.altitude_deg,
  }));
  const [a, b, c] = vertices;

  const sign = (
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
  ) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);

  const d1 = sign(px, py, a.x, a.y, b.x, b.y);
  const d2 = sign(px, py, b.x, b.y, c.x, c.y);
  const d3 = sign(px, py, c.x, c.y, a.x, a.y);
  const hasNegative = d1 < -1e-9 || d2 < -1e-9 || d3 < -1e-9;
  const hasPositive = d1 > 1e-9 || d2 > 1e-9 || d3 > 1e-9;
  return !(hasNegative && hasPositive);
}

export function julianDay(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

export function gmstDeg(date: Date): number {
  const d = julianDay(date) - 2_451_545.0;
  return normalizeDeg(280.46061837 + 360.98564736629 * d);
}

export function localSiderealDeg(config: TelescopeConfig, date: Date): number {
  return normalizeDeg(gmstDeg(date) + config.observer_longitude_deg);
}

export function raDecToAltAz(
  ra_deg: number,
  dec_deg: number,
  config: TelescopeConfig,
  date: Date,
): AltAzPoint {
  const lat = config.observer_latitude_deg * DEG2RAD;
  const dec = dec_deg * DEG2RAD;
  const hourAngle = normalizeDeg(localSiderealDeg(config, date) - ra_deg) * DEG2RAD;

  const sinAlt =
    Math.sin(dec) * Math.sin(lat) +
    Math.cos(dec) * Math.cos(lat) * Math.cos(hourAngle);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const az = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngle),
  );

  return {
    altitude_deg: alt * RAD2DEG,
    azimuth_deg: normalizeDeg(az * RAD2DEG),
  };
}

export function altAzToRaDec(
  point: AltAzPoint,
  config: TelescopeConfig,
  date: Date,
): RaDecTarget {
  const lat = config.observer_latitude_deg * DEG2RAD;
  const alt = point.altitude_deg * DEG2RAD;
  const az = point.azimuth_deg * DEG2RAD;

  const sinDec =
    Math.sin(alt) * Math.sin(lat) +
    Math.cos(alt) * Math.cos(lat) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const hourAngle = Math.atan2(
    -Math.sin(az) * Math.cos(alt),
    Math.sin(alt) * Math.cos(lat) - Math.cos(alt) * Math.sin(lat) * Math.cos(az),
  );

  return {
    ra_deg: normalizeDeg(localSiderealDeg(config, date) - hourAngle * RAD2DEG),
    dec_deg: dec * RAD2DEG,
  };
}

export function positionAngleDeg(from: RaDecTarget, to: RaDecTarget): number {
  const ra1 = from.ra_deg * DEG2RAD;
  const dec1 = from.dec_deg * DEG2RAD;
  const ra2 = to.ra_deg * DEG2RAD;
  const dec2 = to.dec_deg * DEG2RAD;
  const deltaRa = ra2 - ra1;
  const y = Math.sin(deltaRa);
  const x = Math.cos(dec1) * Math.tan(dec2) - Math.sin(dec1) * Math.cos(deltaRa);
  return normalizeDeg(Math.atan2(y, x) * RAD2DEG);
}

export function sunRaDec(date: Date): RaDecTarget {
  const d  = julianDay(date) - 2_451_545.0;
  const L  = normalizeDeg(280.460 + 0.9856474 * d);
  const g  = normalizeDeg(357.528 + 0.9856003 * d) * DEG2RAD;
  const λ  = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG2RAD;
  const ε  = (23.439 - 0.0000004 * d) * DEG2RAD;
  return {
    ra_deg:  normalizeDeg(Math.atan2(Math.cos(ε) * Math.sin(λ), Math.cos(λ)) * RAD2DEG),
    dec_deg: Math.asin(Math.sin(ε) * Math.sin(λ)) * RAD2DEG,
  };
}

export function moonRaDec(date: Date): RaDecTarget {
  const d   = julianDay(date) - 2_451_545.0;
  const L   = normalizeDeg(218.316 + 13.176396 * d);
  const M   = normalizeDeg(134.963 + 13.064993 * d) * DEG2RAD;
  const F   = normalizeDeg(93.272  + 13.229350 * d) * DEG2RAD;
  const lon = (L + 6.289 * Math.sin(M)) * DEG2RAD;
  const lat = 5.128 * Math.sin(F) * DEG2RAD;
  const ε   = (23.439 - 0.0000004 * d) * DEG2RAD;
  return {
    ra_deg: normalizeDeg(
      Math.atan2(Math.cos(ε) * Math.sin(lon) - Math.tan(lat) * Math.sin(ε), Math.cos(lon)) * RAD2DEG,
    ),
    dec_deg: Math.asin(
      Math.sin(lat) * Math.cos(ε) + Math.cos(lat) * Math.sin(ε) * Math.sin(lon),
    ) * RAD2DEG,
  };
}

/** Illuminated fraction (0 = new, 1 = full) and whether the moon is waxing. */
export function moonIllumination(
  sun: RaDecTarget,
  moon: RaDecTarget,
): { fraction: number; waxing: boolean } {
  const sRa = sun.ra_deg * DEG2RAD, sDec = sun.dec_deg * DEG2RAD;
  const mRa = moon.ra_deg * DEG2RAD, mDec = moon.dec_deg * DEG2RAD;
  const elongation = Math.acos(
    Math.max(-1, Math.min(1,
      Math.sin(sDec) * Math.sin(mDec) + Math.cos(sDec) * Math.cos(mDec) * Math.cos(sRa - mRa),
    )),
  );
  return {
    fraction: (1 + Math.cos(elongation)) / 2,
    // Moon is waxing when it is 0–180° east of the sun
    waxing: normalizeDeg(moon.ra_deg - sun.ra_deg) < 180,
  };
}

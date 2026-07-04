// Shared astronomy + coordinate helpers used by the sky map and spectrum
// panels. The Python backend has its own (higher-precision) versions in
// `rt_hardware.pointing` / `rt_hardware.geometry`; the implementations
// here are deliberately the low-precision ones (~1° accuracy) appropriate
// for synchronous client-side feedback while the user drags the map.
//
// These functions are frozen by a golden-vector regression test
// (astro.golden.test.ts) so a hand-edit can't silently change their output.

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
// IAU 1958 galactic pole in J2000 equatorial coordinates.
const NGP_RA  = 192.85948 * DEG2RAD;
const NGP_DEC = 27.12825  * DEG2RAD;
const L_NCP   = 122.93192; // galactic longitude of the north celestial pole (degrees)

export function raDecToGalactic(ra_deg: number, dec_deg: number): { l_deg: number; b_deg: number } {
  const ra  = ra_deg  * DEG2RAD;
  const dec = dec_deg * DEG2RAD;
  const dRa = ra - NGP_RA;

  const sinB = Math.sin(dec) * Math.sin(NGP_DEC) + Math.cos(dec) * Math.cos(NGP_DEC) * Math.cos(dRa);
  const b_deg = Math.asin(Math.max(-1, Math.min(1, sinB))) * RAD2DEG;

  const y = Math.cos(dec) * Math.sin(dRa);
  const x = Math.sin(dec) * Math.cos(NGP_DEC) - Math.cos(dec) * Math.sin(NGP_DEC) * Math.cos(dRa);
  const l_deg = normalizeDeg(L_NCP - Math.atan2(y, x) * RAD2DEG);

  return { l_deg, b_deg };
}

/**
 * Inverse of {@link raDecToGalactic}: galactic (l, b) → J2000 equatorial.
 * The forward rotation is a reflection (its own inverse), so this applies the
 * same matrix with the roles of the celestial and galactic poles swapped.
 * Used to trace constant-latitude curves of the galactic plane onto the sky.
 */
export function galacticToRaDec(l_deg: number, b_deg: number): RaDecTarget {
  const b   = b_deg * DEG2RAD;
  const phi = (L_NCP - l_deg) * DEG2RAD;

  const sinDec = Math.sin(NGP_DEC) * Math.sin(b) + Math.cos(NGP_DEC) * Math.cos(b) * Math.cos(phi);
  const dec_deg = Math.asin(Math.max(-1, Math.min(1, sinDec))) * RAD2DEG;

  const y = Math.cos(b) * Math.sin(phi);
  const x = Math.cos(NGP_DEC) * Math.sin(b) - Math.sin(NGP_DEC) * Math.cos(b) * Math.cos(phi);
  const ra_deg = normalizeDeg(NGP_RA * RAD2DEG + Math.atan2(y, x) * RAD2DEG);

  return { ra_deg, dec_deg };
}

/**
 * Half-width (in galactic latitude) of the band around the galactic plane that
 * the baseline wizard steers users away from. Diffuse 21 cm emission from the
 * Milky Way is strongest near b = 0°, so a clean bandpass baseline needs a
 * patch at least this far off the plane. Shared by the SkyMap exclusion overlay
 * and the click-to-select guard so the shaded strip and the block agree.
 */
export const GALACTIC_PLANE_EXCLUSION_DEG = 15;

/**
 * Angular distance from the Sun (degrees) within which a pointing is unusable
 * for a bandpass baseline — the Sun's broadband emission swamps the 21 cm
 * window. Single source of truth for both the solar-exclusion ring drawn on the
 * sky map (horizon/layers.ts) and the baseline-pointing guard below.
 */
export const SUN_EXCLUSION_DEG = 15;

/** Great-circle separation (degrees) between two equatorial coordinates. */
export function angularSeparationDeg(a: RaDecTarget, b: RaDecTarget): number {
  const dec1 = a.dec_deg * DEG2RAD;
  const dec2 = b.dec_deg * DEG2RAD;
  const dRa = (a.ra_deg - b.ra_deg) * DEG2RAD;
  const cosSep =
    Math.sin(dec1) * Math.sin(dec2) +
    Math.cos(dec1) * Math.cos(dec2) * Math.cos(dRa);
  return Math.acos(Math.max(-1, Math.min(1, cosSep))) * RAD2DEG;
}

export interface BaselinePointingValidity {
  valid: boolean;
  /** Short, user-facing reason the pointing is unsuitable (null when valid). */
  reason: string | null;
}

/**
 * Decide whether the dish's current pointing is a clean spot to capture a
 * bandpass baseline. Mirrors the guards in the sky-map click handler and the
 * overlays the user sees: inside the hard alt/az safety limits (the hatched
 * region on the map), above the horizon, clear of the shaded Milky Way band,
 * and outside the solar exclusion ring. Used to gate the baseline wizard's
 * "Continue" button on the live telescope position.
 */
export function validateBaselinePointing(
  altAz: AltAzPoint,
  config: TelescopeConfig,
  date: Date,
): BaselinePointingValidity {
  const hard = config.hard_safety_limits;
  if (
    altAz.altitude_deg < hard.altitude_min_deg ||
    altAz.altitude_deg > hard.altitude_max_deg ||
    altAz.azimuth_deg < hard.azimuth_min_deg ||
    altAz.azimuth_deg > hard.azimuth_max_deg
  ) {
    return { valid: false, reason: 'Pointing is outside the available sky region.' };
  }
  if (altAz.altitude_deg < 0) {
    return { valid: false, reason: 'Pointing is below the horizon.' };
  }

  const { ra_deg, dec_deg } = altAzToRaDec(altAz, config, date);
  const { b_deg } = raDecToGalactic(ra_deg, dec_deg);
  if (Math.abs(b_deg) < GALACTIC_PLANE_EXCLUSION_DEG) {
    return {
      valid: false,
      reason: `Pointing is inside the Milky Way band — aim at least ${GALACTIC_PLANE_EXCLUSION_DEG}° off the galactic plane.`,
    };
  }

  // The Sun only contaminates the band while it's up, so match the sky-map
  // overlay and skip the check when it's below the horizon.
  const sun = sunRaDec(date);
  if (
    raDecToAltAz(sun.ra_deg, sun.dec_deg, config, date).altitude_deg > 0 &&
    angularSeparationDeg({ ra_deg, dec_deg }, sun) < SUN_EXCLUSION_DEG
  ) {
    return { valid: false, reason: `Pointing is within ${SUN_EXCLUSION_DEG}° of the Sun.` };
  }

  return { valid: true, reason: null };
}

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

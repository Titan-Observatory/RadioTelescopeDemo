// Golden-vector regression test for astro.ts.
//
// astro.ts is a hand-maintained, deliberately low-precision (~1°) port of the
// backend's pointing/geometry math. There is no high-precision Python twin to
// diff against — the backend uses katpoint/pyephem (refraction, precession,
// nutation), which intentionally disagrees with these formulas — so cross-
// language tolerance checks would fail spuriously. Instead we freeze astro.ts's
// own outputs for a fixed set of inputs into __fixtures__/astro.golden.json.
// Any accidental drift (a sign flip, a mistyped constant, a refactor bug) then
// trips this test, and an *intentional* change shows up as a visible fixture
// diff. A handful of first-principles anchors below guard against freezing a
// value that is wrong to begin with.
//
// Run:        node --test src/lib/astro.golden.test.ts
// Regenerate: UPDATE_GOLDEN=1 node --test src/lib/astro.golden.test.ts
//
// This file runs under Node's native TypeScript type-stripping and is excluded
// from the production tsc typecheck (tsconfig `exclude`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import * as astro from './astro.ts';

// ── Fixed inputs (no Date.now() / Math.random() — fully deterministic) ──────
const T0 = new Date(Date.UTC(2026, 5, 18, 3, 30, 0)); // night over the site
const T_J2000 = new Date(Date.UTC(2000, 0, 1, 12, 0, 0)); // the J2000 epoch
const T_NOON = new Date(Date.UTC(2026, 5, 18, 12, 0, 0));

const config = {
  beam_fwhm_deg: 5,
  goto_speed_qpps: 0,
  goto_accel_qpps2: 0,
  goto_decel_qpps2: 0,
  observer_latitude_deg: 40.0,
  observer_longitude_deg: -74.5,
  hard_safety_limits: {
    altitude_min_deg: 0,
    altitude_max_deg: 85,
    azimuth_min_deg: 0,
    azimuth_max_deg: 360,
  },
};

// The Crab Nebula (M1) — a convenient fixed equatorial target.
const CRAB = { ra_deg: 83.6331, dec_deg: 22.0145 };

function compute(): Record<string, unknown> {
  return {
    julian_day_t0: astro.julianDay(T0),
    gmst_j2000: astro.gmstDeg(T_J2000),
    gmst_t0: astro.gmstDeg(T0),
    lst_t0: astro.localSiderealDeg(config, T0),
    normalize_deg: [astro.normalizeDeg(-10), astro.normalizeDeg(370), astro.normalizeDeg(720.5)],
    unwrap_deg: [astro.unwrapDeg(350, 10), astro.unwrapDeg(5, 355)],
    radec_to_altaz_crab: astro.raDecToAltAz(CRAB.ra_deg, CRAB.dec_deg, config, T0),
    altaz_to_radec: astro.altAzToRaDec({ altitude_deg: 45, azimuth_deg: 135 }, config, T0),
    galactic_forward_crab: astro.raDecToGalactic(CRAB.ra_deg, CRAB.dec_deg),
    galactic_inverse: astro.galacticToRaDec(184.55, -5.78),
    sun: astro.sunRaDec(T_NOON),
    moon: astro.moonRaDec(T_NOON),
    position_angle: astro.positionAngleDeg({ ra_deg: 10, dec_deg: 20 }, { ra_deg: 15, dec_deg: 25 }),
    angular_separation: astro.angularSeparationDeg({ ra_deg: 10, dec_deg: 20 }, { ra_deg: 15, dec_deg: 25 }),
    moon_illumination: astro.moonIllumination(astro.sunRaDec(T_NOON), astro.moonRaDec(T_NOON)),
    // The safety gate the BaselineWizard depends on — freeze each decision,
    // hitting a distinct branch in each case (clean / hard-limit).
    validate_clean: astro.validateBaselinePointing({ altitude_deg: 60, azimuth_deg: 180 }, config, T0),
    validate_too_high: astro.validateBaselinePointing({ altitude_deg: 88, azimuth_deg: 180 }, config, T0),
  };
}

const fixturePath = fileURLToPath(new URL('./__fixtures__/astro.golden.json', import.meta.url));
const actual = compute();

if (process.env.UPDATE_GOLDEN) {
  mkdirSync(dirname(fixturePath), { recursive: true });
  writeFileSync(fixturePath, JSON.stringify(actual, null, 2) + '\n');
  // eslint-disable-next-line no-console
  console.log('Wrote golden fixture:', fixturePath);
}

// Absolute-dominant tolerance. An absolute floor is what actually guards the
// values: a purely relative tolerance would scale with magnitude and let a
// large-magnitude field like the Julian Day (~2.46e6) drift by minutes before
// tripping. The tiny relative term only absorbs last-ULP differences between JS
// engines for those big values; small angle fields are guarded at ~1e-9°.
const ABS_TOL = 1e-9;
const REL_TOL = 1e-12;

function deepApproxEqual(got: unknown, want: unknown, path: string): void {
  if (typeof want === 'number') {
    assert.equal(typeof got, 'number', `type mismatch at ${path}`);
    assert.ok(
      Math.abs((got as number) - want) <= ABS_TOL + REL_TOL * Math.abs(want),
      `value drift at ${path}: got ${got}, expected ${want}`,
    );
    return;
  }
  if (Array.isArray(want)) {
    assert.ok(Array.isArray(got), `expected array at ${path}`);
    assert.equal((got as unknown[]).length, want.length, `length mismatch at ${path}`);
    want.forEach((w, i) => deepApproxEqual((got as unknown[])[i], w, `${path}[${i}]`));
    return;
  }
  if (want !== null && typeof want === 'object') {
    assert.ok(got !== null && typeof got === 'object', `expected object at ${path}`);
    const wObj = want as Record<string, unknown>;
    const gObj = got as Record<string, unknown>;
    assert.deepEqual(Object.keys(gObj).sort(), Object.keys(wObj).sort(), `keys mismatch at ${path}`);
    for (const k of Object.keys(wObj)) deepApproxEqual(gObj[k], wObj[k], `${path}.${k}`);
    return;
  }
  assert.equal(got, want, `mismatch at ${path}`);
}

function wrap180(deg: number): number {
  return ((((deg % 360) + 540) % 360) - 180);
}

test('astro.ts outputs match the frozen golden fixture', () => {
  const expected = JSON.parse(readFileSync(fixturePath, 'utf8'));
  deepApproxEqual(actual, expected, '$');
});

// ── First-principles anchors (independent of the fixture) ───────────────────

test('GMST at the J2000 epoch equals the IAU constant 280.46061837°', () => {
  assert.ok(Math.abs(astro.gmstDeg(T_J2000) - 280.46061837) < 1e-6);
});

test('the galactic centre lies on the galactic equator (b ≈ 0)', () => {
  const { b_deg } = astro.raDecToGalactic(266.40499, -28.93617);
  assert.ok(Math.abs(b_deg) < 0.02, `b=${b_deg}`);
});

test('alt/az ↔ ra/dec round-trips to within 1e-6°', () => {
  const aa = { altitude_deg: 37.5, azimuth_deg: 222.0 };
  const rd = astro.altAzToRaDec(aa, config, T0);
  const back = astro.raDecToAltAz(rd.ra_deg, rd.dec_deg, config, T0);
  assert.ok(Math.abs(back.altitude_deg - aa.altitude_deg) < 1e-6, `alt ${back.altitude_deg}`);
  assert.ok(Math.abs(wrap180(back.azimuth_deg - aa.azimuth_deg)) < 1e-6, `az ${back.azimuth_deg}`);
});

test('normalizeDeg wraps into [0, 360)', () => {
  assert.equal(astro.normalizeDeg(-10), 350);
  assert.equal(astro.normalizeDeg(370), 10);
});

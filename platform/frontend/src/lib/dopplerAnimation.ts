import { H1_REST_MHZ } from './queueHeroSpectrum';

// Geometric Doppler illustration math, shared by the queue-page Doppler section
// and the in-app "learn more" modal. A source oscillates back and forth on the
// right, emitting circular wavefronts that expand at speed C. Because each
// wavefront is centred on where the source *was* at emission time, consecutive
// wavefronts' leftmost edges bunch up when the source is approaching the
// telescope (blueshift) and spread apart when it's receding (redshift). The
// sine wave drawn from source to telescope has its crests pinned to those
// leftmost edges via segment-by-segment phase interpolation, so the local
// wavelength varies along the path. A mini spectrum below the scene tracks the
// frequency the source is *emitting right now* - light-travel delay is
// deliberately ignored so the peak stays in lockstep with the cloud's velocity
// readout. Pure logic only (no React).

export const DA_W = 600;
export const DA_H = 392;                   // total SVG height (scene + mini spectrum)
export const DA_AXIS_Y = 96;               // y of horizontal axis through source
export const DA_TELESCOPE_X = 52;          // x of dish centre
export const DA_DISH_BACK_X = DA_TELESCOPE_X - 0.5;
export const DA_DISH_FEED_X = DA_TELESCOPE_X + 26;
export const DA_SOURCE_CENTER_X = 430;     // mean x position of source
export const DA_C_PX_S = 94;               // wavefront expansion speed (px/s)
export const DA_T_EMIT_S = 0.78;           // seconds between successive emissions
export const DA_MAX_R = 420;               // wavefront fade-out radius
export const DA_WAVE_AMP = 16;             // sine-wave amplitude in px

// Velocity profile. Pure sin never lets the shift "settle"; tanh-shaped sin
// has the right dwell but transitions through zero too quickly. We instead
// build a piecewise profile with explicit dwell periods at ±V_MAX and cubic
// smoothstep transitions between them. That way the spectrum's peak holds
// rock-steady at full blue (or red) for several seconds, then slides
// continuously across the rest line to the other side.
export const DA_V_MAX = 22;          // dwell speed (px/s); must be < C for physical sanity
const DA_DWELL_S = 5;         // seconds of constant-velocity dwell each direction
const DA_TRANS_S = 4;         // seconds of smooth transition between dwells
const DA_T_OSC_S = 2 * DA_DWELL_S + 2 * DA_TRANS_S; // full back-and-forth period

export const vTowardAt = (time: number) => {
  const T = DA_T_OSC_S;
  const phase = ((time % T) + T) % T;
  if (phase < DA_DWELL_S) return DA_V_MAX;                      // settled blueshift
  if (phase < DA_DWELL_S + DA_TRANS_S) {
    const u = (phase - DA_DWELL_S) / DA_TRANS_S;
    const s = u * u * (3 - 2 * u);                              // cubic smoothstep
    return DA_V_MAX * (1 - 2 * s);                              // +V → -V
  }
  if (phase < 2 * DA_DWELL_S + DA_TRANS_S) return -DA_V_MAX;    // settled redshift
  const u = (phase - 2 * DA_DWELL_S - DA_TRANS_S) / DA_TRANS_S;
  const s = u * u * (3 - 2 * u);
  return -DA_V_MAX * (1 - 2 * s);                               // -V → +V
};

// Source position is the integral of velocity. Since there's no closed form
// for ∫tanh(k·sin), we precompute one full period via trapezoidal integration
// and interpolate. Motion is periodic so a single cycle's table is enough.
const DA_POS_CACHE_SIZE = 1024;
const DA_POS_CACHE = (() => {
  const cache = new Array<number>(DA_POS_CACHE_SIZE + 1);
  const dt = DA_T_OSC_S / DA_POS_CACHE_SIZE;
  cache[0] = 0;
  for (let i = 1; i <= DA_POS_CACHE_SIZE; i++) {
    // Trapezoidal step. dx/dt = -v_toward because v_toward is positive when
    // the source approaches the telescope on the left, i.e. moves to lower x.
    const v0 = vTowardAt((i - 1) * dt);
    const v1 = vTowardAt(i * dt);
    cache[i] = cache[i - 1] - ((v0 + v1) / 2) * dt;
  }
  // Centre the oscillation around DA_SOURCE_CENTER_X.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= DA_POS_CACHE_SIZE; i++) {
    if (cache[i] < min) min = cache[i];
    if (cache[i] > max) max = cache[i];
  }
  const mid = (min + max) / 2;
  for (let i = 0; i <= DA_POS_CACHE_SIZE; i++) {
    cache[i] = cache[i] - mid + DA_SOURCE_CENTER_X;
  }
  return cache;
})();

export const sourceXAt = (time: number) => {
  // Wrap into [0, T) regardless of sign.
  const phase = ((time % DA_T_OSC_S) + DA_T_OSC_S) % DA_T_OSC_S;
  const idx = (phase / DA_T_OSC_S) * DA_POS_CACHE_SIZE;
  const i0 = Math.floor(idx);
  const i1 = i0 + 1;
  const frac = idx - i0;
  return DA_POS_CACHE[i0] * (1 - frac) + DA_POS_CACHE[i1] * frac;
};

// Mini-spectrum panel below the main scene. Styled to match the hero
// spectrum: gradient fill under a continuous noisy trace, grid lines, dashed
// rest-frequency marker, faint frequency-tick labels along the axis.
export const DA_MINI_LEFT_X = 64;
export const DA_MINI_W = 472;
export const DA_MINI_CX = DA_MINI_LEFT_X + DA_MINI_W / 2;
export const DA_MINI_TOP_Y = 214;             // panel top
export const DA_MINI_HEADER_Y = 229;          // "telescope receives" label baseline
export const DA_MINI_PLOT_TOP_Y = 241;        // top of plottable region
export const DA_MINI_BASE_Y = 338;            // baseline / x-axis y
export const DA_MINI_BOTTOM_PAD = 44;          // room for frequency labels below the axis
export const DA_MINI_PLOT_LEFT_X = DA_MINI_LEFT_X + 12;
export const DA_MINI_PLOT_RIGHT_X = DA_MINI_LEFT_X + DA_MINI_W - 12;
export const DA_MINI_PLOT_W = DA_MINI_PLOT_RIGHT_X - DA_MINI_PLOT_LEFT_X;
export const DA_MINI_PEAK_PX = 68;            // peak height above baseline (px)
export const DA_MINI_PEAK_SIGMA = 17;         // gaussian sigma of the underlying peak
export const DA_MINI_BINS = 110;              // resolution of the noisy trace
export const DA_MINI_NOISE_AMP = 0.07;        // matches hero spectrum receiver-noise feel
export const DA_MINI_NOISE_TAU_S = 0.08;      // smoothing time constant (s)
// Half-range narrower so the peak slides within ~half the panel rather than
// nearly the full width.
export const DA_MINI_HALF_RANGE = (DA_MINI_W / 2 - 36) * 0.55;

// Map mini-spectrum x to the frequency it represents. DA_V_MAX (in km/s in this
// scene) shifts the peak by DA_MINI_HALF_RANGE px, and Doppler says that
// corresponds to Δf = f₀ · v/c at the H1 rest line.
const DA_SPEED_OF_LIGHT_KMS = 299792.458;
const DA_DOPPLER_DF_AT_VMAX_MHZ =
  H1_REST_MHZ * DA_V_MAX / DA_SPEED_OF_LIGHT_KMS;
const DA_MINI_MHZ_PER_PX =
  DA_DOPPLER_DF_AT_VMAX_MHZ / DA_MINI_HALF_RANGE;
export const daFreqToX = (mhz: number) =>
  DA_MINI_CX + (mhz - H1_REST_MHZ) / DA_MINI_MHZ_PER_PX;
export const DA_MINI_GRID_MHZ = [1420.2, 1420.3, H1_REST_MHZ, 1420.5, 1420.6];
export const DA_MINI_REST_LABEL_MHZ = 1420.4;

export const dopplerColor = (vFrac: number): string => {
  // vFrac in approx [-V_MAX/C, +V_MAX/C]; positive = approaching (blueshift).
  const amber = [255, 188, 66];
  const blue = [91, 164, 245];
  const red = [255, 90, 77];
  const norm = Math.max(-1, Math.min(1, vFrac / (DA_V_MAX / DA_C_PX_S)));
  const target = norm > 0 ? blue : red;
  const a = Math.abs(norm);
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${hex(amber[0] + (target[0] - amber[0]) * a)}${hex(amber[1] + (target[1] - amber[1]) * a)}${hex(amber[2] + (target[2] - amber[2]) * a)}`;
};

// Solve for the time at which the wave whose leftmost edge currently sits at
// `x` was emitted. Source motion is periodic and sourceXAt wraps for negative
// arguments, so we can search arbitrarily far back in time - there's no
// startup transient where "no wave has reached the dish yet". Monotonicity of
// lhs in `emit` is guaranteed by |v_toward| < C, so binary search converges.
export function emitTimeAtX(t: number, x: number): number {
  let lo = t - DA_MAX_R / DA_C_PX_S;
  let hi = t;
  for (let k = 0; k < 26; k++) {
    const mid = (lo + hi) / 2;
    const lhs = sourceXAt(mid) - DA_C_PX_S * (t - mid);
    if (lhs > x) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

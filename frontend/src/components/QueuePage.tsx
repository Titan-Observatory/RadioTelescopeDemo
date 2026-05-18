import { useEffect, useRef, useState } from 'react';
import { Cloud } from 'lucide-react';

import type { QueueStatus } from '../queue';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
        },
      ) => string;
      reset: (widgetId?: string) => void;
    };
    onloadTurnstileCallback?: () => void;
  }
}

const TURNSTILE_SCRIPT_ID = 'cf-turnstile-script';
const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit';

// ─── SVG path helpers ──────────────────────────────────────────────────────────

function gaussianPts(cx: number, sigma: number, amp: number, base: number, w: number): string[] {
  const pts: string[] = [];
  for (let x = 0; x <= w; x += 3)
    pts.push(`${x},${(base - amp * Math.exp(-0.5 * ((x - cx) / sigma) ** 2)).toFixed(1)}`);
  return pts;
}

function gaussianLine(cx: number, sigma: number, amp: number, base: number, w: number): string {
  return `M ${gaussianPts(cx, sigma, amp, base, w).join(' L ')}`;
}

function gaussianFill(cx: number, sigma: number, amp: number, base: number, w: number): string {
  return `M 0,${base} L ${gaussianPts(cx, sigma, amp, base, w).join(' L ')} L ${w},${base} Z`;
}

function noiseFloor(base: number, w: number, amp: number): string {
  const pts: string[] = [];
  let v = 0;
  for (let x = 0; x <= w; x += 4) {
    v = v * 0.55 + (Math.sin(x * 0.43 + 7) * 0.5 + Math.sin(x * 0.19 + 3) * 0.5) * amp;
    pts.push(`${x},${(base + v).toFixed(1)}`);
  }
  return `M ${pts.join(' L ')}`;
}

// ─── Precomputed path data ─────────────────────────────────────────────────────

// Hero spectrum: 600×135 — animated playback of a real H I survey profile.
const HW = 600;
const HERO_BASE_Y = 112;          // y-coordinate of the 0-power baseline
const HERO_PEAK_PX = 90;          // pixels of y-range allocated to the strongest peak

// Real LAB-survey hydrogen-line brightness temperatures (K) sampled in 1.03
// km/s steps across v_LSR = -80 … +80 km/s. The line of sight is (l=110°,
// b=0°), which slices outward through the galactic disk: the local-arm peak
// sits right at the rest frequency, and the Perseus-arm peak ~50 km/s
// blueshifted shows up as a clearly separated second bump — a textbook
// Doppler-shift example with two comparable peaks and quiet wings.
//
// Pulled from the Argelander Institut LAB profile server:
//   https://www.astro.uni-bonn.de/hisurvey/euhou/LABprofile/
// Eventually we'll swap this for a real recording from this telescope.
const SURVEY_TB_K: number[] = [
  16.25, 15.84, 15.27, 15.02, 14.92, 15.18, 15.64, 16.37, 17.07, 17.93, 18.32,
  18.49, 18.78, 19.12, 20.26, 21.90, 24.66, 28.88, 35.45, 43.83, 53.37, 62.21,
  68.85, 72.88, 74.77, 76.67, 77.51, 78.62, 80.21, 81.63, 81.79, 79.82, 75.48,
  69.36, 61.44, 53.08, 45.61, 40.33, 35.66, 31.86, 28.56, 26.45, 24.05, 21.73,
  19.39, 17.92, 17.30, 17.27, 16.66, 15.98, 15.31, 14.64, 14.09, 13.14, 12.08,
  11.56, 11.17, 11.36, 11.69, 12.50, 13.67, 15.70, 17.91, 20.78, 24.17, 28.69,
  33.54, 39.06, 44.62, 50.14, 56.64, 64.63, 72.15, 77.85, 79.96, 78.77, 76.51,
  71.87, 63.29, 51.71, 40.08, 30.15, 22.27, 16.57, 12.67, 10.02, 7.98, 6.35,
  5.27, 4.22, 3.43, 2.82, 2.31, 1.88, 1.53, 1.21, 1.03, 0.91, 0.57, 0.69,
  0.46, 0.46, 0.36, 0.33, 0.16, 0.21, 0.17, 0.20, 0.11, 0.14, 0.06, 0.01,
  0.04, 0.13, 0.03, 0.03, 0.04, 0.04, 0.07, 0.03, 0.01, 0.01, -0.02, 0.02,
  0.11, 0.01, 0.02, 0.12, 0.02, 0.07, -0.01, 0.09, 0.02, 0.19, 0.07, 0.01,
  0.05, 0.13, 0.01, 0.09, 0.02, 0.00, -0.02, 0.09, 0.03, -0.05, 0.05, -0.05,
  0.05, -0.00, -0.00, 0.05, -0.02, 0.02, 0.08,
];

// Normalize to [0, 1] for the SVG mapping; the receiver-noise animation layers
// on top of this baseline shape per frame.
const SURVEY_PEAK_K = SURVEY_TB_K.reduce((m, v) => (v > m ? v : m), 0);
const SURVEY_POWER: number[] = SURVEY_TB_K.map((v) => Math.max(0, v) / SURVEY_PEAK_K);

// Frequency-axis mapping. Display range hugs the data span (±80 km/s ≈
// ±0.38 MHz around the rest line) so the trace fills the chart, with just
// enough padding to land round-numbered tick labels on the axis.
const H1_REST_MHZ = 1420.4058;
const DISPLAY_MIN_MHZ = 1420.0;
const DISPLAY_MAX_MHZ = 1420.8;
const DISPLAY_SPAN_MHZ = DISPLAY_MAX_MHZ - DISPLAY_MIN_MHZ;
const C_KM_S = 299792.458;
const SURVEY_V_START = -80;
const SURVEY_V_STEP = 160 / (SURVEY_TB_K.length - 1);
// Higher frequency on the left (blueshifted), lower on the right (redshifted)
// — the standard convention used by SDR spectrum tools.
const fToX = (f: number) => ((DISPLAY_MAX_MHZ - f) / DISPLAY_SPAN_MHZ) * HW;
const vToX = (v: number) => fToX(H1_REST_MHZ * (1 - v / C_KM_S));
const indexToX = (i: number) => vToX(SURVEY_V_START + i * SURVEY_V_STEP);
const SURVEY_X_START = indexToX(0);
const SURVEY_X_END   = indexToX(SURVEY_TB_K.length - 1);

const SURVEY_PEAK_X = (() => {
  let idx = 0;
  for (let i = 0; i < SURVEY_POWER.length; i++) if (SURVEY_POWER[i] > SURVEY_POWER[idx]) idx = i;
  return indexToX(idx);
})();

// Frequency tick labels placed at round 0.2 MHz intervals across the display.
const FREQ_TICKS_MHZ = [1420.0, 1420.2, 1420.4, 1420.6, 1420.8];

// Observation spectrum: 680×200, three peaks at different velocities
const OW = 680, OBASE = 142;
const OBS_APP_FILL  = gaussianFill(190, 32, 74, OBASE, OW);
const OBS_APP_LINE  = gaussianLine(190, 32, 74, OBASE, OW);
const OBS_REST_FILL = gaussianFill(340, 26, 38, OBASE, OW);
const OBS_REST_LINE = gaussianLine(340, 26, 38, OBASE, OW);
const OBS_REC_FILL  = gaussianFill(490, 38, 82, OBASE, OW);
const OBS_REC_LINE  = gaussianLine(490, 38, 82, OBASE, OW);
const OBS_NOISE     = noiseFloor(OBASE, OW, 6);

// ─── SVG components ────────────────────────────────────────────────────────────

// Build the SVG path data for one playback frame. `smoothed` is the current
// (noisy, integrating) power-per-bin estimate; we walk it across HW pixels and
// emit a polyline path plus a matching filled-area path.
function buildHeroPaths(smoothed: number[]): { line: string; fill: string } {
  const n = smoothed.length;
  const linePts: string[] = [];
  for (let i = 0; i < n; i++) {
    const x = indexToX(i);
    const y = HERO_BASE_Y - smoothed[i] * HERO_PEAK_PX;
    linePts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const line = `M ${linePts.join(' L ')}`;
  // The fill anchors to the baseline at the data's own x bounds, not the SVG
  // edges, so the gradient doesn't smear out into the blank wings.
  const fill = `M ${SURVEY_X_START.toFixed(1)},${HERO_BASE_Y} L ${linePts.join(' L ')} L ${SURVEY_X_END.toFixed(1)},${HERO_BASE_Y} Z`;
  return { line, fill };
}

// Box-Muller-ish cheap noise. We don't need true Gaussian — just symmetric,
// zero-mean fluctuations that look like SDR receiver noise on a quiet band.
function noiseSample(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * (2 / 3);
}

function useVisibleAnimation<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [active, setActive] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let inView = true;
    let tabVisible = document.visibilityState === 'visible';
    const update = () => setActive(inView && tabVisible);

    const onVisibilityChange = () => {
      tabVisible = document.visibilityState === 'visible';
      update();
    };

    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    }, { threshold: 0.01 });

    document.addEventListener('visibilitychange', onVisibilityChange);
    observer.observe(el);
    update();

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
    };
  }, []);

  return [ref, active] as const;
}

function HeroSpectrum() {
  // Live trace = survey shape + per-frame noise, lightly low-passed across
  // frames so the line breathes instead of strobing. Smoothing constant α
  // governs how quickly noise integrates away — 0.18 looks visibly "live"
  // while still letting the underlying peaks read clearly.
  const smoothedRef = useRef<number[]>(SURVEY_POWER.map(() => 0));
  const rafRef = useRef<number | null>(null);
  const [svgRef, animationActive] = useVisibleAnimation<SVGSVGElement>();
  const [paths, setPaths] = useState(() => buildHeroPaths(smoothedRef.current));

  useEffect(() => {
    if (!animationActive) return;

    let lastTs = 0;
    // Cap repaints near 24 fps — a 60 Hz update on a decorative panel would
    // burn battery on the queue page for no visible benefit.
    const minIntervalMs = 1000 / 24;
    const alpha = 0.18;
    const noiseAmp = 0.07;

    const tick = (ts: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (ts - lastTs < minIntervalMs) return;
      lastTs = ts;
      const prev = smoothedRef.current;
      const next = new Array<number>(SURVEY_POWER.length);
      for (let i = 0; i < SURVEY_POWER.length; i++) {
        const target = SURVEY_POWER[i] + noiseSample() * noiseAmp;
        next[i] = prev[i] + (target - prev[i]) * alpha;
      }
      smoothedRef.current = next;
      setPaths(buildHeroPaths(next));
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [animationActive]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 600 144"
      className="h1-svg"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="h1HeroGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#ffbc42" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[30, 55, 80, 105].map(y => (
        <line key={y} x1="0" y1={y} x2={HW} y2={y} stroke="#1a1d2e" strokeWidth="1" />
      ))}
      {FREQ_TICKS_MHZ.map(f => (
        <line key={f} x1={fToX(f)} y1="0" x2={fToX(f)} y2="115" stroke="#1a1d2e" strokeWidth="1" />
      ))}
      <path d={paths.fill}  fill="url(#h1HeroGrad)" />
      <path d={paths.line}  fill="none" stroke="#ffbc42" strokeWidth="2.5" strokeLinejoin="round" />
      <line x1={fToX(H1_REST_MHZ)} y1="6" x2={fToX(H1_REST_MHZ)} y2="115" stroke="#ffbc42" strokeWidth="1" strokeDasharray="4,3" opacity="0.45" />
      {/* Doppler-shifted peak marker — the Perseus-arm gas in this sightline
          is moving toward us at ~50 km/s, shifting its emission well to the
          blue side of the 1420.4 MHz rest line. */}
      <line
        x1={SURVEY_PEAK_X} y1="6" x2={SURVEY_PEAK_X} y2="115"
        stroke="#5ba4f5" strokeWidth="1" strokeDasharray="3,3" opacity="0.7"
      />
      <a href="#h1-doppler-section">
        <title>This peak is offset from 1420.4 MHz — that's the Doppler effect. Click to learn more.</title>
        <text
          x={SURVEY_PEAK_X + 6} y="14"
          fill="#5ba4f5" fontSize="10"
          fontFamily="ui-monospace,monospace"
          style={{ cursor: 'pointer', textDecoration: 'underline' }}
        >
          what's this?
        </text>
      </a>
      <line x1="0" y1="115" x2={HW} y2="115" stroke="#232640" strokeWidth="1" />
      {FREQ_TICKS_MHZ.map(f => {
        const isRest = Math.abs(f - 1420.4) < 0.001;
        return (
          <text
            key={f}
            x={fToX(f)} y="129"
            textAnchor="middle"
            fill={isRest ? '#9b9ece' : '#5a5d80'}
            fontSize={isRest ? 11 : 10}
            fontFamily="ui-monospace,monospace"
          >
            {f.toFixed(1)}
          </text>
        );
      })}
      <text x={HW / 2} y="138" textAnchor="middle" fill="#3a3f5e" fontSize="9" fontFamily="ui-monospace,monospace">MHz</text>
    </svg>
  );
}

// ─── Doppler animation ────────────────────────────────────────────────────────
//
// Geometric Doppler illustration: a source oscillates back and forth on the
// right, emitting circular wavefronts that expand at speed C. Because each
// wavefront is centred on where the source *was* at emission time, consecutive
// wavefronts' leftmost edges bunch up when the source is approaching the
// telescope (blueshift) and spread apart when it's receding (redshift). The
// sine wave drawn from source to telescope has its crests pinned to those
// leftmost edges via segment-by-segment phase interpolation, so the local
// wavelength varies along the path. A mini spectrum below the scene tracks
// the frequency *actually arriving at the telescope right now* — accounting
// for the light-travel delay, so the peak position lags slightly behind the
// source's instantaneous motion.

const DA_W = 600;
const DA_H = 360;                   // total SVG height (scene + mini spectrum)
const DA_AXIS_Y = 108;              // y of horizontal axis through source
const DA_TELESCOPE_X = 64;          // x of dish centre
const DA_DISH_BACK_X = DA_TELESCOPE_X - 0.5;
const DA_DISH_FEED_X = DA_TELESCOPE_X + 26;
const DA_SOURCE_CENTER_X = 380;     // mean x position of source
const DA_C_PX_S = 94;               // wavefront expansion speed (px/s)
const DA_T_EMIT_S = 0.78;           // seconds between successive emissions
const DA_MAX_R = 360;               // wavefront fade-out radius
const DA_WAVE_AMP = 14;             // sine-wave amplitude in px

// Velocity profile. Pure sin never lets the shift "settle"; tanh-shaped sin
// has the right dwell but transitions through zero too quickly. We instead
// build a piecewise profile with explicit dwell periods at ±V_MAX and cubic
// smoothstep transitions between them. That way the spectrum's peak holds
// rock-steady at full blue (or red) for several seconds, then slides
// continuously across the rest line to the other side.
const DA_V_MAX = 22;          // dwell speed (px/s); must be < C for physical sanity
const DA_DWELL_S = 5;         // seconds of constant-velocity dwell each direction
const DA_TRANS_S = 4;         // seconds of smooth transition between dwells
const DA_T_OSC_S = 2 * DA_DWELL_S + 2 * DA_TRANS_S; // full back-and-forth period

const vTowardAt = (time: number) => {
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

const sourceXAt = (time: number) => {
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
const DA_MINI_LEFT_X = 96;
const DA_MINI_W = 408;
const DA_MINI_CX = DA_MINI_LEFT_X + DA_MINI_W / 2;
const DA_MINI_TOP_Y = 232;             // panel top
const DA_MINI_HEADER_Y = 246;          // "telescope receives" label baseline
const DA_MINI_PLOT_TOP_Y = 256;        // top of plottable region
const DA_MINI_BASE_Y = 336;            // baseline / x-axis y
const DA_MINI_PLOT_LEFT_X = DA_MINI_LEFT_X + 12;
const DA_MINI_PLOT_RIGHT_X = DA_MINI_LEFT_X + DA_MINI_W - 12;
const DA_MINI_PLOT_W = DA_MINI_PLOT_RIGHT_X - DA_MINI_PLOT_LEFT_X;
const DA_MINI_PEAK_PX = 68;            // peak height above baseline (px)
const DA_MINI_PEAK_SIGMA = 17;         // gaussian sigma of the underlying peak
const DA_MINI_BINS = 110;              // resolution of the noisy trace
const DA_MINI_NOISE_AMP = 0.07;        // matches hero spectrum receiver-noise feel
const DA_MINI_NOISE_TAU_S = 0.08;      // smoothing time constant (s)
// Half-range narrower so the peak slides within ~half the panel rather than
// nearly the full width.
const DA_MINI_HALF_RANGE = (DA_MINI_W / 2 - 36) * 0.55;

const dopplerColor = (vFrac: number): string => {
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

// Solve for the time at which the wave currently arriving at x = TELESCOPE_X
// was emitted. Source motion is periodic and sourceXAt wraps for negative
// arguments, so we can search arbitrarily far back in time — there's no
// startup transient where "no wave has reached the dish yet". Monotonicity of
// lhs in `emit` is guaranteed by |v_toward| < C, so binary search converges.
function findEmitTimeAtTelescope(t: number): number {
  let lo = t - DA_MAX_R / DA_C_PX_S;
  let hi = t;
  for (let k = 0; k < 26; k++) {
    const mid = (lo + hi) / 2;
    const lhs = sourceXAt(mid) - DA_C_PX_S * (t - mid);
    if (lhs > DA_TELESCOPE_X) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function TelescopeIllustration({ cx, cy }: { cx: number; cy: number }) {
  const col = '#7478a8';
  return (
    <g
      transform={`translate(${cx}, ${cy})`}
      fill="none"
      stroke={col}
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity="0.76"
    >
      <path d="M 15,-34 Q -16,0 15,34" strokeWidth="3" />
      <line x1="15" y1="-25" x2="26" y2="0" strokeWidth="1.6" opacity="0.55" />
      <line x1="15" y1="25" x2="26" y2="0" strokeWidth="1.6" opacity="0.55" />
      <circle cx="26" cy="0" r="3.5" fill={col} stroke="none" opacity="0.72" />
    </g>
  );
}

function DopplerAnimation() {
  const [now, setNow] = useState(0);
  const startRef = useRef(0);
  const [svgRef, animationActive] = useVisibleAnimation<SVGSVGElement>();
  // Smoothed noisy bin values for the mini spectrum trace. Updated in the rAF
  // loop so render stays a pure function of `now` plus this ref.
  const miniBinsRef = useRef<number[]>(new Array(DA_MINI_BINS).fill(0));

  useEffect(() => {
    if (!animationActive) return;

    let raf = 0;
    let lastTickT = 0;
    let lastPaintTs = 0;
    const minIntervalMs = 1000 / 30;
    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (ts - lastPaintTs < minIntervalMs) return;
      lastPaintTs = ts;

      if (!startRef.current) startRef.current = ts;
      const newT = (ts - startRef.current) / 1000;

      // Update the mini spectrum bins: gaussian peak centered on the
      // delayed-reception velocity, perturbed by per-frame receiver noise and
      // low-passed across frames so the trace breathes rather than strobes.
      const dt = Math.max(0.001, Math.min(0.1, newT - lastTickT));
      lastTickT = newT;
      const alpha = 1 - Math.exp(-dt / DA_MINI_NOISE_TAU_S);
      const emitTAtDish = findEmitTimeAtTelescope(newT);
      const vReceived = vTowardAt(emitTAtDish);
      const peakCenter = DA_MINI_CX - (vReceived / DA_V_MAX) * DA_MINI_HALF_RANGE;
      const prev = miniBinsRef.current;
      const next = new Array<number>(DA_MINI_BINS);
      for (let i = 0; i < DA_MINI_BINS; i++) {
        const x = DA_MINI_PLOT_LEFT_X + (i / (DA_MINI_BINS - 1)) * DA_MINI_PLOT_W;
        const dx = x - peakCenter;
        const peakNorm = Math.exp(-0.5 * (dx / DA_MINI_PEAK_SIGMA) ** 2);
        const target = peakNorm + noiseSample() * DA_MINI_NOISE_AMP;
        next[i] = prev[i] + (target - prev[i]) * alpha;
      }
      miniBinsRef.current = next;

      setNow(newT);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animationActive]);

  const t = now;
  const sourceX = sourceXAt(t);
  const vToward = vTowardAt(t); // positive when source approaches telescope

  // Active wavefronts. Iterate just the indices whose age is in [0, MAX_R/C].
  const ageMax = DA_MAX_R / DA_C_PX_S;
  const firstI = Math.ceil((t - ageMax) / DA_T_EMIT_S);
  const lastI = Math.floor(t / DA_T_EMIT_S);
  const wfs: Array<{ emitT: number; cx: number; r: number; L: number; opacity: number }> = [];
  for (let i = firstI; i <= lastI; i++) {
    const emitT = i * DA_T_EMIT_S;
    const age = t - emitT;
    const r = age * DA_C_PX_S;
    if (r > DA_MAX_R) continue;
    const emitX = sourceXAt(emitT);
    const fade = 1 - Math.max(0, r - DA_MAX_R * 0.55) / (DA_MAX_R * 0.45);
    wfs.push({ emitT, cx: emitX, r, L: emitX - r, opacity: Math.max(0, fade) * 0.55 });
  }
  // Order by leftmost-edge x ascending — equivalent to oldest-first under our
  // motion model, and the order the wave-path interpolator expects.
  wfs.sort((a, b) => a.L - b.L);

  // Build the sine-wave path from telescope to source by solving the
  // wave-propagation equation per pixel:
  //
  //   sourceXAt(emitT) - C·(t - emitT) = x
  //
  // i.e. "what emission time produces a wavefront whose leftmost edge is at x
  // right now?" That equation is monotonic in emitT because v_toward < C, so a
  // binary search converges fast. The wave field at (x, t) is then the source
  // signal *at* emitT — `cos(2π · emitT / T_EMIT)` — which puts crests
  // exactly on the leftmost edges of the integer-emission wavefronts (since
  // those occur when emitT is a multiple of T_EMIT). Local wavelength
  // naturally compresses where the source was approaching at that emit time
  // and stretches where it was receding, with no per-frame phase wobble.
  const waveStart = DA_DISH_FEED_X;
  const waveEnd = sourceX - 54;
  const wavePts: Array<{ x: number; y: number; emitT: number }> = [];
  if (waveEnd > waveStart) {
    const emitLo = t - DA_MAX_R / DA_C_PX_S;
    const lhsLo = sourceXAt(emitLo) - DA_C_PX_S * (t - emitLo);
    for (let x = waveStart; x <= waveEnd; x += 1.5) {
      // Skip pixels the oldest tracked wavefront hasn't reached yet.
      if (x < lhsLo) continue;
      let lo = emitLo;
      let hi = t;
      for (let k = 0; k < 22; k++) {
        const mid = (lo + hi) / 2;
        const lhs = sourceXAt(mid) - DA_C_PX_S * (t - mid);
        if (lhs > x) hi = mid;
        else lo = mid;
      }
      const emitT = (lo + hi) / 2;
      // Mod into [0,1) before multiplying by 2π to keep float precision sharp
      // for long sessions; cos is periodic so this is exact.
      const phaseFrac = ((emitT / DA_T_EMIT_S) % 1 + 1) % 1;
      const y = DA_AXIS_Y - DA_WAVE_AMP * Math.cos(2 * Math.PI * phaseFrac);
      wavePts.push({ x, y, emitT });
    }
  }
  const waveSegments = wavePts.slice(1).map((pt, i) => {
    const prev = wavePts[i];
    const emitMid = (prev.emitT + pt.emitT) / 2;
    return {
      d: `M ${prev.x.toFixed(1)},${prev.y.toFixed(1)} L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`,
      color: dopplerColor(vTowardAt(emitMid) / DA_C_PX_S),
    };
  });
  const receivedSignalColor = dopplerColor(vTowardAt(findEmitTimeAtTelescope(t)) / DA_C_PX_S);

  // Build the mini spectrum trace from the smoothed bin values updated in the
  // rAF loop.
  const miniBins = miniBinsRef.current;
  const miniPts: string[] = new Array(DA_MINI_BINS);
  for (let i = 0; i < DA_MINI_BINS; i++) {
    const x = DA_MINI_PLOT_LEFT_X + (i / (DA_MINI_BINS - 1)) * DA_MINI_PLOT_W;
    const y = DA_MINI_BASE_Y - miniBins[i] * DA_MINI_PEAK_PX;
    miniPts[i] = `${x.toFixed(1)},${y.toFixed(1)}`;
  }
  const miniLine = `M ${miniPts.join(' L ')}`;
  const miniFill =
    `M ${DA_MINI_PLOT_LEFT_X.toFixed(1)},${DA_MINI_BASE_Y} ` +
    `L ${miniPts.join(' L ')} ` +
    `L ${DA_MINI_PLOT_RIGHT_X.toFixed(1)},${DA_MINI_BASE_Y} Z`;

  // Source velocity arrow — direction follows current motion.
  const arrowDir = vToward > 0 ? -1 : 1; // -1 = pointing left
  const arrowLen = Math.min(58, Math.abs(vToward) * 1.9);
  const arrowStartX = sourceX + arrowDir * 11;
  const arrowEndX = sourceX + arrowDir * (11 + arrowLen);
  const arrowY = DA_AXIS_Y + 38;
  const radialVelocity = -vToward;
  const velocityLabel =
    Math.abs(radialVelocity) < 0.05
      ? '0.0 km/s'
      : `${radialVelocity > 0 ? '+' : '-'}${Math.abs(radialVelocity).toFixed(1)} km/s`;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${DA_W} ${DA_H}`}
      className="h1-svg"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {wfs.map((w, i) => (
        <circle
          key={i}
          cx={w.cx}
          cy={DA_AXIS_Y}
          r={w.r}
          fill="none"
          stroke="#3a4068"
          strokeWidth="1"
          opacity={w.opacity}
        />
      ))}

      {waveSegments.map((segment, i) => (
        <path
          key={i}
          d={segment.d}
          fill="none"
          stroke={segment.color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      <Cloud
        x={sourceX - 58}
        y={DA_AXIS_Y - 39}
        width="116"
        height="87"
        fill="#ffbc42"
        fillOpacity="0.18"
        color="#ffd273"
        strokeWidth="1.2"
        opacity="0.82"
      />
      <text
        x={sourceX - 9}
        y={DA_AXIS_Y + 10}
        textAnchor="middle"
        fill="#ffd273"
        fontSize="20"
        fontWeight="800"
        fontFamily="ui-monospace,monospace"
        opacity="0.82"
      >
        H
      </text>

      {arrowLen > 4 && (
        <g>
          <line
            x1={arrowStartX} y1={arrowY}
            x2={arrowEndX}   y2={arrowY}
            stroke="#9b9ece" strokeWidth="2"
          />
          <polyline
            points={`${arrowEndX},${arrowY} ${arrowEndX - arrowDir * 6},${arrowY - 4} ${arrowEndX - arrowDir * 6},${arrowY + 4}`}
            fill="#9b9ece" stroke="none"
          />
        </g>
      )}

      <g transform={`translate(${sourceX}, ${arrowY + 22})`}>
        <rect
          x="-66"
          y="-16"
          width="132"
          height="35"
          rx="4"
          fill="#0c0f1c"
          stroke="#1d2138"
          opacity="0.92"
        />
        <text
          x="0"
          y="-4"
          textAnchor="middle"
          fill="#9699c8"
          fontSize="8.5"
          fontWeight="700"
          letterSpacing="0.08em"
        >
          RELATIVE VELOCITY
        </text>
        <text
          x="0"
          y="13"
          textAnchor="middle"
          fill="#e0e3ff"
          fontSize="13"
          fontWeight="700"
          fontFamily="ui-monospace,monospace"
        >
          {velocityLabel}
        </text>
      </g>

      {/* Signal cable from the back of the dish into the side of the spectrum panel. */}
      <path
        d={`M ${DA_DISH_BACK_X},${DA_AXIS_Y} V ${DA_MINI_TOP_Y + 26} H ${DA_MINI_LEFT_X}`}
        fill="none"
        stroke="#555a82"
        strokeWidth="1.2"
        strokeDasharray="3,5"
        opacity="0.42"
      />
      {/* Connection dot at panel entry */}
      <circle cx={DA_MINI_LEFT_X} cy={DA_MINI_TOP_Y + 26} r="2" fill="#555a82" opacity="0.42" />

      <TelescopeIllustration cx={DA_TELESCOPE_X} cy={DA_AXIS_Y} />

      {/* ── Mini spectrum ─────────────────────────────────────────────────── */}
      <defs>
        <linearGradient id="daMiniGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={receivedSignalColor} stopOpacity="0.22" />
          <stop offset="100%" stopColor={receivedSignalColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect
        x={DA_MINI_LEFT_X} y={DA_MINI_TOP_Y}
        width={DA_MINI_W} height={DA_MINI_BASE_Y - DA_MINI_TOP_Y + 18}
        fill="#0c0f1c" stroke="#1d2138" rx="4"
      />
      <text
        x={DA_MINI_LEFT_X + 12} y={DA_MINI_HEADER_Y}
        fill="#6f719a" fontSize="10" fontWeight="600"
        letterSpacing="0.08em"
      >
        Telescope Sees
      </text>
      {/* Horizontal gridlines, matching the hero spectrum's spacing. */}
      {[0.25, 0.5, 0.75].map((f) => {
        const y = DA_MINI_PLOT_TOP_Y + f * (DA_MINI_BASE_Y - DA_MINI_PLOT_TOP_Y);
        return (
          <line
            key={f}
            x1={DA_MINI_LEFT_X + 8} y1={y}
            x2={DA_MINI_LEFT_X + DA_MINI_W - 8} y2={y}
            stroke="#1a1d2e" strokeWidth="1"
          />
        );
      })}
      {/* Vertical gridlines at the same fractional positions as the hero
          spectrum's MHz ticks (1420.0, 1420.2, 1420.4, 1420.6, 1420.8). */}
      {[0.125, 0.375, 0.5, 0.625, 0.875].map((f) => {
        const x = DA_MINI_LEFT_X + 12 + f * (DA_MINI_W - 24);
        return (
          <line
            key={f}
            x1={x} y1={DA_MINI_PLOT_TOP_Y}
            x2={x} y2={DA_MINI_BASE_Y}
            stroke="#1a1d2e" strokeWidth="1"
          />
        );
      })}
      {/* Rest-frequency dashed marker, matching the hero amber line. */}
      <line
        x1={DA_MINI_CX} y1={DA_MINI_PLOT_TOP_Y}
        x2={DA_MINI_CX} y2={DA_MINI_BASE_Y}
        stroke="#ffbc42" strokeWidth="1" strokeDasharray="4,3" opacity="0.45"
      />
      {/* Baseline / x-axis. */}
      <line
        x1={DA_MINI_LEFT_X + 8} y1={DA_MINI_BASE_Y}
        x2={DA_MINI_LEFT_X + DA_MINI_W - 8} y2={DA_MINI_BASE_Y}
        stroke="#232640" strokeWidth="1"
      />
      <path d={miniFill} fill="url(#daMiniGrad)" />
      <path
        d={miniLine}
        fill="none"
        stroke={receivedSignalColor}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* Tick labels along the axis. */}
      <text
        x={DA_MINI_LEFT_X + 12} y={DA_MINI_BASE_Y + 14}
        fill="#5ba4f5" fontSize="10"
      >
        blueshift ←
      </text>
      <text
        x={DA_MINI_CX} y={DA_MINI_BASE_Y + 14}
        textAnchor="middle" fill="#9b9ece" fontSize="11"
        fontFamily="ui-monospace,monospace"
      >
        1420.4 MHz
      </text>
      <text
        x={DA_MINI_LEFT_X + DA_MINI_W - 12} y={DA_MINI_BASE_Y + 14}
        textAnchor="end" fill="#ff7a4d" fontSize="10"
      >
        → redshift
      </text>
    </svg>
  );
}

function ObservationSpectrum() {
  const appX = 190, restX = 340, recX = 490, axisY = 152;
  return (
    <svg
      viewBox={`0 0 ${OW} 200`}
      className="h1-svg h1-svg-wide"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="h1AppGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#5ba4f5" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#5ba4f5" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="h1RestGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#ffbc42" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="h1RecGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#ff7a4d" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ff7a4d" stopOpacity="0" />
        </linearGradient>
      </defs>

      {[40, 80, 120].map(y => (
        <line key={y} x1="0" y1={y} x2={OW} y2={y} stroke="#1a1d2e" strokeWidth="1" />
      ))}

      <line x1={restX} y1="0" x2={restX} y2={axisY} stroke="#ffbc42" strokeWidth="1" strokeDasharray="5,4" opacity="0.35" />
      <path d={OBS_NOISE}    fill="none" stroke="#252840" strokeWidth="1.5" />
      <path d={OBS_APP_FILL}  fill="url(#h1AppGrad)" />
      <path d={OBS_REST_FILL} fill="url(#h1RestGrad)" />
      <path d={OBS_REC_FILL}  fill="url(#h1RecGrad)" />
      <path d={OBS_APP_LINE}  fill="none" stroke="#5ba4f5" strokeWidth="2" />
      <path d={OBS_REST_LINE} fill="none" stroke="#ffbc42" strokeWidth="1.5" />
      <path d={OBS_REC_LINE}  fill="none" stroke="#ff7a4d" strokeWidth="2" />

      <line x1="0" y1={axisY} x2={OW} y2={axisY} stroke="#232640" strokeWidth="1" />

      <line x1={appX}  y1={OBASE - 74} x2={appX}  y2={axisY + 8} stroke="#5ba4f5" strokeWidth="1" opacity="0.4" />
      <line x1={restX} y1={OBASE - 38} x2={restX} y2={axisY + 8} stroke="#ffbc42" strokeWidth="1" opacity="0.35" />
      <line x1={recX}  y1={OBASE - 82} x2={recX}  y2={axisY + 8} stroke="#ff7a4d" strokeWidth="1" opacity="0.4" />

      <text x={appX}  y={axisY + 22} textAnchor="middle" fill="#5ba4f5" fontSize="12" fontWeight="600">Approaching gas</text>
      <text x={appX}  y={axisY + 36} textAnchor="middle" fill="#8ab4d8" fontSize="10">moving toward us</text>

      <text x={restX} y={axisY + 22} textAnchor="middle" fill="#c8a872" fontSize="11">rest frequency</text>
      <text x={restX} y={axisY + 36} textAnchor="middle" fill="#9b9ece" fontSize="10" fontFamily="ui-monospace,monospace">1420.4 MHz</text>

      <text x={recX}  y={axisY + 22} textAnchor="middle" fill="#ff7a4d" fontSize="12" fontWeight="600">Receding gas</text>
      <text x={recX}  y={axisY + 36} textAnchor="middle" fill="#cc8c6e" fontSize="10">moving away from us</text>
    </svg>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  status: QueueStatus | null;
  joining: boolean;
  joinError: string | null;
  siteKey: string | null;
  turnstileEnabled: boolean;
  onJoin: (token: string | null) => Promise<void>;
  hasControl: boolean;
  onContinue: () => void;
}

export function QueuePage({
  status, joining, joinError, siteKey, turnstileEnabled, onJoin, hasControl, onContinue,
}: Props) {
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const autoJoinedTokenRef = useRef<string | null>(null);
  const inQueue = (status?.position ?? -1) >= 0;

  useEffect(() => {
    if (!turnstileEnabled) return;
    if (inQueue || joining) return;
    if (!captchaToken) return;
    if (autoJoinedTokenRef.current === captchaToken) return;
    autoJoinedTokenRef.current = captchaToken;
    void onJoin(captchaToken);
  }, [captchaToken, turnstileEnabled, inQueue, joining, onJoin]);

  useEffect(() => {
    if (!joinError || !turnstileEnabled) return;
    autoJoinedTokenRef.current = null;
    setCaptchaToken(null);
    if (window.turnstile && widgetIdRef.current) window.turnstile.reset(widgetIdRef.current);
  }, [joinError, turnstileEnabled]);

  // Mount the Turnstile widget inline into the queue card. Previously this
  // lived in a separate full-screen modal, which made it look like the
  // captcha had popped up "on another screen" rather than being part of the
  // join flow itself.
  useEffect(() => {
    if (inQueue || !turnstileEnabled || !siteKey) return;
    const renderWidget = () => {
      if (!widgetRef.current || !window.turnstile || widgetIdRef.current) return;
      widgetIdRef.current = window.turnstile.render(widgetRef.current, {
        sitekey: siteKey,
        callback: (token: string) => setCaptchaToken(token),
        'error-callback': () => setCaptchaToken(null),
        'expired-callback': () => setCaptchaToken(null),
      });
    };
    if (window.turnstile) { renderWidget(); return; }
    window.onloadTurnstileCallback = renderWidget;
    let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement('script');
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }, [inQueue, turnstileEnabled, siteKey]);

  // Non-turnstile flow: nothing to verify, so a plain landing page is fine.
  if (!inQueue && !turnstileEnabled) {
    return (
      <div className="queue-landing">
        <div className="queue-card">
          <h1>Radio Telescope</h1>
          <p>This telescope is shared with other users. Join the queue to take control.</p>
          <button className="action-button" disabled={joining} onClick={() => void onJoin(null)}>
            {joining ? 'Joining…' : 'Join queue'}
          </button>
          {joinError && <p className="banner banner-error">{joinError}</p>}
        </div>
      </div>
    );
  }

  // Turnstile flow + still-joining: render the full waiting page underneath
  // so the captcha modal opens on top of the same UI the user will see once
  // they're in the queue, rather than a near-empty landing card.

  return (
    <div className="queue-waiting">
      <header className="queue-header">
        <div className="queue-header-inner">
          <div className="queue-header-title">
            <h1>{inQueue ? 'You are in the queue' : 'Joining the queue'}</h1>
            <p className="queue-header-sub">
              {inQueue
                ? "As a demo, only one observer can be in control at a time. While you wait, learn more about what you'll be observing below!"
                : 'Complete the quick verification to take your place in line.'}
            </p>
          </div>
          <div className="queue-header-status">
            <span className="queue-header-label">Position</span>
            <strong className="queue-header-position">
              {inQueue ? `#${status!.position}` : '—'}
            </strong>
            {inQueue && status!.queue_length > 0 && (
              <span className="queue-header-waiting">{status!.queue_length} waiting</span>
            )}
          </div>
          {inQueue && hasControl && (
            <button className="action-button" onClick={onContinue}>
              Continue to telescope
            </button>
          )}
        </div>
      </header>

      <main className="h1-page">

        {/* ── Hero ──────────────────────────────────────────────────────────── */}
        <section className="h1-hero">
          <div className="h1-hero-inner">
            <div className="h1-hero-text">
              <span className="h1-eyebrow">What is it?</span>
              <h2 className="h1-hero-title">The Hydrogen Line</h2>
              <p className="h1-hero-sub">In the 1930's, while working at Bell Labs during it's formative years, Karl G. Jansky was tasked with identifying sources of radio noise which could interefere with overseas radio communication (a bleeding edge technology at the time). Among more mundane sources like thunderstorms, Jansky observed a peculiar background "hiss" of unknown origin which seemed to cycle in intensity once per day, leading Jansky to assume this noise originated from the sun. However, after a few more months of observation, the point of maximum "static" had noticibly shifted from the position of the sun. Recognizing that he was at the edge of his expertise as a radio engineer, Janksky discussed the puzzle with his friend and astrophysicist Albert Melvin Skellett, who pointed out that the now refined 23 hours and 56 minute period of the signal was the exact length of a sidereal day.</p>
            </div>
            <div className="h1-hero-visual">
              <HeroSpectrum />
              <p className="h1-visual-caption">
                Neutral hydrogen 1420.4 MHz emission, looking outward through the galactic disk
                (l = 110°, b = 0°). LAB all-sky survey, Kalberla et al. 2005.
              </p>
            </div>
          </div>
        </section>

        {/* ── Spin-flip section ─────────────────────────────────────────────── */}
        <section className="h1-spinflip">
          <div className="h1-spinflip-inner">
            <div className="h1-spinflip-text">
              <h2 className="h1-section-heading">The spin-flip transition</h2>
              <p className="h1-section-body">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
              <p className="h1-section-body">Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.</p>
            </div>
            <div className="h1-spinflip-visual">
              {/* Animation goes here */}
            </div>
          </div>
        </section>

        {/* ── Doppler section ───────────────────────────────────────────────── */}
        <section className="h1-doppler" id="h1-doppler-section">
          <div className="h1-doppler-inner">
            <div className="h1-doppler-text">
              <h2 className="h1-section-heading">The Doppler Effect</h2>
              <p className="h1-section-body">Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.</p>
              <p className="h1-section-body">Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt. Neque porro quisquam est qui dolorem ipsum quia dolor sit amet.</p>
            </div>
            <div className="h1-doppler-visual">
              <DopplerAnimation />
              <p className="h1-visual-caption">
                The relative velocity of hydrogen gas along our line of sight shifts the observed frequency: approaching gas is blueshifted, receding gas is redshifted.
              </p>
            </div>
          </div>
        </section>

        {/* ── Observation section ───────────────────────────────────────────── */}
        <section className="h1-observe">
          <div className="h1-observe-inner">
            <h2 className="h1-section-heading">What you'll see in the spectrum</h2>
            <p className="h1-section-body">Lorem ipsum dolor sit amet, consectetur adipiscing elit. At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.</p>
            <div className="h1-observe-visual">
              <ObservationSpectrum />
            </div>
            <p className="h1-visual-caption">
              Multiple peaks appear when the beam passes through gas clouds moving at different radial velocities — each peak is a separate arm of the galaxy
            </p>
          </div>
        </section>


      </main>

      {!inQueue && turnstileEnabled && (
        <div className="captcha-modal-overlay">
          <div className="captcha-modal">
            <div className="captcha-modal-header">
              <h2>Verify to join</h2>
            </div>
            <p className="captcha-modal-body">Complete the check below to join the queue.</p>
            <div className="cf-turnstile" ref={widgetRef} />
            <p className="queue-status-line">
              {joining
                ? 'Joining…'
                : captchaToken
                  ? 'Verified — joining queue…'
                  : 'Waiting for verification…'}
            </p>
            {joinError && <p className="banner banner-error">{joinError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

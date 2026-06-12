import { memo, useEffect, useRef, useState } from 'react';
import { HydrogenAtomDepiction } from './HydrogenAtom';
import type { FormEvent, ReactNode } from 'react';
import { Cloud } from 'lucide-react';

import queueSpectrumRaw from '../data/queueSpectrum.txt?raw';
import type { QueueStatus } from '../queue';
import type { TelescopeStatus } from '../types';
import { StarsBackground } from './StarsBackground';
import { QueueFooter } from './QueueFooter';

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
const MISLEADING_POPOVER_WIDTH = 260;
const MISLEADING_POPOVER_HEIGHT = 245;
const MISLEADING_POPOVER_GAP = 10;
const MISLEADING_POPOVER_MARGIN = 12;
const SPECTRAL_LINES_POPOVER_HEIGHT = 142;
const STICKY_HEADER_ANIMATION_MARGIN_PX = 96;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// ─── Precomputed path data ─────────────────────────────────────────────────────

// Hero spectrum: animated playback of a real H I survey profile.
const HW = 600;
const HERO_CHART_TOP = -42;
const HERO_BASE_Y = 156;          // y-coordinate of the 0-power baseline
const HERO_CHART_BOTTOM = 190;
const HERO_CHART_HEIGHT = HERO_BASE_Y - HERO_CHART_TOP;
const HERO_PEAK_HEADROOM = 70;
const HERO_PEAK_PX = HERO_CHART_HEIGHT - HERO_PEAK_HEADROOM;
const HERO_AXIS_LABEL_Y = HERO_BASE_Y + 22;
const HERO_REST_LABEL_Y = HERO_BASE_Y + 19;
const HERO_REST_LABEL_BOX_Y = HERO_BASE_Y + 4;
const HERO_PERSEUS_BAND_TOP = HERO_CHART_TOP + HERO_CHART_HEIGHT * 0.34;
const HERO_PERSEUS_LABEL_Y = HERO_CHART_TOP + HERO_CHART_HEIGHT * 0.31;
// Mobile: crop dead wings so the peaks fill the screen. x=[70,430] covers all
// labelled content (Perseus box at x≈87, bracket at x≈392) and clips the
// low-signal tails. The 1.67× effective zoom makes labels readable at ~12px.
const HERO_MOBILE_VIEWBOX = `70 ${HERO_CHART_TOP} 360 ${HERO_CHART_BOTTOM - HERO_CHART_TOP}`;
const HERO_DESKTOP_VIEWBOX = `0 ${HERO_CHART_TOP} ${HW} ${HERO_CHART_BOTTOM - HERO_CHART_TOP}`;

// LAB hydrogen-line profile supplied for the queue-page example spectrum.
// Columns in the source file are v_lsr [km/s], T_B [K], frequency [MHz],
// and wavelength [cm].
type SurveySample = {
  tbK: number;
  freqMhz: number;
};

function parseQueueSpectrum(raw: string): SurveySample[] {
  const samples: SurveySample[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;

    const tbK = Number(parts[1]);
    const freqMhz = Number(parts[2]);
    if (Number.isFinite(tbK) && Number.isFinite(freqMhz)) {
      samples.push({ tbK, freqMhz });
    }
  }

  if (samples.length === 0) {
    throw new Error('Queue spectrum data did not contain any LAB samples.');
  }

  return samples;
}

const RAW_SAMPLES = parseQueueSpectrum(queueSpectrumRaw);

// Downsample the LAB survey. The hero panel is ~600 CSS-px wide so we don't
// need every one of the raw 245 LAB samples; 100 bins matches the visible
// detail without spending budget on points that fall between pixels.
const HERO_TARGET_BINS = 100;
const SURVEY_SAMPLES: SurveySample[] = (() => {
  if (RAW_SAMPLES.length <= HERO_TARGET_BINS) return RAW_SAMPLES;
  const stride = RAW_SAMPLES.length / HERO_TARGET_BINS;
  const out: SurveySample[] = [];
  for (let i = 0; i < HERO_TARGET_BINS; i++) {
    out.push(RAW_SAMPLES[Math.min(RAW_SAMPLES.length - 1, Math.round(i * stride))]);
  }
  return out;
})();
const SURVEY_TB_K: number[] = SURVEY_SAMPLES.map(sample => sample.tbK);
const SURVEY_FREQ_MHZ: number[] = SURVEY_SAMPLES.map(sample => sample.freqMhz);

// Normalize to [0, 1] for the SVG mapping; the receiver-noise animation layers
// on top of this baseline shape per frame.
const SURVEY_PEAK_K = SURVEY_TB_K.reduce((m, v) => (v > m ? v : m), 0);
const SURVEY_POWER: number[] = SURVEY_TB_K.map((v) => Math.max(0, v) / SURVEY_PEAK_K);

// Frequency-axis mapping. Display range hugs the supplied data span with
// enough padding to land round-numbered tick labels on the axis.
const H1_REST_MHZ = 1420.4058;
const DISPLAY_TICK_STEP_MHZ = 0.2;
const DISPLAY_MIN_SIGNAL_K = 0.02;
const DISPLAY_PAD_MHZ = 0.04;
const DISPLAY_SIGNAL_FREQ_MHZ = SURVEY_SAMPLES
  .filter(sample => sample.tbK >= DISPLAY_MIN_SIGNAL_K)
  .map(sample => sample.freqMhz);
const DISPLAY_MIN_MHZ =
  Math.min(...DISPLAY_SIGNAL_FREQ_MHZ) - DISPLAY_PAD_MHZ;
const DISPLAY_MAX_MHZ =
  Math.max(...DISPLAY_SIGNAL_FREQ_MHZ) + DISPLAY_PAD_MHZ;
const DISPLAY_SPAN_MHZ = DISPLAY_MAX_MHZ - DISPLAY_MIN_MHZ;
// Higher frequency on the left (blueshifted), lower on the right (redshifted)
// — the standard convention used by SDR spectrum tools.
const fToX = (f: number) => ((DISPLAY_MAX_MHZ - f) / DISPLAY_SPAN_MHZ) * HW;
const indexToX = (i: number) => fToX(SURVEY_FREQ_MHZ[i]);
const SURVEY_X_START = indexToX(0);
const SURVEY_X_END   = indexToX(SURVEY_TB_K.length - 1);
const SURVEY_DOPPLER_PEAK_X = (() => {
  let idx = 0;
  for (let i = 0; i < SURVEY_POWER.length; i++) {
    const isBlueShifted = SURVEY_FREQ_MHZ[i] > H1_REST_MHZ + 0.05;
    if (isBlueShifted && SURVEY_POWER[i] > SURVEY_POWER[idx]) idx = i;
  }
  return indexToX(idx);
})();
const [SURVEY_MAIN_PEAK_X, SURVEY_MAIN_PEAK_Y] = (() => {
  let idx = 0;
  for (let i = 0; i < SURVEY_POWER.length; i++) {
    if (SURVEY_POWER[i] > SURVEY_POWER[idx]) idx = i;
  }
  return [indexToX(idx), HERO_BASE_Y - SURVEY_POWER[idx] * HERO_PEAK_PX];
})();
const SURVEY_MAIN_PEAK_RATIO = SURVEY_MAIN_PEAK_X / HW;

// Frequency tick labels placed at round intervals across the display.
const FIRST_FREQ_TICK_MHZ = Math.ceil(DISPLAY_MIN_MHZ / DISPLAY_TICK_STEP_MHZ) * DISPLAY_TICK_STEP_MHZ;
const LAST_FREQ_TICK_MHZ = Math.floor(DISPLAY_MAX_MHZ / DISPLAY_TICK_STEP_MHZ) * DISPLAY_TICK_STEP_MHZ;
const FREQ_TICKS_MHZ = Array.from(
  { length: Math.round((LAST_FREQ_TICK_MHZ - FIRST_FREQ_TICK_MHZ) / DISPLAY_TICK_STEP_MHZ) + 1 },
  (_, i) => FIRST_FREQ_TICK_MHZ + i * DISPLAY_TICK_STEP_MHZ,
);

// ─── SVG components ────────────────────────────────────────────────────────────

// X-coordinates are a pure function of bin index and never change at runtime,
// so we precompute them (and the corresponding pre-formatted "x," prefix
// string used by the path builder) once instead of recomputing every frame.
const SURVEY_X_PX: Float32Array = (() => {
  const out = new Float32Array(SURVEY_FREQ_MHZ.length);
  for (let i = 0; i < SURVEY_FREQ_MHZ.length; i++) out[i] = indexToX(i);
  return out;
})();
const SURVEY_X_PREFIX: string[] = Array.from(SURVEY_X_PX, x => `${x.toFixed(1)},`);
const SURVEY_X_START_STR = SURVEY_X_START.toFixed(1);
const SURVEY_X_END_STR = SURVEY_X_END.toFixed(1);

// Build the SVG path data for one playback frame. `smoothed` is the current
// (noisy, integrating) power-per-bin estimate; we walk it across HW pixels and
// emit a polyline path plus a matching filled-area path.
function buildHeroPaths(smoothed: Float32Array): { line: string; fill: string } {
  const n = smoothed.length;
  let pts = '';
  for (let i = 0; i < n; i++) {
    const y = HERO_BASE_Y - smoothed[i] * HERO_PEAK_PX;
    pts += (i === 0 ? '' : ' L ') + SURVEY_X_PREFIX[i] + y.toFixed(1);
  }
  const line = `M ${pts}`;
  // The fill anchors to the baseline at the data's own x bounds, not the SVG
  // edges, so the gradient doesn't smear out into the blank wings.
  const fill = `M ${SURVEY_X_START_STR},${HERO_BASE_Y} L ${pts} L ${SURVEY_X_END_STR},${HERO_BASE_Y} Z`;
  return { line, fill };
}

// Box-Muller-ish cheap noise. We don't need true Gaussian — just symmetric,
// zero-mean fluctuations that look like SDR receiver noise on a quiet band.
function noiseSample(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) * (2 / 3);
}

function deterministicNoise(seed: number, timeSeconds: number): number {
  const a = Math.sin(seed * 12.9898 + 78.233);
  const b = Math.sin(seed * 39.3467 + 11.135);
  const c = Math.sin(seed * 73.1562 + 42.798);
  return (
    Math.sin(timeSeconds * 11.0 + a * Math.PI) * 0.50 +
    Math.sin(timeSeconds * 18.0 + b * Math.PI) * 0.30 +
    Math.sin(timeSeconds * 29.0 + c * Math.PI) * 0.20
  );
}

function useVisibleAnimation<T extends Element>(rootMarginTopPx = 0) {
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

    // Negative top rootMargin shrinks the observer's effective viewport from
    // the top, so anything sliding under the sticky header counts as out of
    // view. Pausing the animation while it's behind a translucent
    // backdrop-filter is the only thing that lets the compositor cache the
    // blurred header layer between frames.
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      update();
    }, { threshold: 0.01, rootMargin: `-${rootMarginTopPx}px 0px 0px 0px` });

    document.addEventListener('visibilitychange', onVisibilityChange);
    observer.observe(el);
    update();

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
    };
  }, [rootMarginTopPx]);

  return [ref, active] as const;
}

const HeroSpectrum = memo(function HeroSpectrum({ paused = false }: { paused?: boolean }) {
  // Live trace = survey shape + per-frame noise, lightly low-passed across
  // frames so the line breathes instead of strobing. Smoothing constant α
  // governs how quickly noise integrates away — 0.18 looks visibly "live"
  // while still letting the underlying peaks read clearly.
  //
  // The animation updates path `d` attributes imperatively via refs so React
  // never reconciles during the rAF loop. The component is also wrapped in
  // `memo()` so parent re-renders (queue status polling fires every couple
  // seconds) don't force a fresh React render and a competing path update
  // alongside the rAF loop.
  const smoothedRef = useRef<Float32Array>(new Float32Array(SURVEY_POWER.length));
  const rafRef = useRef<number | null>(null);
  const linePathRef = useRef<SVGPathElement | null>(null);
  const fillPathRef = useRef<SVGPathElement | null>(null);
  const peakFillPathRef = useRef<SVGPathElement | null>(null);
  const glowPathRef = useRef<SVGPathElement | null>(null);
  const [svgRef, animationActive] = useVisibleAnimation<SVGSVGElement>(STICKY_HEADER_ANIMATION_MARGIN_PX);
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const update = () => setIsMobile(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  const initialPaths = buildHeroPaths(smoothedRef.current);

  useEffect(() => {
    if (!animationActive || paused) return;

    // rAF (not setInterval) so the path-attribute writes are synced to the
    // browser's paint cycle — setInterval fires asynchronously and can land
    // in the middle of a compositor pass, producing extra paint work.
    let lastTs = 0;
    const minIntervalMs = 1000 / 20;
    const alpha = 0.20;
    const noiseAmp = 0.07;
    const n = SURVEY_POWER.length;

    const tick = (ts: number) => {
      rafRef.current = requestAnimationFrame(tick);
      if (ts - lastTs < minIntervalMs) return;
      lastTs = ts;
      const buf = smoothedRef.current;
      for (let i = 0; i < n; i++) {
        const target = SURVEY_POWER[i] + noiseSample() * noiseAmp;
        buf[i] = buf[i] + (target - buf[i]) * alpha;
      }
      const { line, fill } = buildHeroPaths(buf);
      if (linePathRef.current) linePathRef.current.setAttribute('d', line);
      if (fillPathRef.current) fillPathRef.current.setAttribute('d', fill);
      if (peakFillPathRef.current) peakFillPathRef.current.setAttribute('d', fill);
      if (glowPathRef.current) glowPathRef.current.setAttribute('d', line);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [animationActive, paused]);

  return (
    <figure className="h1-hero-figure">
      <svg
        ref={svgRef}
        viewBox={isMobile ? HERO_MOBILE_VIEWBOX : HERO_DESKTOP_VIEWBOX}
        className="h1-svg"
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
      <defs>
        <linearGradient id="h1HeroBaseFillGrad" x1="0" y1={HERO_CHART_TOP} x2="0" y2={HERO_BASE_Y} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffbc42" stopOpacity="0.18" />
          <stop offset="52%" stopColor="#ffbc42" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </linearGradient>
        <radialGradient
          id="h1HeroPeakFillGrad"
          cx={SURVEY_MAIN_PEAK_X}
          cy={SURVEY_MAIN_PEAK_Y + 28}
          r="150"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#ffbc42" stopOpacity="0.36" />
          <stop offset="45%" stopColor="#ffbc42" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#ffbc42" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="h1HeroLineGlowGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset={`${Math.max(0, SURVEY_MAIN_PEAK_RATIO - 0.18) * 100}%`} stopColor="#ffbc42" stopOpacity="0.05" />
          <stop offset={`${Math.max(0, SURVEY_MAIN_PEAK_RATIO - 0.07) * 100}%`} stopColor="#ffbc42" stopOpacity="0.5" />
          <stop offset={`${SURVEY_MAIN_PEAK_RATIO * 100}%`} stopColor="#ffd37a" stopOpacity="0.95" />
          <stop offset={`${Math.min(1, SURVEY_MAIN_PEAK_RATIO + 0.08) * 100}%`} stopColor="#ffbc42" stopOpacity="0.34" />
          <stop offset={`${Math.min(1, SURVEY_MAIN_PEAK_RATIO + 0.2) * 100}%`} stopColor="#ffbc42" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="h1PerseusArmGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5ba4f5" stopOpacity="0.18" />
          <stop offset="60%" stopColor="#5ba4f5" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#5ba4f5" stopOpacity="0" />
        </linearGradient>
      </defs>
      {Array.from({ length: 7 }, (_, i) => HERO_CHART_TOP + (HERO_CHART_HEIGHT / 6) * i).map(y => (
        <line key={y} x1="0" y1={y} x2={HW} y2={y} stroke="#1a1d2e" strokeWidth="1" />
      ))}
      {FREQ_TICKS_MHZ.map(f => (
        <line key={f} x1={fToX(f)} y1={HERO_CHART_TOP} x2={fToX(f)} y2={HERO_BASE_Y} stroke="#1a1d2e" strokeWidth="1" />
      ))}
      <rect
        x={SURVEY_DOPPLER_PEAK_X - 46}
        y={HERO_PERSEUS_BAND_TOP}
        width="92"
        height={HERO_BASE_Y - HERO_PERSEUS_BAND_TOP}
        fill="url(#h1PerseusArmGrad)"
      />
      <path ref={fillPathRef} d={initialPaths.fill} fill="url(#h1HeroBaseFillGrad)" />
      <path ref={peakFillPathRef} d={initialPaths.fill} fill="url(#h1HeroPeakFillGrad)" />
      <line x1="0" y1={HERO_BASE_Y} x2={HW} y2={HERO_BASE_Y} stroke="#232640" strokeWidth="1" />
      <path ref={glowPathRef} d={initialPaths.line} fill="none" stroke="url(#h1HeroLineGlowGrad)" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" opacity="0.42" />
      <path ref={linePathRef} d={initialPaths.line} fill="none" stroke="#ffbc42" strokeWidth="3.25" strokeLinecap="round" strokeLinejoin="round" />
      <line x1={fToX(H1_REST_MHZ)} y1={SURVEY_MAIN_PEAK_Y} x2={fToX(H1_REST_MHZ)} y2={HERO_BASE_Y} stroke="#ffbc42" strokeWidth="1.35" strokeDasharray="5,4" opacity="0.72" />
      {/* Secondary blueshifted emission peak in the supplied LAB profile:
          neutral hydrogen in the Perseus Arm. */}
      <a href="#h1-doppler-section" style={{ cursor: 'pointer' }}>
        <title>Neutral hydrogen in the Perseus Arm, a spiral arm of the Milky Way, blueshifted by galactic rotation at l = 110°. Click to learn more about the Doppler effect.</title>
        <g>
          <rect
            x={SURVEY_DOPPLER_PEAK_X - 72}
            y={HERO_PERSEUS_LABEL_Y}
            width="144"
            height="36"
            rx="5"
            fill="#08172e"
            stroke="#5ba4f5"
            strokeWidth="1"
            opacity="0.82"
          />
          <text
            x={SURVEY_DOPPLER_PEAK_X} y={HERO_PERSEUS_LABEL_Y + 16}
            textAnchor="middle"
            fill="#c5ddfb" fontSize="12" fontWeight="700"
            fontFamily="ui-monospace,monospace"
          >
            Perseus Arm
          </text>
          <text
            x={SURVEY_DOPPLER_PEAK_X} y={HERO_PERSEUS_LABEL_Y + 30}
            textAnchor="middle"
            fill="#7ab8f7" fontSize="9.5"
            fontFamily="ui-monospace,monospace"
          >
            Milky Way spiral arm
          </text>
        </g>
      </a>
      {/* Sideways bracket spanning the gap between the main (local-arm) peak
          and the H I rest marker, linking out to the Doppler explainer. */}
      {(() => {
        const restX = fToX(H1_REST_MHZ);
        const leftX = Math.min(SURVEY_MAIN_PEAK_X, restX);
        const rightX = Math.max(SURVEY_MAIN_PEAK_X, restX);
        const midX = (leftX + rightX) / 2;
        const prongY = SURVEY_MAIN_PEAK_Y - 9;
        const barY = prongY - 12;
        const tickY = barY - 15;
        const labelY = tickY - 3;
        const linkBoxY = labelY - 15;
        return (
          <a href="#h1-doppler-section" style={{ cursor: 'pointer' }}>
            <title>The received peak is offset from the 1420.4 MHz rest line — that gap is the Doppler shift. Click to learn more.</title>
            <path
              d={`M ${leftX} ${prongY} L ${leftX} ${barY} L ${rightX} ${barY} L ${rightX} ${prongY} M ${midX} ${barY} L ${midX} ${tickY}`}
              fill="none"
              stroke="#7ab8f7"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.72"
            />
            <rect
              x={midX - 85}
              y={linkBoxY}
              width="170"
              height="20"
              rx="4"
              fill="#0b1328"
              stroke="#7ab8f7"
              strokeWidth="1"
              opacity="0.88"
            />
            <text
              x={midX - 6} y={labelY}
              textAnchor="middle"
              fill="#d4e5ff" fontSize="13" fontWeight="bold" opacity="0.92"
              fontFamily="ui-monospace,monospace"
              style={{ textDecoration: 'underline' }}
            >
              Why the difference?
            </text>
            <path
              d={`M ${midX + 67} ${labelY - 7} L ${midX + 75} ${labelY - 7} L ${midX + 75} ${labelY - 2} M ${midX + 75} ${labelY - 7} L ${midX + 65} ${labelY}`}
              fill="none"
              stroke="#d4e5ff"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.9"
            />
          </a>
        );
      })()}
      {FREQ_TICKS_MHZ.map(f => {
        const isRest = Math.abs(f - 1420.4) < 0.001;
        if (isRest) {
          return (
            <g key={f}>
              <rect
                x={fToX(f) - 38}
                y={HERO_REST_LABEL_BOX_Y}
                width="76"
                height="21"
                rx="4"
                fill="#251b0d"
                stroke="#ffbc42"
                strokeWidth="1"
                opacity="0.94"
              />
              <text
                x={fToX(f)}
                y={HERO_REST_LABEL_Y}
                textAnchor="middle"
                fill="#ffd37a"
                fontSize="12"
                fontWeight="800"
                fontFamily="ui-monospace,monospace"
              >
                {`${f.toFixed(1)} MHz`}
              </text>
            </g>
          );
        }
        return (
          <text
            key={f}
            x={fToX(f)} y={HERO_AXIS_LABEL_Y}
            textAnchor="middle"
            fill="#6f719a"
            fontSize="10"
            fontWeight="normal"
            fontFamily="ui-monospace,monospace"
          >
            {f.toFixed(1)}
          </text>
        );
      })}
      </svg>
    </figure>
  );
});

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
const DA_H = 392;                   // total SVG height (scene + mini spectrum)
const DA_AXIS_Y = 96;               // y of horizontal axis through source
const DA_TELESCOPE_X = 52;          // x of dish centre
const DA_DISH_BACK_X = DA_TELESCOPE_X - 0.5;
const DA_DISH_FEED_X = DA_TELESCOPE_X + 26;
const DA_SOURCE_CENTER_X = 430;     // mean x position of source
const DA_C_PX_S = 94;               // wavefront expansion speed (px/s)
const DA_T_EMIT_S = 0.78;           // seconds between successive emissions
const DA_MAX_R = 420;               // wavefront fade-out radius
const DA_WAVE_AMP = 16;             // sine-wave amplitude in px

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
const DA_MINI_LEFT_X = 64;
const DA_MINI_W = 472;
const DA_MINI_CX = DA_MINI_LEFT_X + DA_MINI_W / 2;
const DA_MINI_TOP_Y = 214;             // panel top
const DA_MINI_HEADER_Y = 229;          // "telescope receives" label baseline
const DA_MINI_PLOT_TOP_Y = 241;        // top of plottable region
const DA_MINI_BASE_Y = 338;            // baseline / x-axis y
const DA_MINI_BOTTOM_PAD = 44;          // room for frequency labels below the axis
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

// Map mini-spectrum x to the frequency it represents. DA_V_MAX (in km/s in this
// scene) shifts the peak by DA_MINI_HALF_RANGE px, and Doppler says that
// corresponds to Δf = f₀ · v/c at the H1 rest line.
const DA_SPEED_OF_LIGHT_KMS = 299792.458;
const DA_DOPPLER_DF_AT_VMAX_MHZ =
  H1_REST_MHZ * DA_V_MAX / DA_SPEED_OF_LIGHT_KMS;
const DA_MINI_MHZ_PER_PX =
  DA_DOPPLER_DF_AT_VMAX_MHZ / DA_MINI_HALF_RANGE;
const daFreqToX = (mhz: number) =>
  DA_MINI_CX + (mhz - H1_REST_MHZ) / DA_MINI_MHZ_PER_PX;
const DA_MINI_GRID_MHZ = [1420.2, 1420.3, H1_REST_MHZ, 1420.5, 1420.6];
const DA_MINI_REST_LABEL_MHZ = 1420.4;

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

function DopplerAnimation({ renderTimeSeconds, paused = false }: { renderTimeSeconds?: number; paused?: boolean } = {}) {
  const [now, setNow] = useState(0);
  const startRef = useRef(0);
  const [svgRef, animationActive] = useVisibleAnimation<SVGSVGElement>(STICKY_HEADER_ANIMATION_MARGIN_PX);
  const isRenderFrame = renderTimeSeconds != null;
  // Smoothed noisy bin values for the mini spectrum trace. Updated in the rAF
  // loop so render stays a pure function of `now` plus this ref.
  const miniBinsRef = useRef<number[]>(new Array(DA_MINI_BINS).fill(0));

  useEffect(() => {
    if (isRenderFrame) return;
    if (!animationActive || paused) return;

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
      const peakCenter = DA_MINI_CX + (vReceived / DA_V_MAX) * DA_MINI_HALF_RANGE;
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
  }, [animationActive, isRenderFrame, paused]);

  const t = renderTimeSeconds ?? now;
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
  const miniBins = isRenderFrame
    ? Array.from({ length: DA_MINI_BINS }, (_, i) => {
      const emitTAtDish = findEmitTimeAtTelescope(t);
      const vReceived = vTowardAt(emitTAtDish);
      const peakCenter = DA_MINI_CX + (vReceived / DA_V_MAX) * DA_MINI_HALF_RANGE;
      const x = DA_MINI_PLOT_LEFT_X + (i / (DA_MINI_BINS - 1)) * DA_MINI_PLOT_W;
      const dx = x - peakCenter;
      const peakNorm = Math.exp(-0.5 * (dx / DA_MINI_PEAK_SIGMA) ** 2);
      return Math.max(0, peakNorm + deterministicNoise(i, t) * DA_MINI_NOISE_AMP);
    })
    : miniBinsRef.current;
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
  const arrowHeadBaseX = arrowEndX - arrowDir * 8;
  const arrowY = DA_AXIS_Y + 46;
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
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      <Cloud
        x={sourceX - 66}
        y={DA_AXIS_Y - 45}
        width="132"
        height="99"
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
        fontSize="30"
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
            x2={arrowHeadBaseX} y2={arrowY}
            stroke="#9b9ece" strokeWidth="2"
          />
          <path
            d={`M ${arrowEndX},${arrowY} L ${arrowHeadBaseX},${arrowY - 5} L ${arrowHeadBaseX},${arrowY + 5} Z`}
            fill="#9b9ece" stroke="none"
          />
        </g>
      )}

      <g transform={`translate(${sourceX}, ${arrowY + 22})`}>
        <rect
          x="-80"
          y="-18"
          width="160"
          height="40"
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
          fontSize="11"
          fontWeight="700"
          letterSpacing="0.08em"
        >
          RELATIVE VELOCITY
        </text>
        <text
          x="0"
          y="15"
          textAnchor="middle"
          fill="#e0e3ff"
          fontSize="16"
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
        width={DA_MINI_W} height={DA_MINI_BASE_Y - DA_MINI_TOP_Y + DA_MINI_BOTTOM_PAD}
        fill="#0c0f1c" stroke="#1d2138" rx="4"
      />
      <text
        x={DA_MINI_LEFT_X + 12} y={DA_MINI_HEADER_Y}
        fill="#6f719a" fontSize="13" fontWeight="600"
        letterSpacing="0.06em"
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
      {DA_MINI_GRID_MHZ.map((mhz) => (
        <line
          key={mhz}
          x1={daFreqToX(mhz)} y1={DA_MINI_PLOT_TOP_Y}
          x2={daFreqToX(mhz)} y2={DA_MINI_BASE_Y}
          stroke="#1a1d2e" strokeWidth="1"
        />
      ))}
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
      <rect
        x={DA_MINI_CX - 38} y={DA_MINI_BASE_Y + 15}
        width="76" height="21"
        rx="4"
        fill="#251b0d"
        stroke="#ffbc42"
        strokeWidth="1"
        opacity="0.94"
      />
      <text
        x={DA_MINI_CX} y={DA_MINI_BASE_Y + 30}
        textAnchor="middle"
        fill="#ffd37a"
        fontSize="12"
        fontWeight="800"
        fontFamily="ui-monospace,monospace"
      >
        {`${DA_MINI_REST_LABEL_MHZ.toFixed(1)} MHz`}
      </text>
      <text
        x={DA_MINI_LEFT_X + 12} y={DA_MINI_BASE_Y + 30}
        fill="#ff7a4d" fontSize="13"
      >
        lower frequency ←
      </text>
      <text
        x={DA_MINI_LEFT_X + DA_MINI_W - 12} y={DA_MINI_BASE_Y + 30}
        textAnchor="end" fill="#5ba4f5" fontSize="13"
      >
        → higher frequency
      </text>
    </svg>
  );
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  status: QueueStatus | null;
  joining: boolean;
  joinError: string | null;
  /** Seconds left on the rate-limit cooldown after a 429, or null if not
   *  rate-limited. Drives the disabled-button countdown UX. */
  joinRateLimitedSec?: number | null;
  siteKey: string | null;
  turnstileEnabled: boolean;
  betaPasswordEnabled: boolean;
  onJoin: (token: string | null, betaPassword: string | null) => Promise<void>;
  hasControl: boolean;
  onContinue: () => void;
  loading?: boolean;
  telescopeStatus?: TelescopeStatus | null;
}

type InlinePopoverState = {
  left: number;
  top: number;
  placement: 'above' | 'below';
  open: boolean;
};

type InlineHoverPopoverProps = {
  label: ReactNode;
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  popoverClassName?: string;
  width?: number;
  height?: number;
};

function InlineHoverPopover({
  label,
  ariaLabel,
  children,
  className = '',
  popoverClassName = '',
  width = MISLEADING_POPOVER_WIDTH,
  height = MISLEADING_POPOVER_HEIGHT,
}: InlineHoverPopoverProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [popover, setPopover] = useState<InlinePopoverState | null>(null);

  const positionPopover = () => {
    const trigger = buttonRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popoverWidth = Math.min(
      width,
      viewportWidth - MISLEADING_POPOVER_MARGIN * 2,
    );
    const halfWidth = popoverWidth / 2;
    const maxLeft = Math.max(
      MISLEADING_POPOVER_MARGIN + halfWidth,
      viewportWidth - MISLEADING_POPOVER_MARGIN - halfWidth,
    );
    const left = clamp(
      rect.left + rect.width / 2,
      MISLEADING_POPOVER_MARGIN + halfWidth,
      maxLeft,
    );
    const roomAbove = rect.top - MISLEADING_POPOVER_MARGIN;
    const roomBelow = viewportHeight - rect.bottom - MISLEADING_POPOVER_MARGIN;
    const placement = roomAbove > roomBelow && roomAbove >= height ? 'above' : 'below';
    const preferredTop = placement === 'above'
      ? rect.top - MISLEADING_POPOVER_GAP - height
      : rect.bottom + MISLEADING_POPOVER_GAP;
    const maxTop = Math.max(
      MISLEADING_POPOVER_MARGIN,
      viewportHeight - MISLEADING_POPOVER_MARGIN - height,
    );
    const top = clamp(
      preferredTop,
      MISLEADING_POPOVER_MARGIN,
      maxTop,
    );
    setPopover({ left, top, placement, open: true });
  };

  const hidePopover = () => {
    setPopover((current) => current ? { ...current, open: false } : null);
  };

  useEffect(() => {
    if (!popover?.open) return;
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [popover, width, height]);

  return (
    <button
      ref={buttonRef}
      className={`spectrum-doppler-term h1-misleading-highlight${className ? ` ${className}` : ''}`}
      type="button"
      aria-label={ariaLabel}
      aria-expanded={popover?.open ? 'true' : 'false'}
      onMouseEnter={positionPopover}
      onFocus={positionPopover}
      onMouseLeave={hidePopover}
      onBlur={hidePopover}
      onClick={positionPopover}
    >
      {label}
      <span
        className={`h1-misleading-popover h1-misleading-popover-${popover?.placement ?? 'below'}${popover?.open ? ' h1-misleading-popover-open' : ''}${popoverClassName ? ` ${popoverClassName}` : ''}`}
        role="tooltip"
        style={popover ? { left: popover.left, top: popover.top } : undefined}
      >
        {children}
      </span>
    </button>
  );
}

export function QueuePage({
  status, joining, joinError, joinRateLimitedSec = null,
  siteKey, turnstileEnabled, betaPasswordEnabled, onJoin, hasControl, onContinue, loading = false,
  telescopeStatus = null,
}: Props) {
  const telescopeOpen = (telescopeStatus?.state ?? 'operational') === 'operational';
  const rateLimited = joinRateLimitedSec != null && joinRateLimitedSec > 0;
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [betaPassword, setBetaPassword] = useState('');
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const scrollProgressRef = useRef<HTMLDivElement | null>(null);
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const autoJoinedTokenRef = useRef<string | null>(null);
  const inQueue = (status?.position ?? -1) >= 0;
  const passwordRequired = betaPasswordEnabled && !betaPassword.trim();
  const waitingForCaptcha = turnstileEnabled && !captchaToken;
  const joinDisabled = joining || rateLimited || passwordRequired || waitingForCaptcha || !telescopeOpen;

  const submitHeaderJoin = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (joinDisabled) return;
    void onJoin(captchaToken, betaPasswordEnabled ? betaPassword : null);
  };

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 720px)');
    const viewport = window.visualViewport;
    const updateCollapsed = () => {
      setHeaderCollapsed(mobileQuery.matches && window.scrollY > 12);
      document.documentElement.style.setProperty(
        '--queue-viewport-top',
        `${viewport?.offsetTop ?? 0}px`,
      );
      // Scroll-progress needle along the bottom edge of the sticky header.
      // Written imperatively so scrolling never triggers a React render.
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const frac = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      if (scrollProgressRef.current) {
        scrollProgressRef.current.style.width = `${(frac * 100).toFixed(2)}%`;
      }
    };

    updateCollapsed();
    window.addEventListener('scroll', updateCollapsed, { passive: true });
    mobileQuery.addEventListener('change', updateCollapsed);
    viewport?.addEventListener('resize', updateCollapsed);
    viewport?.addEventListener('scroll', updateCollapsed);

    return () => {
      window.removeEventListener('scroll', updateCollapsed);
      mobileQuery.removeEventListener('change', updateCollapsed);
      viewport?.removeEventListener('resize', updateCollapsed);
      viewport?.removeEventListener('scroll', updateCollapsed);
      document.documentElement.style.removeProperty('--queue-viewport-top');
    };
  }, []);

  // Scroll-driven reveals: every [data-reveal] element rises into place the
  // first time it enters the viewport. With reduced motion preferred we skip
  // straight to the revealed state (the CSS transition is also disabled).
  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (els.length === 0) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const el of els) el.classList.add('is-revealed');
      return;
    }
    const pending = new Set(els);
    const reveal = (el: HTMLElement) => {
      el.classList.add('is-revealed');
      pending.delete(el);
      observer.unobserve(el);
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) reveal(entry.target as HTMLElement);
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    for (const el of els) observer.observe(el);
    // Belt-and-braces geometric sweep: if the observer never fires (it ticks
    // with the refresh driver, which some environments suspend), anything
    // already in the viewport still reveals shortly after mount and on scroll.
    const sweep = () => {
      for (const el of Array.from(pending)) {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight - 40 && rect.bottom > 0) reveal(el);
      }
      if (pending.size === 0) window.removeEventListener('scroll', onScroll);
    };
    let sweepTimer = window.setTimeout(sweep, 350);
    const onScroll = () => {
      clearTimeout(sweepTimer);
      sweepTimer = window.setTimeout(sweep, 120);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      clearTimeout(sweepTimer);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  useEffect(() => {
    if (!turnstileEnabled) return;
    if (inQueue || joining) return;
    if (!captchaToken) return;
    if (betaPasswordEnabled && !betaPassword) return;
    if (autoJoinedTokenRef.current === captchaToken) return;
    autoJoinedTokenRef.current = captchaToken;
    void onJoin(captchaToken, betaPasswordEnabled ? betaPassword : null);
  }, [captchaToken, betaPassword, betaPasswordEnabled, turnstileEnabled, inQueue, joining, onJoin]);

  useEffect(() => {
    if (!joinError) return;
    autoJoinedTokenRef.current = null;
    if (turnstileEnabled) {
      setCaptchaToken(null);
      if (window.turnstile && widgetIdRef.current) window.turnstile.reset(widgetIdRef.current);
    }
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

  // Progress bar fill: position 1 = front of line (full), larger = further back.
  // Use queue_length as the denominator so the bar reflects relative standing.
  const queueLength = status?.queue_length ?? 0;
  const position = status?.position ?? 0;
  const progressPct = inQueue && queueLength > 0
    ? Math.max(6, Math.min(100, ((queueLength - position + 1) / queueLength) * 100))
    : 0;

  // Keep the animated spectrum quiet while the join verification widget is active.
  const animationsPaused = false;

  const [spinFlipRef, spinFlipActive] = useVisibleAnimation<HTMLDivElement>(STICKY_HEADER_ANIMATION_MARGIN_PX);

  return (
    <div className="queue-waiting" ref={pageRef}>
      <header className={`queue-header${headerCollapsed ? ' queue-header-collapsed' : ''}`}>
        <div className="queue-header-inner">
          <div className="queue-header-title">
            {!telescopeOpen && (
              <div
                className={`queue-maintenance-banner queue-maintenance-${telescopeStatus?.state ?? 'maintenance'}`}
                role="status"
              >
                <strong>
                  {telescopeStatus?.state === 'closed'
                    ? 'Telescope is currently closed'
                    : 'Telescope is down for maintenance'}
                </strong>
                {telescopeStatus?.message && (
                  <span> — {telescopeStatus.message}</span>
                )}
              </div>
            )}
            <h1>
              {loading
                ? 'Loading queue'
                : inQueue
                ? 'You are in the queue'
                : 'Titan Observatory Demo'}
            </h1>
            <p className="queue-header-sub">
              {loading
                ? "While the telescope checks your place, scroll on to learn what you'll be observing."
                : inQueue
                ? "While you wait, scroll on to learn what you'll be observing."
                : (
                    <>
                      The telescope is currently under construction.{' '}
                      Interested in helping us test?
                    </>
                  )}
            </p>
            {!loading && !inQueue && (
              <a
                className="queue-access-link"
                href="https://forms.gle/qPtCGmJdvtG6W8Ky6"
                target="_blank"
                rel="noopener noreferrer"
              >
                Apply for access
              </a>
            )}
            <p className="queue-content-disclaimer">
              All content is researched and written by humans :)
            </p>
          </div>
          <div className={`queue-header-status${!inQueue ? ' queue-header-status-login' : ''}`}>
            {!inQueue && (
              <form className="queue-header-join" onSubmit={submitHeaderJoin}>
                {betaPasswordEnabled && (
                  <div className="beta-password-field queue-header-password">
                    <label htmlFor="beta-pw-header">Testing access</label>
                    <input
                      id="beta-pw-header"
                      type="password"
                      autoComplete="current-password"
                      placeholder="Password"
                      value={betaPassword}
                      onChange={(e) => setBetaPassword(e.target.value)}
                    />
                  </div>
                )}
                {turnstileEnabled && (
                  <div className="queue-header-turnstile">
                    <div className="cf-turnstile" ref={widgetRef} />
                  </div>
                )}
                <button className="action-button queue-header-cta" type="submit" disabled={joinDisabled}>
                  {joining
                    ? 'Joining...'
                    : !telescopeOpen
                      ? (telescopeStatus?.state === 'closed' ? 'Closed' : 'Unavailable')
                      : rateLimited
                        ? `Try again in ${joinRateLimitedSec}s`
                        : 'Join queue'}
                </button>
                <p className={`queue-status-line${joinError || rateLimited ? ' queue-status-line-error' : ''}`}>
                  {rateLimited
                    ? `You're trying too fast - try again in ${joinRateLimitedSec}s.`
                    : joinError
                    }
                </p>
              </form>
            )}
            <div className="queue-header-status-row">
              <span className="queue-header-label">Position</span>
              {/* Keyed on position so a queue advance remounts the number and
                  replays the pop animation. */}
              <strong className="queue-header-position" key={inQueue ? position : 'idle'}>
                {inQueue ? `#${position}` : '—'}
              </strong>
              {inQueue && queueLength > 0 && (
                <span className="queue-header-waiting">of {queueLength}</span>
              )}
            </div>
            {inQueue && queueLength > 0 && (
              <div className="queue-progress" aria-hidden="true">
                <div className="queue-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
            )}
            {inQueue && hasControl && (
              <button className="action-button queue-header-cta queue-cta-ready" onClick={onContinue}>
                Continue to telescope →
              </button>
            )}
          </div>
        </div>
        <div className="queue-scroll-progress" aria-hidden="true">
          <div ref={scrollProgressRef} className="queue-scroll-progress-fill" />
        </div>
      </header>

      <main className="h1-page">

        {/* ── Hero ──────────────────────────────────────────────────────────── */}
        <section className="h1-hero" id="h1-intro-section">
          <div className="h1-hero-inner">
            <div className="h1-hero-text" data-reveal>
              <span className="h1-eyebrow">What is it?</span>
              <h2 className="h1-hero-title">The Hydrogen Line</h2>
              <p className="h1-hero-sub">Found around 1420.4 MHz, the hydrogen line is a characteristic radio signal emitted by electrically neutral hydrogen atoms, a common form of the most abundant element in the universe. Its discovery and use in early days of radio astronomy unlocked an entirely new set of tools for exploring the universe, allowing us to see through thick clouds of dust, measure the velocity and structure of nearby hydrogen, and, for the first time, learn what our own Milky Way galaxy looked like.</p>
            </div>
            <div className="h1-hero-visual" data-reveal="lag">
              <HeroSpectrum paused={animationsPaused} />
              <p className="h1-visual-caption">
                Hydrogen line profile looking outward through the galactic disk
                (l = 65°, b = 0°). LAB all-sky survey, Kalberla et al. 2005.
              </p>
            </div>
          </div>
          <a className="h1-scroll-cue" href="#h1-history-section" aria-label="Scroll to the next section">
            <span>scroll</span>
            <span className="h1-scroll-cue-chevron" aria-hidden="true">▾</span>
          </a>
        </section>

        {/* ── Radio Astronomy History section ─────────────────────────────────────────────── */}
        <section className="h1-spinflip h1-discovery-section" id="h1-history-section">
          <StarsBackground />
          <div className="h1-spinflip-inner">
            <div className="h1-spinflip-text" data-reveal>
              <span className="h1-eyebrow">How was it discovered?</span>
              <h2 className="h1-section-heading">Science at its best</h2>
              <p className="h1-section-body">
                In the decades after radio waves were first detected from space in 1931, radio astronomy was mostly limited to measuring continuum emission. That could reveal a source's general "brightness," but not much else. While the power of{' '}
                <InlineHoverPopover
                  label="spectral lines"
                  ariaLabel="Show what spectral lines are"
                  height={SPECTRAL_LINES_POPOVER_HEIGHT}
                  popoverClassName="h1-spectral-lines-popover"
                >
                  <strong>Spectral lines act as fingerprints.</strong>
                  <span>
                    When atoms or molecules interact with light, their unique structure causes them to absorb and reemit photons at very specific wavelengths. Because the laws of physics are universal, we can use these highly specific "fingerprints" to identify the chemical composition of material from anywhere in the universe!
                  </span>
                </InlineHoverPopover>{' '}
                was already well known in visible-light astronomy, its application to radio astronomy was not immediately explored. It would take time to develop both the technical skills and shared expertise to bridge the gap between RF engineering and astronomy, which had been completely separate fields until that point.
              </p>
              <p className="h1-section-body">By the 1950s, thanks in large part to the efforts of radio engineer Grote Reber, radio astronomy had matured enough for more speculative ideas to form. One of those ideas came from a paper by Van de Hulst in 1945 predicting the existence of the 21 cm line emitted by galactic hydrogen. However, the discovery would not come from a research team with the latest technology, but from a graduate student who built his own telescope on a $500 budget, sticking out of the fourth floor of Harvard's Lyman Lab (pictured).</p>
              <p className="h1-section-body">When Doc Ewen began the experiment under Purcell's guidance, there was little expectation of actually detecting anything. Even Van de Hulst had expressed doubt that the signal would be strong enough to observe. Still, in science, looking for something and not finding it still teaches us something. In this case, they hoped to at least set an upper limit on how strong the signal could be, if it did exist.</p>
              <p className="h1-section-body">Ewen turned on the receiver after major modifications for the first time during Easter weekend in 1951. As Ewen put it: "By 3:00 AM on Sunday morning March 25, I was convinced that the line had been detected."</p>
            </div>
            <figure className="h1-ewen-figure" data-reveal="lag">
              <img
                src="/ewen.jpg"
                alt="Doc Ewen inspecting patchwork inside the horn antenna"
                className="h1-ewen-image"
                loading="lazy"
                decoding="async"
              />
              <figcaption className="h1-ewen-caption">
                <blockquote>
                  After one year, parts of the copper skin had cracked and peeled away from the plywood. I purchased fifty feet of rope from a local hardware store, tied one end around my waist and the other to the lower section of the antenna mount. With a large soldering iron, solder, and a bristle brush I went over the side, four floors up, and slid into the horn. About an hour later, I managed to climb out of the horn back on to the parapet. This picture of me inspecting the patchwork was taken about two days later. The line was detected within the next few weeks.
                </blockquote>
                <cite>Doc Ewen</cite>
              </figcaption>
            </figure>
          </div>
        </section>
        {/* ── Doppler section ───────────────────────────────────────────────── */}
        <section className="h1-spinflip h1-spinflip-alt" id="h1-doppler-section">
          <div className="h1-doppler-inner">
            <div className="h1-doppler-text" data-reveal>
              <span className="h1-eyebrow">How do we use it?</span>
              <h2 className="h1-section-heading">The Doppler Effect</h2>
              <p className="h1-section-body">You may be familiar with the Doppler effect as it relates to sound, but did you know the same thing happens to light? In the same way that an approaching ambulance siren sounds higher in pitch as it gets closer and lower as it moves away, electromagnetic waves shift in frequency based on the relative motion between the source and the observer. It's far too subtle to notice in everyday life, but it's one of the most foundational tools in all of astronomy.</p>
              <p className="h1-section-body"></p>
              <p className="h1-section-body">The obvious challenge with this method is that in order to tell how much a frequency has shifted, you first need to know what it was originally. How do you do that for a photon that came from the other side of the Milky Way? This is where the power of spectral lines becomes clear.</p>
              <p className="h1-section-body">Since we can measure the exact frequency of light emitted by hydrogen in a controlled lab, and because every neutral hydrogen atom in the universe is identical, we can use that reference frequency to measure the relative velocity of hydrogen across the Milky Way.</p>
            </div>
            <div className="h1-doppler-visual" data-reveal="lag">
              <DopplerAnimation paused={animationsPaused} />
              <p className="h1-visual-caption">
                The relative velocity of hydrogen gas along our line of sight shifts the observed frequency: approaching gas is blueshifted, receding gas is redshifted.
              </p>
            </div>
          </div>
        </section>
        {/* ── Donation banner ───────────────────────────────────────────────── */}
        <div className="donation-banner">
          <div className="donation-banner-inner" data-reveal>
          <div className="donation-banner-body">
            <p className="donation-banner-headline">We need your help!</p>
            <p className="donation-banner-sub">
              We're a small team of passionate volunteers working hard to make the Titan Observatory a reality, but we need more support. If you like what we're doing, please consider donating and help lay the foundation for a first-of-its-kind community radio observatory.
            </p>
            <p className="donation-banner-sub donation-banner-sub-cta">
              <strong>Interested in sponsoring, collaborating, or making an in-kind donation? Send us an email at{' '}
              <a className="donation-banner-email" href="mailto:contact@titanobservatory.org">contact@titanobservatory.org</a></strong>
            </p>
          </div>
          <div className="donation-banner-actions">
            <a
              className="donation-banner-link donation-banner-link-primary"
              href="https://titanobservatory.org/donate"
              target="_blank"
              rel="noopener noreferrer"
            >
              Donate
            </a>
            <a
              className="donation-banner-link donation-banner-link-secondary"
              href="mailto:contact@titanobservatory.org"
            >
              Partner with us
            </a>
          </div>
          </div>
        </div>
        {/* ── Spin-flip section ─────────────────────────────────────────────── */}
        <section className="h1-doppler" id="h1-spinflip-section">
          <div className="h1-spinflip-inner">
            <div className="h1-spinflip-text" data-reveal>
              <span className="h1-eyebrow">What causes it?</span>
              <h2 className="h1-section-heading">The spin-flip transition</h2>
              <p className="h1-section-body">
                Neutral hydrogen consists of one proton and one electron, each with a quantum property known as spin. The term "spin" here is a bit{' '}
                <InlineHoverPopover
                  label="misleading"
                  ariaLabel="Show why the spin analogy is misleading"
                >
                  <img src="/Screenshot%202026-05-18%20202822.png" alt="Electron spin explained: imagine a ball that's rotating, except it's not a ball and it's not rotating." loading="lazy" decoding="async" />
                </InlineHoverPopover>{' '}
                to say the least, so for this analogy, we'll simply represent it's two possible states: "up" and "down". When the proton and electron spins are parallel, pointing in the same direction, the atom has a slightly higher energy level than when the spins are anti-parallel (due to complex interactions between their magnetic moments).
              </p>
              <p className="h1-section-body">
                Very rarely, a hydrogen atom in the higher-energy parallel configuration transitions, or “flips,” into the lower-energy anti-parallel configuration. Because energy is conserved, the atom cannot simply lose that extra energy. It must carry the energy away somehow, and in this case it is released as a radio photon at 1420.4 MHz, corresponding to a wavelength of about 21 centimeters.
              </p>
              <p className="h1-section-body">Although any individual spin-flip transition is exceptionally rare, neutral hydrogen is so abundant in the galaxy that the combined signal is constant and measurable, even with a home-built radio telescope!</p>
            </div>
            <div className="h1-spinflip-visual-wrap" ref={spinFlipRef} data-reveal="lag">
              <div className="h1-spinflip-visual">
                <HydrogenAtomDepiction paused={!spinFlipActive} />
              </div>
              <p className="h1-visual-caption">
                In neutral hydrogen, a rare flip from parallel to anti-parallel spin releases a 1420.4 MHz radio photon: the 21 cm hydrogen line.
              </p>
            </div>
          </div>
        </section>
        <section className="h1-spinflip h1-spinflip-alt h1-jansky-section" id="h1-jansky-section">
          <div className="h1-spinflip-inner">
            <div className="h1-spinflip-text" data-reveal>
              <span className="h1-eyebrow">More lore</span>
              <h2 className="h1-section-heading">The beginning of radio astronomy</h2>
              <p className="h1-section-body">In the 1930's, while working at Bell Labs in it's formative years, Karl Jansky was tasked with identifying sources of radio noise which could interefere with overseas radio communication (a bleeding edge technology at the time). Among more mundane sources like thunderstorms, Jansky observed a peculiar background "hiss" of unknown origin which seemed to cycle in intensity once per day, leading Jansky to assume this noise originated from the sun.</p>
              <p className="h1-section-body">However, after a few more months of observation, the point of maximum "static" had noticibly shifted from the position of the sun. Recognizing that this puzzle was beyond the realm of RF engineering, Janksky met with his friend and astrophysicist Albert Melvin Skellett, who pointed out that the now refined 23 hours and 56 minute period of the signal was the exact length of a sidereal day.</p>
              <p className="h1-section-body">There's a whole lot more to the story, but fitting everything on one page is hard. In the future, I would like to expand each of these sections into their own page.</p>
            </div>
            <figure className="h1-jansky-figure" data-reveal="lag">
              <img
                src="/Jansky.jpg"
                alt="Karl Jansky's rotating directional radio antenna array"
                className="h1-jansky-image"
                loading="lazy"
                decoding="async"
              />
              <figcaption className="h1-jansky-caption">
                Karl Jansky, working at Bell Telephone Laboratories in Holmdel, NJ, built this antenna to receive radio waves at a frequency of 20.5 MHz (wavelength about 14.5 meters). It was mounted on a turntable that allowed it to rotate in any direction, earning it the name "Jansky's merry-go-round".
              </figcaption>
            </figure>
          </div>
        </section>

        <QueueFooter />

      </main>

    </div>
  );
}

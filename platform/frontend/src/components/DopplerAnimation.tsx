import { useEffect, useRef, useState } from 'react';
import { Cloud } from 'lucide-react';

import { useVisibleAnimation, STICKY_HEADER_ANIMATION_MARGIN_PX } from '../lib/useVisibleAnimation';
import { noiseSample, deterministicNoise } from '../lib/queueHeroSpectrum';
import {
  DA_W, DA_H, DA_AXIS_Y, DA_TELESCOPE_X, DA_DISH_BACK_X, DA_DISH_FEED_X,
  DA_C_PX_S, DA_T_EMIT_S, DA_MAX_R, DA_WAVE_AMP, DA_V_MAX,
  vTowardAt, sourceXAt, emitTimeAtX, dopplerColor, daFreqToX,
  DA_MINI_LEFT_X, DA_MINI_W, DA_MINI_CX, DA_MINI_TOP_Y, DA_MINI_HEADER_Y,
  DA_MINI_PLOT_TOP_Y, DA_MINI_BASE_Y, DA_MINI_BOTTOM_PAD, DA_MINI_PLOT_LEFT_X,
  DA_MINI_PLOT_RIGHT_X, DA_MINI_PLOT_W, DA_MINI_PEAK_PX, DA_MINI_PEAK_SIGMA,
  DA_MINI_BINS, DA_MINI_NOISE_AMP, DA_MINI_NOISE_TAU_S, DA_MINI_HALF_RANGE,
  DA_MINI_GRID_MHZ, DA_MINI_REST_LABEL_MHZ,
} from '../lib/dopplerAnimation';

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

export function DopplerAnimation({ renderTimeSeconds, paused = false }: { renderTimeSeconds?: number; paused?: boolean } = {}) {
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

      // Update the mini spectrum bins: gaussian peak centered on the source's
      // instantaneous velocity (light-travel delay ignored, so the peak tracks
      // the velocity readout under the cloud), perturbed by per-frame receiver
      // noise and low-passed across frames so the trace breathes rather than
      // strobes.
      const dt = Math.max(0.001, Math.min(0.1, newT - lastTickT));
      lastTickT = newT;
      const alpha = 1 - Math.exp(-dt / DA_MINI_NOISE_TAU_S);
      const vSource = vTowardAt(newT);
      const peakCenter = DA_MINI_CX + (vSource / DA_V_MAX) * DA_MINI_HALF_RANGE;
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
  const wfs: Array<{ cx: number; r: number; opacity: number }> = [];
  for (let i = firstI; i <= lastI; i++) {
    const emitT = i * DA_T_EMIT_S;
    const age = t - emitT;
    const r = age * DA_C_PX_S;
    if (r > DA_MAX_R) continue;
    const emitX = sourceXAt(emitT);
    const fade = 1 - Math.max(0, r - DA_MAX_R * 0.55) / (DA_MAX_R * 0.45);
    wfs.push({ cx: emitX, r, opacity: Math.max(0, fade) * 0.55 });
  }
  // Build the sine-wave path from telescope to source by marching the
  // wave-propagation equation parametrically in emission time. A wavefront
  // emitted at emitT has its leftmost edge at
  //
  //   x(emitT) = sourceXAt(emitT) - C·(t - emitT)
  //
  // which is strictly increasing in emitT (because |v_toward| < C), so
  // stepping emitT forward traces the wave left-to-right directly - no
  // per-pixel root-finding. The wave field at that x is the source signal
  // *at* emitT - `cos(2π · emitT / T_EMIT)` - which puts crests exactly on
  // the leftmost edges of the integer-emission wavefronts (since those occur
  // when emitT is a multiple of T_EMIT). Local wavelength naturally
  // compresses where the source was approaching at that emit time and
  // stretches where it was receding, with no per-frame phase wobble.
  const waveStart = DA_DISH_FEED_X;
  const waveEnd = sourceX - 54;
  const wavePts: Array<{ x: number; y: number; emitT: number }> = [];
  if (waveEnd > waveStart) {
    const emitLo = t - DA_MAX_R / DA_C_PX_S;
    const xAtEmitLo = sourceXAt(emitLo) - DA_C_PX_S * (t - emitLo);
    // Start at the dish feed, or at the oldest tracked wavefront if it hasn't
    // reached the feed yet.
    let emitT = xAtEmitLo >= waveStart ? emitLo : emitTimeAtX(t, waveStart);
    for (;;) {
      const x = sourceXAt(emitT) - DA_C_PX_S * (t - emitT);
      if (x > waveEnd) break;
      // Mod into [0,1) before multiplying by 2π to keep float precision sharp
      // for long sessions; cos is periodic so this is exact.
      const phaseFrac = ((emitT / DA_T_EMIT_S) % 1 + 1) % 1;
      const y = DA_AXIS_Y - DA_WAVE_AMP * Math.cos(2 * Math.PI * phaseFrac);
      wavePts.push({ x, y, emitT });
      // dx/d(emitT) = C - v_toward, so this advances x by ~1.5 px.
      emitT += 1.5 / (DA_C_PX_S - vTowardAt(emitT));
    }
  }
  // Colour varies slowly along the wave (and not at all during dwells), so
  // merge contiguous same-colour segments into single polyline paths instead
  // of emitting one two-point <path> per 1.5 px step.
  const waveRuns: Array<{ d: string; color: string }> = [];
  for (let i = 1; i < wavePts.length; i++) {
    const prev = wavePts[i - 1];
    const pt = wavePts[i];
    const emitMid = (prev.emitT + pt.emitT) / 2;
    const color = dopplerColor(vTowardAt(emitMid) / DA_C_PX_S);
    const lastRun = waveRuns[waveRuns.length - 1];
    if (lastRun && lastRun.color === color) {
      lastRun.d += ` L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
    } else {
      waveRuns.push({
        d: `M ${prev.x.toFixed(1)},${prev.y.toFixed(1)} L ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`,
        color,
      });
    }
  }
  // The mini spectrum shows the signal the cloud is emitting right now, so its
  // colour follows the source's instantaneous velocity.
  const spectrumColor = dopplerColor(vToward / DA_C_PX_S);

  // Build the mini spectrum trace from the smoothed bin values updated in the
  // rAF loop.
  const miniPeakCenter = DA_MINI_CX + (vToward / DA_V_MAX) * DA_MINI_HALF_RANGE;
  const miniBins = isRenderFrame
    ? Array.from({ length: DA_MINI_BINS }, (_, i) => {
      const x = DA_MINI_PLOT_LEFT_X + (i / (DA_MINI_BINS - 1)) * DA_MINI_PLOT_W;
      const dx = x - miniPeakCenter;
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

      {waveRuns.map((run, i) => (
        <path
          key={i}
          d={run.d}
          fill="none"
          stroke={run.color}
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
          <stop offset="0%"   stopColor={spectrumColor} stopOpacity="0.22" />
          <stop offset="100%" stopColor={spectrumColor} stopOpacity="0" />
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
        stroke={spectrumColor}
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

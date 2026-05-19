import A from 'aladin-lite';
import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { Layers, Maximize2, Telescope } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  altAzToRaDec,
  HYDROGEN_LINE_MHZ,
  isInsideTriangle,
  moonIllumination,
  moonRaDec,
  normalizeDeg,
  positionAngleDeg,
  raDecToAltAz,
  sunRaDec,
} from '../lib/astro';
import type { AltAzPoint, RaDecTarget, RoboClawTelemetry, SkyOverlay, TelescopeConfig } from '../types';

echarts.use([LineChart, GridComponent, CanvasRenderer]);

// ─── Camera PIP ───────────────────────────────────────────────────────────────

function CameraPip({ swapped, onToggleSwap }: { swapped: boolean; onToggleSwap: () => void }) {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState('Cam A');
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/api/camera/status')
      .then((r) => r.json())
      .then((d: { enabled: boolean; label: string }) => {
        setEnabled(d.enabled);
        setLabel(d.label);
      })
      .catch(() => {/* non-critical */});
  }, []);

  if (!enabled) return null;

  return (
    <div className={`cam-pip${error ? ' cam-pip-error' : ''}${swapped ? ' cam-pip-swapped' : ''}`}>
      <img
        className="cam-pip-feed"
        src="/api/camera/stream"
        alt="Camera feed"
        onError={() => {
          setError(true);
          setEnabled(false);
        }}
        onLoad={() => setError(false)}
      />
      {error ? (
        <div className="cam-pip-offline">No signal</div>
      ) : (
        <div className="cam-pip-live"><span className="cam-pip-dot" />LIVE</div>
      )}
      <button
        type="button"
        className="cam-pip-fullscreen"
        onClick={onToggleSwap}
        title={swapped ? 'Restore sky map' : 'Swap with sky map'}
        aria-label={swapped ? 'Restore sky map' : 'Swap with sky map'}
        aria-pressed={swapped}
      >
        <Maximize2 size={13} />
      </button>
      <div className="cam-pip-label">{label}</div>
    </div>
  );
}

// ─── Component-local helpers ─────────────────────────────────────────────────
// Math primitives (degrees / coordinate transforms / solar + lunar position)
// live in `../lib/astro.ts`; only the SkyMap-specific helpers stay here.

const TARGET_CLICK_DRAG_TOLERANCE_PX = 6;

function localUpOrientationDeg(center: RaDecTarget, config: TelescopeConfig, date: Date): number {
  const centerAltAz = raDecToAltAz(center.ra_deg, center.dec_deg, config, date);
  const upAlt = Math.min(89.5, centerAltAz.altitude_deg + 1);
  const localUp = altAzToRaDec(
    { altitude_deg: upAlt, azimuth_deg: centerAltAz.azimuth_deg },
    config,
    date,
  );
  return positionAngleDeg(center, localUp);
}

function initialHorizonRotationDeg(center: RaDecTarget, config: TelescopeConfig, date: Date): number {
  const rotation = normalizeDeg(360 - localUpOrientationDeg(center, config, date));
  return rotation === 0 ? 0.001 : rotation;
}

// ─── Canvas body-icon helpers ─────────────────────────────────────────────────

/**
 * Draws the sun as an accurately-sized disc.
 * r is the pixel radius derived from the current Aladin projection so the
 * disc matches the sun's true ~0.53° angular diameter at whatever zoom level
 * the viewer is at.
 */
function drawSunIcon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  // Limb darkening: centre is near-white, edge deepens to amber
  const disc = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  disc.addColorStop(0,   '#fffde8');  // bright white-yellow core
  disc.addColorStop(0.55, '#ffe030'); // yellow mid-disc
  disc.addColorStop(1,   '#ffb000');  // amber limb
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = disc;
  ctx.fill();
}

/**
 * Draws the moon disc with the correct phase shape.
 *
 * Uses the two-arc path technique: the lit region is bounded by an outer
 * semicircle on the lit side and the terminator ellipse arc on the other
 * side, then filled in a single path — no masking or composite ops needed.
 *
 * fraction : 0 = new moon, 1 = full moon
 * waxing   : true → lit on the right, false → lit on the left
 */
function drawMoonIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  fraction: number,
  waxing: boolean,
): void {
  // Subtle corona
  const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.4);
  glow.addColorStop(0,   'rgba(200, 218, 255, 0.22)');
  glow.addColorStop(1,   'rgba(180, 200, 255, 0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.4, 0, 2 * Math.PI);
  ctx.fillStyle = glow;
  ctx.fill();

  // c runs −1 (new) → 0 (quarter) → +1 (full)
  const c  = 2 * fraction - 1;
  // Half-width of the terminator ellipse; small epsilon avoids a degenerate arc
  const rx = Math.max(0.5, Math.abs(c) * r);

  // Dark disc — shadow side fill so the moon is opaque against the survey
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.fillStyle = '#0c1a2e';
  ctx.fill();

  // ── Phase shape ───────────────────────────────────────────────────────────
  // Path: outer semicircle (lit side) + terminator ellipse arc (closing return).
  // For gibbous (c > 0): ellipse bulges toward the dark side → counterclockwise.
  // For crescent (c < 0): ellipse bulges toward the lit side → clockwise.
  // Both arcs run top→bottom then bottom→top so the path closes perfectly.

  ctx.beginPath();
  if (waxing) {
    // Lit on the right
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false);            // right semicircle ↓
    ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, c > 0); // terminator ↑
  } else {
    // Lit on the left
    ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, true);             // left semicircle ↓
    ctx.ellipse(cx, cy, rx, r, 0, Math.PI / 2, -Math.PI / 2, c < 0); // terminator ↑
  }
  ctx.closePath();
  ctx.fillStyle = '#dde8ff';
  ctx.fill();

  // Disc outline — faint ring so a thin crescent or new moon is still locatable
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = 'rgba(180, 200, 255, 0.35)';
  ctx.lineWidth   = 1;
  ctx.stroke();
}

function pointInPolygon(x: number, y: number, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ─── Survey definitions ──────────────────────────────────────────────────────
const SURVEYS = [
  {
    id: 'CDS/P/HI4PI/NHI',
    label: '21cm Hydrogen Line',
    shortLabel: 'H I 1420',
    title: 'HI4PI 21cm neutral hydrogen column density',
    description: 'Neutral hydrogen column density at 1420 MHz — the telescope\'s primary science target.',
    spectrumMhz: HYDROGEN_LINE_MHZ,
    markerLeft: 42,
  },
  {
    id: 'CDS/P/PLANCK/R3/LFI/color',
    label: 'Planck LFI',
    shortLabel: 'Planck LFI',
    title: 'Planck R3 LFI 30/44/70 GHz color composition',
    description: 'Microwave sky at 30-70 GHz - synchrotron, free-free emission, and CMB foreground structure.',
    spectrumMhz: 44_000,
    markerLeft: 49,
  },
  {
    id: 'CDS/P/PLANCK/R3/HFI/color',
    label: 'Planck HFI',
    shortLabel: 'Planck HFI',
    title: 'Planck R3 HFI 353/545/857 GHz color composition',
    description: 'Submillimeter sky at 353-857 GHz - thermal dust emission and cold galactic clouds.',
    spectrumMhz: 545_000,
    markerLeft: 55,
  },
  {
    id: 'CDS/P/AKARI/FIS/Color',
    label: 'AKARI FIS',
    shortLabel: 'AKARI',
    title: 'AKARI FIS far-infrared all-sky color survey',
    description: 'Far-infrared (65–160 µm) — cold dust, molecular clouds, and star-forming regions.',
    spectrumMhz: 3_100_000,
    markerLeft: 58,
  },
  {
    id: 'CDS/P/allWISE/color',
    label: 'AllWISE',
    shortLabel: 'AllWISE',
    title: 'AllWISE infrared all-sky color survey',
    description: 'Near/mid-infrared (3.4–22 µm) — stellar populations, AGN, and dusty galaxies.',
    spectrumMhz: 25_000_000,
    markerLeft: 72,
  },
  {
    id: 'CDS/P/2MASS/color',
    label: '2MASS',
    shortLabel: '2MASS',
    title: '2MASS near-infrared color survey',
    description: 'Near-infrared JHK (1.2–2.2 µm) — stars, the galactic bulge, and nearby galaxies.',
    spectrumMhz: 187_000_000,
    markerLeft: 79,
  },
  {
    id: 'CDS/P/DSS2/color',
    label: 'Visible Light',
    shortLabel: 'Visible',
    title: 'DSS2 optical color all-sky survey',
    description: 'Deep optical atlas (B/R/I, ~1″ resolution) digitized from photographic plates.',
    spectrumMhz: 599_000_000,
    markerLeft: 92,
  },
  {
    id: 'CDS/P/GALEXGR6/AIS/color',
    label: 'GALEX AIS',
    shortLabel: 'GALEX',
    title: 'GALEX GR6 AIS ultraviolet color survey',
    description: 'Ultraviolet sky (FUV/NUV, about 150-230 nm) - hot young stars, star-forming regions, and UV-bright galaxies.',
    spectrumMhz: 1_950_000_000,
    markerLeft: 99.2,
  },
] as const;

type SurveyId = (typeof SURVEYS)[number]['id'];

const SPECTRUM_POINTS = 320;
const MIN_FREQ_MHZ = 50;
const MAX_FREQ_MHZ = 3_000_000_000;
const VISIBLE_LOW_MHZ = 400_000_000;
const VISIBLE_HIGH_MHZ = 790_000_000;
const LOG_MIN_FREQ = Math.log10(MIN_FREQ_MHZ);
const LOG_MAX_FREQ = Math.log10(MAX_FREQ_MHZ);
const HYDROGEN_LOG_FREQ = Math.log10(HYDROGEN_LINE_MHZ);
const VISIBLE_LOW_LOG_FREQ = Math.log10(VISIBLE_LOW_MHZ);
const VISIBLE_HIGH_LOG_FREQ = Math.log10(VISIBLE_HIGH_MHZ);

function logFreqToRatio(logFreq: number): number {
  return (logFreq - LOG_MIN_FREQ) / (LOG_MAX_FREQ - LOG_MIN_FREQ);
}

function surveyDefinition(surveyId: SurveyId): (typeof SURVEYS)[number] {
  return SURVEYS.find((survey) => survey.id === surveyId) ?? SURVEYS[0];
}

function surveyLogFreq(survey: (typeof SURVEYS)[number]): number {
  return Math.log10(survey.spectrumMhz);
}


function surveyToneClass(survey: (typeof SURVEYS)[number]): string {
  if (survey.id === 'CDS/P/HI4PI/NHI') return ' hydrogen';
  if (survey.spectrumMhz >= VISIBLE_LOW_MHZ) return ' optical';
  if (survey.spectrumMhz <= 500) return ' radio';
  return '';
}

function surveySpectrumColor(survey: (typeof SURVEYS)[number]): string {
  if (survey.spectrumMhz <= 500) return 'rgba(255, 188, 66, 0.96)';
  if (survey.spectrumMhz < 2_000_000) return 'rgba(104, 158, 255, 0.96)';
  if (survey.spectrumMhz < 400_000_000) return 'rgba(220, 114, 255, 0.96)';
  if (survey.spectrumMhz <= VISIBLE_HIGH_MHZ) return 'rgba(255, 113, 82, 0.98)';
  return 'rgba(184, 91, 255, 0.92)';
}

function formatAxisNumber(value: number, digits = 3): string {
  const rounded = Number(value.toPrecision(digits));
  return rounded.toLocaleString('en-US', {
    maximumFractionDigits: Math.max(0, digits - Math.floor(Math.log10(Math.abs(rounded || 1))) - 1),
  });
}

function freqLabelFromLog(value: number): string {
  const mhz = 10 ** value;
  if (mhz >= 1_000_000_000) return `${formatAxisNumber(mhz / 1_000_000_000)} PHz`;
  if (mhz >= 1_000_000) return `${formatAxisNumber(mhz / 1_000_000)} THz`;
  if (mhz >= 1_000) return `${formatAxisNumber(mhz / 1_000)} GHz`;
  return `${formatAxisNumber(mhz)} MHz`;
}

function wavelengthLabelFromLog(value: number): string {
  const hz = (10 ** value) * 1_000_000;
  const meters = 299_792_458 / hz;
  if (meters >= 1) return `${formatAxisNumber(meters)} m`;
  if (meters >= 0.001) return `${formatAxisNumber(meters * 1000)} mm`;
  if (meters >= 0.000001) return `${formatAxisNumber(meters * 1_000_000)} um`;
  return `${formatAxisNumber(meters * 1_000_000_000)} nm`;
}

function spectrumWaveData(focusLogFreq: number): [number, number][] {
  let phase = 0;
  let previousRatio = 0;
  return Array.from({ length: SPECTRUM_POINTS }, (_, i) => {
    const ratio = i / (SPECTRUM_POINTS - 1);
    const logFreq = LOG_MIN_FREQ + ratio * (LOG_MAX_FREQ - LOG_MIN_FREQ);
    const dx = i === 0 ? 0 : ratio - previousRatio;
    previousRatio = ratio;
    const cyclesPerUnit = 1.4 + Math.pow(ratio, 1.85) * 24;
    phase += dx * cyclesPerUnit * Math.PI * 2;
    const distance = Math.abs(logFreq - focusLogFreq);
    const selected = Math.exp(-(distance * distance) / (2 * 0.14 * 0.14));
    const amplitude = 0.16 + selected * 0.11;
    const focusLift = selected * 0.055;
    return [logFreq, 0.5 + focusLift + Math.sin(phase) * amplitude];
  });
}

function nearestSurveyForLogFreq(logFreq: number): SurveyId {
  return SURVEYS.reduce((nearest, survey) => {
    const nearestDistance = Math.abs(logFreq - surveyLogFreq(nearest));
    const surveyDistance = Math.abs(logFreq - surveyLogFreq(survey));
    return surveyDistance < nearestDistance ? survey : nearest;
  }, SURVEYS[0]).id;
}

function buildSpectrumOption(
  hoverLogFreq: number | null,
  activeSurvey: SurveyId,
  animatedFocusLogFreq: number,
): EChartsOption {
  const activeDef = surveyDefinition(activeSurvey);
  const targetLogFreq = surveyLogFreq(activeDef);
  const focus = hoverLogFreq ?? animatedFocusLogFreq;
  const baseData = spectrumWaveData(focus);
  const hoverData = hoverLogFreq == null
    ? []
    : baseData.map(([x, y]) => (Math.abs(x - hoverLogFreq) <= 0.18 ? [x, y] : [x, null]));
  const selectionData = baseData.map(([x, y]) => (Math.abs(x - animatedFocusLogFreq) <= 0.22 ? [x, y] : [x, null]));
  const targetGlowData = baseData.map(([x, y]) => (Math.abs(x - targetLogFreq) <= 0.1 ? [x, y] : [x, null]));
  const visibleStart = logFreqToRatio(VISIBLE_LOW_LOG_FREQ);
  const visibleEnd = logFreqToRatio(VISIBLE_HIGH_LOG_FREQ);
  const activeColor = surveySpectrumColor(activeDef);

  return {
    animation: true,
    animationDurationUpdate: 80,
    animationEasingUpdate: 'cubicOut',
    grid: { left: 32, right: 12, top: 6, bottom: 42 },
    xAxis: {
      type: 'value',
      min: LOG_MIN_FREQ,
      max: LOG_MAX_FREQ,
      splitNumber: 4,
      axisLine: { lineStyle: { color: 'rgba(223, 230, 255, 0.28)' } },
      axisTick: { lineStyle: { color: 'rgba(223, 230, 255, 0.28)' } },
      splitLine: { show: false },
      axisLabel: {
        color: 'rgba(223, 230, 255, 0.72)',
        fontSize: 10,
        lineHeight: 13,
        formatter: (value: number) => `${freqLabelFromLog(value)}\n${wavelengthLabelFromLog(value)}`,
      },
    },
    yAxis: { type: 'value', min: 0, max: 1, show: false },
    series: [
      {
        type: 'line',
        data: baseData,
        smooth: 0.38,
        symbol: 'none',
        lineStyle: {
          width: 5,
          opacity: 1,
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0.00, color: 'rgba(76, 172, 255, 0.42)' },
            { offset: 0.22, color: 'rgba(76, 172, 255, 0.82)' },
            { offset: Math.max(0, visibleStart - 0.06), color: 'rgba(255, 95, 214, 0.78)' },
            { offset: visibleStart, color: 'rgba(139, 76, 255, 1)' },
            { offset: visibleStart + (visibleEnd - visibleStart) * 0.28, color: 'rgba(54, 108, 255, 1)' },
            { offset: visibleStart + (visibleEnd - visibleStart) * 0.50, color: 'rgba(42, 224, 118, 1)' },
            { offset: visibleStart + (visibleEnd - visibleStart) * 0.72, color: 'rgba(255, 224, 66, 1)' },
            { offset: visibleEnd, color: 'rgba(255, 82, 58, 1)' },
            { offset: Math.min(1, visibleEnd + 0.10), color: 'rgba(174, 84, 255, 0.70)' },
            { offset: 1.00, color: 'rgba(174, 84, 255, 0.34)' },
          ]),
        },
        silent: true,
      },
      {
        type: 'line',
        data: hoverData,
        smooth: 0.44,
        connectNulls: false,
        symbol: 'none',
        lineStyle: {
          width: hoverLogFreq == null ? 0 : 8,
          opacity: hoverLogFreq == null ? 0 : 0.7,
          color: 'rgba(255, 255, 255, 0.62)',
          shadowBlur: 12,
          shadowColor: 'rgba(255, 255, 255, 0.46)',
        },
        silent: true,
      },
      {
        type: 'line',
        data: selectionData,
        smooth: 0.44,
        connectNulls: false,
        symbol: 'none',
        lineStyle: {
          width: 10,
          opacity: 0.72,
          color: activeColor,
          shadowBlur: 18,
          shadowColor: activeColor,
        },
        silent: true,
      },
      {
        type: 'line',
        data: targetGlowData,
        smooth: 0.44,
        connectNulls: false,
        symbol: 'none',
        lineStyle: {
          width: 5,
          opacity: 0.98,
          color: 'rgba(255, 255, 255, 0.86)',
          shadowBlur: 14,
          shadowColor: activeColor,
        },
        silent: true,
      },
      {
        type: 'line',
        data: [[animatedFocusLogFreq, 0.12], [animatedFocusLogFreq, 0.9]],
        symbol: 'none',
        lineStyle: {
          width: 2,
          opacity: 0.76,
          color: activeColor,
          shadowBlur: 16,
          shadowColor: activeColor,
        },
        silent: true,
      },
      {
        type: 'line',
        data: [[HYDROGEN_LOG_FREQ, 0.18], [HYDROGEN_LOG_FREQ, 0.82]],
        symbol: 'none',
        lineStyle: { width: 1.5, color: 'rgba(255, 188, 66, 0.9)', type: 'dashed' },
        silent: true,
      },
    ],
  };
}

function LightSpectrumSurveySelector({
  activeSurvey,
  onSelectSurvey,
  disabled,
}: {
  activeSurvey: SurveyId;
  onSelectSurvey: (survey: SurveyId) => void;
  disabled: boolean;
}) {
  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const activeSurveyRef = useRef(activeSurvey);
  const disabledRef = useRef(disabled);
  const onSelectSurveyRef = useRef(onSelectSurvey);
  const [hoverLogFreq, setHoverLogFreq] = useState<number | null>(null);
  const [animatedFocusLogFreq, setAnimatedFocusLogFreq] = useState(() => surveyLogFreq(surveyDefinition(activeSurvey)));

  useEffect(() => { activeSurveyRef.current = activeSurvey; }, [activeSurvey]);
  useEffect(() => { disabledRef.current = disabled; }, [disabled]);
  useEffect(() => { onSelectSurveyRef.current = onSelectSurvey; }, [onSelectSurvey]);

  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;
    const chart = echarts.init(host, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.setOption(buildSpectrumOption(null, activeSurveyRef.current, surveyLogFreq(surveyDefinition(activeSurveyRef.current))));

    const updateHover = (offsetX: number) => {
      const value = chart.convertFromPixel({ gridIndex: 0 }, [offsetX, 0]) as [number, number] | undefined;
      if (!value || !Number.isFinite(value[0])) return;
      setHoverLogFreq(Math.min(LOG_MAX_FREQ, Math.max(LOG_MIN_FREQ, value[0])));
    };

    chart.getZr().on('mousemove', (event) => updateHover(event.offsetX));
    chart.getZr().on('globalout', () => setHoverLogFreq(null));
    chart.getZr().on('click', (event) => {
      if (disabledRef.current) return;
      const value = chart.convertFromPixel({ gridIndex: 0 }, [event.offsetX, 0]) as [number, number] | undefined;
      if (!value || !Number.isFinite(value[0])) return;
      onSelectSurveyRef.current(nearestSurveyForLogFreq(value[0]));
    });

    const frame = requestAnimationFrame(() => {
      chart.resize();
      chart.setOption(
        buildSpectrumOption(null, activeSurveyRef.current, surveyLogFreq(surveyDefinition(activeSurveyRef.current))),
        { notMerge: true },
      );
    });
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const target = surveyLogFreq(surveyDefinition(activeSurvey));
    let frame = 0;
    let start = 0;
    const from = animatedFocusLogFreq;
    const duration = Math.min(950, Math.max(520, Math.abs(target - from) * 110));
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const step = (time: number) => {
      if (start === 0) start = time;
      const progress = Math.min(1, (time - start) / duration);
      setAnimatedFocusLogFreq(from + (target - from) * ease(progress));
      if (progress < 1) frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [activeSurvey]);

  useEffect(() => {
    chartRef.current?.setOption(buildSpectrumOption(hoverLogFreq, activeSurvey, animatedFocusLogFreq), {
      notMerge: true,
      lazyUpdate: true,
    });
  }, [hoverLogFreq, activeSurvey, animatedFocusLogFreq]);

  const activeDef = surveyDefinition(activeSurvey);
  const hydrogenMarkerLeft = `calc(32px + ${logFreqToRatio(HYDROGEN_LOG_FREQ) * 100}% - ${logFreqToRatio(HYDROGEN_LOG_FREQ) * 44}px)`;

  return (
    <div id="skymap-spectrum-selector" className={`skymap-spectrum-selector${disabled ? ' disabled' : ''}`}>
      <p className="skymap-spectrum-capability">
        This telescope is only capable of observing at the 21cm hydrogen line. Surveys in other wavelengths of light are available for exploration.
      </p>
      <div className="skymap-spectrum-chart-shell">
        <div className="skymap-spectrum-chart" ref={chartHostRef} role="button" aria-label="Select sky survey by frequency" />
        <div className="skymap-hydrogen-line-marker" style={{ left: hydrogenMarkerLeft }} aria-hidden="true">
          <span>21cm</span>
        </div>
      </div>
      <div className="skymap-survey-list" role="radiogroup" aria-label="Survey presets">
        {SURVEYS.map((survey) => (
          <button
            key={survey.id}
            type="button"
            role="radio"
            aria-checked={activeSurvey === survey.id}
            className={`skymap-survey-btn${surveyToneClass(survey)}${activeSurvey === survey.id ? ' active' : ''}`}
            onClick={() => onSelectSurvey(survey.id)}
            disabled={disabled}
            title={survey.title}
          >
            {survey.shortLabel}
          </button>
        ))}
      </div>
      <p className="skymap-spectrum-desc">{activeDef.description}</p>
    </div>
  );
}
const DEFAULT_HORIZON_VIEW: AltAzPoint = {
  altitude_deg: 15,
  azimuth_deg: 45,
};


// â”€â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface SkyMapProps {
  telemetry: RoboClawTelemetry | null;
  config: TelescopeConfig | null;
  onNotice: (msg: string | null) => void;
  onTarget: (az: number, alt: number) => void;
  onClearTarget?: () => void;
  tooltipsEnabled: boolean;
  overlays?: SkyOverlay[];
  toolbarLeading?: ReactNode;
}

export function SkyMap({ telemetry, config, onNotice, onTarget, onClearTarget, tooltipsEnabled, overlays = [], toolbarLeading }: SkyMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const aladinRef = useRef<ReturnType<typeof A.aladin> | null>(null);
  const configRef       = useRef<TelescopeConfig | null>(null);
  const telemetryRef    = useRef<RoboClawTelemetry | null>(null);
  const pendingRef      = useRef<RaDecTarget | null>(null);
  // Updated every draw frame so the hover handler can check without a loop
  const sunZoneRef      = useRef<{ cx: number; cy: number; r: number } | null>(null);
  const beamZoneRef     = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);
  const pendingZoneRef  = useRef<{ cx: number; cy: number; r: number; fwhm: number } | null>(null);
  const beamOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const limitOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const pendingOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const horizonOverlayRef = useRef<ReturnType<typeof A.graphicOverlay> | null>(null);
  const horizonCanvasRef  = useRef<HTMLCanvasElement | null>(null);
  const targetCatalogRef = useRef<ReturnType<typeof A.catalog> | null>(null);
  const initializedRef = useRef(false);
  const onTargetRef = useRef<((az: number, alt: number) => void) | null>(null);
  const onClearTargetRef = useRef<(() => void) | null>(null);
  // Mirrored so the init effect doesn't re-run (and tear down its event handlers)
  // every time the parent passes a fresh inline callback.
  const onNoticeRef = useRef<((msg: string | null) => void) | null>(null);
  // Latest selected survey, mirrored into a ref so the click handler (attached
  // once in the init effect) can check it without being rebuilt.
  const surveyRef = useRef<SurveyId>('CDS/P/HI4PI/NHI');
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<RaDecTarget | null>(null);
  const [survey, setSurvey] = useState<SurveyId>('CDS/P/HI4PI/NHI');
  const [viewSelectorOpen, setViewSelectorOpen] = useState(false);
  const [cameraSwapped, setCameraSwapped] = useState(false);
  const [hoverTooltip, setHoverTooltip] = useState<
    | { kind: 'sun' | 'beam' | 'pending'; x: number; y: number; fwhm?: number }
    | null
  >(null);

  useEffect(() => { configRef.current    = config;    }, [config]);
  useEffect(() => { telemetryRef.current = telemetry; }, [telemetry]);
  useEffect(() => { pendingRef.current   = pending;   }, [pending]);
  useEffect(() => { onTargetRef.current  = onTarget;  }, [onTarget]);
  useEffect(() => { onClearTargetRef.current = onClearTarget ?? null; }, [onClearTarget]);
  useEffect(() => { onNoticeRef.current  = onNotice;  }, [onNotice]);
  useEffect(() => { surveyRef.current    = survey;    }, [survey]);
  useEffect(() => {
    if (!tooltipsEnabled) setHoverTooltip(null);
  }, [tooltipsEnabled]);

  // Initialise Aladin Lite once
  useEffect(() => {
    if (!containerRef.current || !config || initializedRef.current) return;
    initializedRef.current = true;
    const container = containerRef.current;
    let cancelled = false;
    let removeClickHandler: (() => void) | null = null;

    void A.init.then(() => {
      if (cancelled || !container) return;
      const initialDate = new Date();
      const initialTarget = altAzToRaDec(DEFAULT_HORIZON_VIEW, config, initialDate);
      const initialRotation = initialHorizonRotationDeg(initialTarget, config, initialDate);

      const aladin = A.aladin(container, {
        survey: 'CDS/P/HI4PI/NHI',
        fov: 80,
        target: `${initialTarget.ra_deg} ${initialTarget.dec_deg}`,
        cooFrame: 'equatorial',  // equatorial coords, view centred on NE horizon
        projection: 'STG',       // stereographic — natural perspective
        inertia: false,
        showCooGrid: false,      // we draw our own alt/az grid below for a horizon-aligned look
        showReticle: false,
        showZoomControl: false,
        showFov: false,
        showFullscreenControl: false,
        showLayersControl: false,
        showGotoControl: false,
        showStatusBar: false,
        showFrame: false,
        showCooLocation: false,
        showProjectionControl: false,
      });
      aladin.setRotation(initialRotation);

      // Keep the local zenith pinned to screen-up. The position-angle of
      // local-up depends on where the view is centred, so we recompute the
      // rotation whenever the centre moves. Two triggers:
      //   (1) An rAF loop driven by pointer-down → pointer-up. This is what
      //       makes drag smooth at any zoom: at wide FoVs each pixel of drag
      //       spans many degrees, so positionChanged alone fires too coarsely
      //       and the view visibly snaps between updates.
      //   (2) An event listener for everything else (wheel zoom, programmatic
      //       gotos) where there's no pointer drag in progress.
      let lastRotation = initialRotation;
      const applyHorizonRotation = (ra: number, dec: number) => {
        if (cancelled) return;
        const cfg = configRef.current;
        if (!cfg) return;
        if (!Number.isFinite(ra) || !Number.isFinite(dec)) return;
        const rot = initialHorizonRotationDeg({ ra_deg: ra, dec_deg: dec }, cfg, new Date());
        const diff = Math.abs(((rot - lastRotation + 540) % 360) - 180);
        if (diff < 0.005) return;
        lastRotation = rot;
        aladin.setRotation(rot);
      };

      const getCenterRaDec = (): [number, number] | null => {
        // Read RA/Dec at the screen centre via pix2world — that always
        // reflects the live view, including mid-drag, whereas Aladin's
        // getRaDec()/getCenter() are not consistently available in v3.
        const rect = container.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const v = aladin.pix2world(rect.width / 2, rect.height / 2);
        if (!Array.isArray(v) || v.length < 2) return null;
        if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
        return [v[0], v[1]];
      };

      let dragFrame = 0;
      const dragLoop = () => {
        dragFrame = 0;
        if (cancelled) return;
        const c = getCenterRaDec();
        if (c) applyHorizonRotation(c[0], c[1]);
        // Reschedule for next frame while still dragging.
        dragFrame = requestAnimationFrame(dragLoop);
      };
      const startDragLoop = () => { if (!dragFrame) dragFrame = requestAnimationFrame(dragLoop); };
      const stopDragLoop = () => { if (dragFrame) { cancelAnimationFrame(dragFrame); dragFrame = 0; } };

      // One-shot updates outside of drag (wheel zoom, programmatic gotos).
      aladin.on('positionChanged', (e: Record<string, unknown>) => {
        if (dragFrame) return; // drag loop is already updating every frame
        const ra = e.ra as number | undefined;
        const dec = e.dec as number | undefined;
        if (typeof ra === 'number' && typeof dec === 'number') {
          applyHorizonRotation(ra, dec);
        }
      });

      // Overlays — horizon drawn first so it sits under everything else
      const horizonOverlay = A.graphicOverlay({ color: 'rgba(255,126,89,0.7)', lineWidth: 2 });
      const beamOverlay    = A.graphicOverlay({ color: 'rgba(114,224,173,0.85)', lineWidth: 2 });
      const limitOverlay   = A.graphicOverlay({ color: 'rgba(255,126,89,0.85)', lineWidth: 2 });
      const pendingOverlay = A.graphicOverlay({ color: '#f3cc6b', lineWidth: 1.5 });
      aladin.addOverlay(horizonOverlay);
      aladin.addOverlay(limitOverlay);
      aladin.addOverlay(beamOverlay);
      aladin.addOverlay(pendingOverlay);


      const targetCatalog = A.catalog({
        name: 'Targets',
        color: '#f3cc6b',
        sourceSize: 10,
        shape: 'circle',
        displayLabel: true,
        labelColor: '#f3cc6b',
        labelFont: '11px "IBM Plex Sans", system-ui, sans-serif',
      });
      aladin.addCatalog(targetCatalog);

      aladinRef.current = aladin;
      beamOverlayRef.current    = beamOverlay;
      limitOverlayRef.current   = limitOverlay;
      pendingOverlayRef.current = pendingOverlay;
      horizonOverlayRef.current = horizonOverlay;
      targetCatalogRef.current  = targetCatalog;
      setReady(true);

      let activePointer: { id: number; x: number; y: number; dragged: boolean } | null = null;
      let suppressClickUntil = 0;
      const dragToleranceSq = TARGET_CLICK_DRAG_TOLERANCE_PX * TARGET_CLICK_DRAG_TOLERANCE_PX;

      const clearPendingTarget = () => {
        setPending(null);
        setHoverTooltip(null);
        onNoticeRef.current?.(null);
        onClearTargetRef.current?.();
      };

      const handleRightClick = (e: MouseEvent | PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        clearPendingTarget();
      };

      const handlePointerDown = (e: PointerEvent) => {
        if (e.pointerType === 'mouse' && e.button === 2) {
          handleRightClick(e);
          return;
        }
        if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
        activePointer = { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false };
        startDragLoop();
      };

      const handleMouseDown = (e: MouseEvent) => {
        if (e.button === 2) handleRightClick(e);
      };

      const handlePointerMove = (e: PointerEvent) => {
        if (!activePointer || e.pointerId !== activePointer.id) return;
        const dx = e.clientX - activePointer.x;
        const dy = e.clientY - activePointer.y;
        if (dx * dx + dy * dy > dragToleranceSq) activePointer.dragged = true;
      };

      const handlePointerUp = (e: PointerEvent) => {
        if (!activePointer || e.pointerId !== activePointer.id) return;
        if (activePointer.dragged) suppressClickUntil = performance.now() + 500;
        activePointer = null;
        stopDragLoop();
      };

      const handlePointerCancel = (e: PointerEvent) => {
        if (!activePointer || e.pointerId !== activePointer.id) return;
        if (activePointer.dragged) suppressClickUntil = performance.now() + 500;
        activePointer = null;
        stopDragLoop();
      };

      // Click: pix2world returns [ra, dec] in equatorial mode, so use it directly.
      const handleClick = (e: MouseEvent) => {
        if (suppressClickUntil > 0) {
          const shouldSuppress = performance.now() <= suppressClickUntil;
          suppressClickUntil = 0;
          if (shouldSuppress) return;
        }

        // Non-hydrogen surveys are exploration-only — the telescope is a 21 cm
        // instrument and pointing at, say, an infrared source would just put
        // the beam somewhere meaningless. Drop the click silently rather than
        // setting a target the user can't actually observe.
        if (surveyRef.current !== 'CDS/P/HI4PI/NHI') return;

        const rect = container.getBoundingClientRect();
        const coords = aladin.pix2world(e.clientX - rect.left, e.clientY - rect.top);
        if (!coords || coords.length !== 2 || !isFinite(coords[0]) || !isFinite(coords[1])) return;

        const ra_deg = coords[0];
        const dec_deg = coords[1];
        const currentConfig = configRef.current;
        if (!currentConfig) return;

        const altAz = raDecToAltAz(ra_deg, dec_deg, currentConfig, new Date());

        // In simulated mode skip all limit checks — no hardware to protect
        const isSimulated = telemetryRef.current?.connection.mode === 'simulated';
        if (!isSimulated) {
          if (altAz.altitude_deg < 0) {
            onNoticeRef.current?.('Selected point is below the horizon.');
            return;
          }
          if (currentConfig.pointing_limit_altaz.length === 3 &&
              !isInsideTriangle(altAz, currentConfig.pointing_limit_altaz)) {
            clearPendingTarget();
            onNoticeRef.current?.('Selected target is outside configured pointing limits.');
            return;
          }
        }

        onNoticeRef.current?.(null);
        setPending({ ra_deg, dec_deg });
        onTargetRef.current?.(altAz.azimuth_deg, altAz.altitude_deg);
      };
      container.addEventListener('pointerdown', handlePointerDown, true);
      container.addEventListener('mousedown', handleMouseDown, true);
      container.addEventListener('contextmenu', handleRightClick, true);
      container.addEventListener('pointermove', handlePointerMove, true);
      container.addEventListener('pointerup', handlePointerUp, true);
      container.addEventListener('pointercancel', handlePointerCancel, true);
      container.addEventListener('click', handleClick);
      removeClickHandler = () => {
        container.removeEventListener('pointerdown', handlePointerDown, true);
        container.removeEventListener('mousedown', handleMouseDown, true);
        container.removeEventListener('contextmenu', handleRightClick, true);
        container.removeEventListener('pointermove', handlePointerMove, true);
        container.removeEventListener('pointerup', handlePointerUp, true);
        container.removeEventListener('pointercancel', handlePointerCancel, true);
        container.removeEventListener('click', handleClick);
      };
    });

    return () => {
      cancelled = true;
      removeClickHandler?.();
    };
  }, [config]);

  // Change survey
  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (survey === 'CDS/P/HI4PI/NHI') {
      aladinRef.current.setImageLayer(
        A.imageHiPS('CDS/P/HI4PI/NHI', {
          name: 'HI4PI colorized hydrogen line',
          colormap: 'inferno',
          stretch: 'asinh',
        }),
      );
      return;
    }

    aladinRef.current.setImageSurvey(survey);
  }, [survey, ready]);

  // Cardinal labels and horizon line are drawn by the canvas overlay below.
  // Clear the Aladin graphic overlay so it doesn't add noise.
  useEffect(() => {
    if (!ready || !horizonOverlayRef.current) return;
    horizonOverlayRef.current.removeAll();
  }, [ready]);

  // Canvas horizon overlay — ground fill + horizon line, tracks pan/zoom via rAF.
  // To swap in a real panorama, replace the fillStyle block with ctx.drawImage(panoramaImg, …)
  // mapped to the same clipping polygon.
  useEffect(() => {
    if (!ready || !config) return;
    const canvas = horizonCanvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Cache horizon + alt/az grid RA/Dec samples (recomputed every ~30 s as Earth rotates)
    let horizonRaDec: RaDecTarget[] = [];
    // Almucantars: rings of constant altitude, sampled around the full azimuth range
    let almucantars: { altitude_deg: number; samples: RaDecTarget[] }[] = [];
    // Meridians: lines of constant azimuth, sampled from horizon to zenith
    let meridians: { azimuth_deg: number; samples: RaDecTarget[] }[] = [];
    let lastSampleTime = -Infinity;

    const ALT_RINGS = [15, 30, 45, 60, 75];
    const AZ_LINES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

    const refreshHorizonSamples = () => {
      const date = new Date();
      horizonRaDec = [];
      for (let az = 0; az < 360; az += 2) {
        horizonRaDec.push(altAzToRaDec({ altitude_deg: 0, azimuth_deg: az }, config, date));
      }
      almucantars = ALT_RINGS.map((alt) => {
        const samples: RaDecTarget[] = [];
        for (let az = 0; az < 360; az += 4) {
          samples.push(altAzToRaDec({ altitude_deg: alt, azimuth_deg: az }, config, date));
        }
        return { altitude_deg: alt, samples };
      });
      meridians = AZ_LINES.map((az) => {
        const samples: RaDecTarget[] = [];
        for (let alt = 0; alt <= 88; alt += 2) {
          samples.push(altAzToRaDec({ altitude_deg: alt, azimuth_deg: az }, config, date));
        }
        return { azimuth_deg: az, samples };
      });
      lastSampleTime = Date.now();
    };

    const drawProjectedPolyline = (
      ctx: CanvasRenderingContext2D,
      aladin: ReturnType<typeof A.aladin>,
      samples: RaDecTarget[],
      wrap: boolean,
      w: number,
      h: number,
    ) => {
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
    };

    let frameId: number;
    let dashOffset = 0;

    const draw = () => {
      const date = new Date();
      if (Date.now() - lastSampleTime > 30_000) refreshHorizonSamples();

      const aladin = aladinRef.current;
      if (!aladin) { frameId = requestAnimationFrame(draw); return; }

      // Resize canvas to match container
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

      // Project horizon samples from RA/Dec → canvas pixels
      const px: [number, number][] = [];
      for (const { ra_deg, dec_deg } of horizonRaDec) {
        const p = aladin.world2pix(ra_deg, dec_deg);
        if (p && isFinite(p[0]) && isFinite(p[1])) px.push([p[0], p[1]]);
      }

      if (px.length < 4) { frameId = requestAnimationFrame(draw); return; }

      // ── Ground fill ────────────────────────────────────────────────────────
      // Probe a point well below the horizon to decide which side of the
      // polygon is "ground". When the view rotates / pans so the projection
      // centre is below the horizon, the polygon's *interior* in screen space
      // becomes the ground; otherwise the *exterior* is ground.
      let groundIsInside = false;
      for (const probeAz of [180, 0, 90, 270]) {
        const probe = altAzToRaDec({ altitude_deg: -45, azimuth_deg: probeAz }, config, date);
        const pp = aladin.world2pix(probe.ra_deg, probe.dec_deg);
        if (pp && isFinite(pp[0]) && isFinite(pp[1])) {
          groundIsInside = pointInPolygon(pp[0], pp[1], px);
          break;
        }
      }

      ctx.beginPath();
      if (!groundIsInside) {
        // Fill area outside polygon (default: looking at the sky from above).
        ctx.rect(0, 0, w, h);
      }
      ctx.moveTo(px[0][0], px[0][1]);
      for (const [x, y] of px.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();

      // ── Panorama placeholder ───────────────────────────────────────────────
      // Replace this block with ctx.drawImage(yourPanoramaImg, …) once you
      // have a real image. The clipping polygon above will stay the same.
      ctx.fillStyle = 'rgba(18, 38, 14, 0.82)';
      ctx.fill('evenodd');

      // ── Alt/az grid (almucantars + meridians) ─────────────────────────────
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

      // ── Horizon line ───────────────────────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(px[0][0], px[0][1]);
      for (const [x, y] of px.slice(1)) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255, 126, 89, 0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // ── Cardinal direction labels ──────────────────────────────────────────
      // Drawn just below the horizon line so they sit in the ground fill.
      const cardinals = [
        { label: 'N',  az: 0,   bold: true  },
        { label: 'NE', az: 45,  bold: false },
        { label: 'E',  az: 90,  bold: true  },
        { label: 'SE', az: 135, bold: false },
        { label: 'S',  az: 180, bold: true  },
        { label: 'SW', az: 225, bold: false },
        { label: 'W',  az: 270, bold: true  },
        { label: 'NW', az: 315, bold: false },
      ];

      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';

      for (const { label, az, bold } of cardinals) {
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

      // ── Slew-path line ───────────────────────────────────────────────────
      const pendingTarget = pendingRef.current;
      const tel = telemetryRef.current;
      if (pendingTarget && tel) {
        // Resolve telescope RA/Dec via the same conversion the click handler uses,
        // so the line lands on the same pixel as the beam circle.
        let telRa: number | null = null;
        let telDec: number | null = null;
        if (tel.altitude_deg != null && tel.azimuth_deg != null) {
          const pt = altAzToRaDec({ altitude_deg: tel.altitude_deg, azimuth_deg: tel.azimuth_deg }, config, date);
          telRa  = pt.ra_deg;
          telDec = pt.dec_deg;
        } else {
          telRa  = tel.ra_deg  ?? null;
          telDec = tel.dec_deg ?? null;
        }

        if (telRa != null && telDec != null) {
          const pTel     = aladin.world2pix(telRa, telDec);
          const pPending = aladin.world2pix(pendingTarget.ra_deg, pendingTarget.dec_deg);

          if (pTel     && isFinite(pTel[0])     && isFinite(pTel[1]) &&
              pPending && isFinite(pPending[0])  && isFinite(pPending[1])) {
            dashOffset = (dashOffset + 0.4) % 22;

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
          }
        }
      }

      // ── Sun & Moon ────────────────────────────────────────────────────────
      const sunPos  = sunRaDec(date);
      const moonPos = moonRaDec(date);
      const { fraction, waxing } = moonIllumination(sunPos, moonPos);

      // Body pixel radii: project a point one apparent radius away in
      // declination and measure the pixel distance — accurate at any zoom level.
      const SUN_ANG_RADIUS_DEG  = 0.2655;
      const MOON_ANG_RADIUS_DEG = 0.2591;
      const SUN_EXCLUSION_DEG   = 15;
      const pSunEdge      = aladin.world2pix(sunPos.ra_deg, sunPos.dec_deg + SUN_ANG_RADIUS_DEG);
      const pMoonEdge     = aladin.world2pix(moonPos.ra_deg, moonPos.dec_deg + MOON_ANG_RADIUS_DEG);
      const pSunExclusion = aladin.world2pix(sunPos.ra_deg, sunPos.dec_deg + SUN_EXCLUSION_DEG);

      // Reset each frame so the hover handler sees null when sun is below horizon
      sunZoneRef.current = null;

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
            sunZoneRef.current = { cx: p[0], cy: p[1], r: exclR };

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

      // ── FWHM ring hover zones ─────────────────────────────────────────────
      // Project ring centres + a point one FWHM/2 away in declination so the
      // pixel radius matches what Aladin draws for the overlay circles.
      const fwhmDeg = configRef.current?.beam_fwhm_deg ?? 6.5;
      beamZoneRef.current = null;
      const tel2 = telemetryRef.current;
      if (tel2?.altitude_deg != null && tel2?.azimuth_deg != null && configRef.current) {
        const beamRaDec = altAzToRaDec(
          { altitude_deg: tel2.altitude_deg, azimuth_deg: tel2.azimuth_deg },
          configRef.current, date,
        );
        const pCen = aladin.world2pix(beamRaDec.ra_deg, beamRaDec.dec_deg);
        const pEdge = aladin.world2pix(beamRaDec.ra_deg, beamRaDec.dec_deg + fwhmDeg / 2);
        if (pCen && pEdge && isFinite(pCen[0]) && isFinite(pEdge[0])) {
          beamZoneRef.current = {
            cx: pCen[0], cy: pCen[1],
            r: Math.max(6, Math.hypot(pEdge[0] - pCen[0], pEdge[1] - pCen[1])),
            fwhm: fwhmDeg,
          };
        }
      }

      pendingZoneRef.current = null;
      const pend = pendingRef.current;
      if (pend) {
        const pCen = aladin.world2pix(pend.ra_deg, pend.dec_deg);
        const pEdge = aladin.world2pix(pend.ra_deg, pend.dec_deg + fwhmDeg / 2);
        if (pCen && pEdge && isFinite(pCen[0]) && isFinite(pEdge[0])) {
          pendingZoneRef.current = {
            cx: pCen[0], cy: pCen[1],
            r: Math.max(6, Math.hypot(pEdge[0] - pCen[0], pEdge[1] - pCen[1])),
            fwhm: fwhmDeg,
          };
        }
      }

      frameId = requestAnimationFrame(draw);
    };

    frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [ready, config]);

  // Project the fixed Alt/Az pointing-limit triangle onto the current sky.
  useEffect(() => {
    if (!ready || !limitOverlayRef.current) return;

    limitOverlayRef.current.removeAll();
    if (config && config.pointing_limit_altaz.length === 3) {
      const date = telemetry?.timestamp != null
        ? new Date(telemetry.timestamp * 1000)
        : new Date();
      const vertices = config.pointing_limit_altaz.map((point) => altAzToRaDec(point, config, date));
      const polyline = vertices.map((point): [number, number] => [point.ra_deg, point.dec_deg]);
      limitOverlayRef.current.add(
        A.polyline([...polyline, polyline[0]], {
          color: 'rgba(255,126,89,0.9)',
          lineWidth: 2,
        }),
      );
      vertices.forEach((point) => {
        limitOverlayRef.current?.add(
          A.circle(point.ra_deg, point.dec_deg, 0.08, {
            color: '#ff7e59',
            lineWidth: 2,
          }),
        );
      });
    }
  }, [config, ready, telemetry?.timestamp]);

  // Update beam circle on every telemetry tick
  useEffect(() => {
    if (!ready || !beamOverlayRef.current) return;
    const fwhm = config?.beam_fwhm_deg ?? 6.5;

    // Always derive RA/Dec from Alt/Az on the client so the round-trip stays
    // consistent with the click handler (both go through raDecToAltAz/altAzToRaDec).
    // Backend katpoint RA/Dec uses full corrections and disagrees by ~1° near the
    // horizon, which would make the beam land in the wrong place after "Set as Current".
    let ra_deg: number | null = null;
    let dec_deg: number | null = null;
    if (config && telemetry?.altitude_deg != null && telemetry?.azimuth_deg != null) {
      const pt = altAzToRaDec(
        { altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg },
        config, new Date(),
      );
      ra_deg  = pt.ra_deg;
      dec_deg = pt.dec_deg;
    } else {
      ra_deg  = telemetry?.ra_deg  ?? null;
      dec_deg = telemetry?.dec_deg ?? null;
    }

    beamOverlayRef.current.removeAll();
    if (ra_deg != null && dec_deg != null) {
      // Outer glow ring (2Ã— FWHM radius, translucent)
      beamOverlayRef.current.add(
        A.circle(ra_deg, dec_deg, fwhm, { color: 'rgba(114,224,173,0.10)', lineWidth: 1 }),
      );
      // FWHM boundary ring
      beamOverlayRef.current.add(
        A.circle(ra_deg, dec_deg, fwhm / 2, { color: 'rgba(114,224,173,0.85)', lineWidth: 2 }),
      );
      // Centre dot
      beamOverlayRef.current.add(
        A.circle(ra_deg, dec_deg, 0.04, { color: '#72e0ad', lineWidth: 3 }),
      );
    }
  }, [telemetry, config, ready]);

  // Update the selected target marker and its FWHM footprint.
  useEffect(() => {
    if (!ready || !pendingOverlayRef.current) return;

    pendingOverlayRef.current.removeAll();
    if (pending) {
      const fwhm = config?.beam_fwhm_deg ?? 6.5;
      pendingOverlayRef.current.add(
        A.circle(pending.ra_deg, pending.dec_deg, fwhm / 2, {
          color: 'rgba(243,204,107,0.9)',
          lineWidth: 2,
        }),
      );
      pendingOverlayRef.current.add(
        A.circle(pending.ra_deg, pending.dec_deg, 0.04, {
          color: '#f3cc6b',
          lineWidth: 3,
        }),
      );
    }
  }, [pending, config, ready]);

  // Named target markers supplied by the backend or parent component.
  useEffect(() => {
    if (!ready || !targetCatalogRef.current) return;

    targetCatalogRef.current.removeAll();
    targetCatalogRef.current.addSources(
      overlays.map((overlay) =>
        A.source(overlay.ra_deg, overlay.dec_deg, {
          name: overlay.label,
          id: overlay.id,
          color: overlay.color,
        }),
      ),
    );
  }, [overlays, ready]);

  const fmtAltAz = (alt: number, az: number) =>
    `Az ${az.toFixed(1)}°  ·  Alt ${alt.toFixed(1)}°`;

  const pendingAltAz = pending && config
    ? raDecToAltAz(pending.ra_deg, pending.dec_deg, config, new Date())
    : null;

  const handleSolarHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (!tooltipsEnabled) { setHoverTooltip(null); return; }

    // Prefer the smallest ring under the cursor so the pending target wins
    // when it overlaps the (larger) solar exclusion zone.
    const candidates: { kind: 'sun' | 'beam' | 'pending'; r: number; fwhm?: number }[] = [];
    const beam = beamZoneRef.current;
    if (beam && Math.hypot(mx - beam.cx, my - beam.cy) < beam.r) {
      candidates.push({ kind: 'beam', r: beam.r, fwhm: beam.fwhm });
    }
    const pend = pendingZoneRef.current;
    if (pend && Math.hypot(mx - pend.cx, my - pend.cy) < pend.r) {
      candidates.push({ kind: 'pending', r: pend.r, fwhm: pend.fwhm });
    }
    const sun = sunZoneRef.current;
    if (sun && Math.hypot(mx - sun.cx, my - sun.cy) < sun.r) {
      candidates.push({ kind: 'sun', r: sun.r });
    }
    if (candidates.length === 0) { setHoverTooltip(null); return; }
    candidates.sort((a, b) => a.r - b.r);
    const pick = candidates[0];
    setHoverTooltip({ kind: pick.kind, x: mx, y: my, fwhm: pick.fwhm });
  };

  const handleSkyMapLeave = () => {
    setHoverTooltip(null);
  };

  return (
    <div
      className={`skymap-wrapper${cameraSwapped ? ' skymap-wrapper-swapped' : ''}${
        survey !== 'CDS/P/HI4PI/NHI' ? ' skymap-wrapper-explore' : ''
      }`}
      onMouseMove={handleSolarHover}
      onMouseLeave={handleSkyMapLeave}
    >
      <div className="skymap-aladin" ref={containerRef} />
      <canvas className="skymap-horizon-canvas" ref={horizonCanvasRef} />

      <div className="skymap-toolbar" aria-label="Sky map controls">
        {toolbarLeading}
        <div className="skymap-layer-control">
          <button
            type="button"
            className={`skymap-control-label${viewSelectorOpen ? ' active' : ''}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setViewSelectorOpen((open) => !open);
            }}
            aria-expanded={viewSelectorOpen}
            aria-controls="skymap-spectrum-selector"
            title={viewSelectorOpen ? 'Hide survey selector' : 'Show survey selector'}
          >
            <Layers size={13} />
            View
          </button>
          {viewSelectorOpen && (
            <LightSpectrumSurveySelector activeSurvey={survey} onSelectSurvey={setSurvey} disabled={!ready} />
          )}
        </div>
      </div>

      {viewSelectorOpen && (
        <div className="skymap-surveys skymap-surveys-mobile" role="group" aria-label="Sky survey">
          {SURVEYS.filter((s) => s.id === 'CDS/P/HI4PI/NHI' || s.id === 'CDS/P/DSS2/color').map((s) => (
            <button
              key={s.id}
              type="button"
              className={`skymap-survey-btn${surveyToneClass(s)}${survey === s.id ? ' active' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setSurvey(s.id);
              }}
              title={s.title}
              disabled={!ready}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {(pendingAltAz || (telemetry?.altitude_deg != null && telemetry.azimuth_deg != null)) && (
        <div className="skymap-altaz-chip">
          {pendingAltAz ? (
            <span className="skymap-altaz-target">{fmtAltAz(pendingAltAz.altitude_deg, pendingAltAz.azimuth_deg)}</span>
          ) : (
            <span>{fmtAltAz(telemetry!.altitude_deg!, telemetry!.azimuth_deg!)}</span>
          )}
          {survey !== 'CDS/P/HI4PI/NHI' && (
            <span className="skymap-explore-badge" title="Pointing is locked on exploration surveys — switch to H I 1420 to set a target.">
              Explore only
            </span>
          )}
        </div>
      )}

      {!ready && (
        <div className="skymap-loading">
          <Telescope size={24} className="skymap-loading-icon" />
          <span>Loading sky atlas</span>
        </div>
      )}

      {tooltipsEnabled && hoverTooltip && (
        <div
          className="skymap-solar-tooltip"
          style={{ left: hoverTooltip.x + 14, top: hoverTooltip.y + 14 }}
        >
          {hoverTooltip.kind === 'sun' && (
            <>
              <strong>Range of Solar Influence</strong>
              <p>Pointing within 15 deg of the Sun will likely overwhelm the hydrogen signal</p>
            </>
          )}
          {hoverTooltip.kind === 'beam' && (
            <>
              <strong>Telescope Beam (FWHM)</strong>
              <p>
                Half-power footprint at the current pointing
                {hoverTooltip.fwhm != null ? ` - ${hoverTooltip.fwhm.toFixed(2)} deg full width` : ''}.
                Sources inside this ring contribute most of the received power.
              </p>
            </>
          )}
          {hoverTooltip.kind === 'pending' && (
            <>
              <strong>Target Beam (FWHM)</strong>
              <p>
                Projected half-power footprint at the selected target
                {hoverTooltip.fwhm != null ? ` - ${hoverTooltip.fwhm.toFixed(2)} deg full width` : ''}.
              </p>
            </>
          )}
        </div>
      )}

      <CameraPip swapped={cameraSwapped} onToggleSwap={() => setCameraSwapped((v) => !v)} />
    </div>
  );
}

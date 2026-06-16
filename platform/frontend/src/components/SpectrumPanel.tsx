// Tree-shakable echarts import. Pulling from `echarts/core` plus only the
// pieces we actually use keeps the bundle small enough that Rollup doesn't
// OOM when building on the Raspberry Pi. Adding any new feature (e.g. a
// scatter overlay, a legend, dataZoom) requires registering the matching
// component here.
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  MarkAreaComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

import { RefreshCw, Sliders, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  DEFAULT_Y_RANGE,
  H1_REST_MHZ,
  TRACE_BOXCAR_BINS,
  bottomHalfYRange,
  boxcarSmooth,
  displayWindow,
  robustYRange,
  zeroBaselineSpectrum,
  zeroBaselineYRange,
} from '../lib/spectrum';
import { useJsonSocket } from '../lib/useJsonSocket';
import { startSpectrumTour } from '../tour';
import { BaselineWizard } from './BaselineWizard';

echarts.use([
  LineChart,
  GridComponent,
  MarkAreaComponent,
  TooltipComponent,
  CanvasRenderer,
]);

// Plot-area insets for the spectrum line chart. The waterfall canvas uses the
// same values so its frequency axis lines up perfectly with the trace above.
const PLOT_LEFT_PX = 52;
const PLOT_RIGHT_PX = 18;

// How tall each new waterfall row is, in CSS pixels. The render multiplies
// this by devicePixelRatio. 1 CSS px at 10 Hz would creep at 10 px/sec — too
// slow for the eye to feel "live". 3 CSS px gives ~30 px/sec, filling a
// 250 px canvas in about eight seconds, which feels responsive without
// turning the trace into a smeared blur.
const WATERFALL_ROW_PX = 3;

// Inferno-style colormap stops. Low power fades to deep purple-black so the
// panel background reads as "no signal"; high power blooms through magenta/
// orange into a hot yellow-white that pops against the dark UI. Pre-expanded
// to a 256-entry LUT below for one-lookup-per-pixel rendering.
const WATERFALL_STOPS: Array<[number, number, number]> = [
  [0x04, 0x02, 0x0a],
  [0x1b, 0x0b, 0x3b],
  [0x42, 0x0a, 0x68],
  [0x6a, 0x17, 0x6e],
  [0x93, 0x26, 0x67],
  [0xbc, 0x37, 0x54],
  [0xdd, 0x51, 0x3a],
  [0xf3, 0x77, 0x1a],
  [0xfb, 0xa4, 0x0a],
  [0xfc, 0xff, 0xa4],
];

const WATERFALL_LUT: Uint8ClampedArray = buildColormapLUT(WATERFALL_STOPS, 256);

function buildColormapLUT(
  stops: Array<[number, number, number]>,
  size: number,
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 4);
  const segments = stops.length - 1;
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    const f = t * segments;
    const a = Math.min(segments, Math.floor(f));
    const b = Math.min(segments, a + 1);
    const local = f - a;
    const s0 = stops[a];
    const s1 = stops[b];
    lut[i * 4]     = s0[0] + (s1[0] - s0[0]) * local;
    lut[i * 4 + 1] = s0[1] + (s1[1] - s0[1]) * local;
    lut[i * 4 + 2] = s0[2] + (s1[2] - s0[2]) * local;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

// ±0.5 MHz around the rest line corresponds to ≈ ±105 km/s of Doppler shift,
// which covers the bulk of Galactic neutral-hydrogen velocities visible from
// the northern hemisphere. Wider than this and the marker band stops being
// useful as a "look here" hint.
const H1_SEARCH_HALF_WIDTH_MHZ = 0.5;

// Trace colours. Amber is the normal, baseline-corrected look; red signals
// that no baseline has been captured yet, so the trace is just the raw
// receiver bandpass and shouldn't be read as real signal.
const NORMAL_TRACE_COLOR = '#ffbc42';
const ALERT_TRACE_COLOR = '#ff5a5f';
const TRACE_RGB: Record<string, string> = {
  [NORMAL_TRACE_COLOR]: '255, 188, 66',
  [ALERT_TRACE_COLOR]: '255, 90, 95',
};

// Shading for flagged narrowband RFI bands. A translucent slate-red wash that
// reads as "ignore this stretch" without obscuring the trace running through it.
const RFI_BAND_COLOR = 'rgba(255, 90, 95, 0.14)';
const RFI_LABEL_MIN_GAP_PCT = 4;
const RFI_LABEL_MAX_COUNT = 8;

const SPEED_OF_LIGHT_KMS = 299792.458;

// Minimum prominence (dB above the spectrum median) before we report a peak
// as a hydrogen detection. Below this the "peak" is just the tallest noise
// bin, and quoting a velocity for it would be misleading.
const DETECTION_MIN_DB = 1.5;

interface SpectrumFrame {
  timestamp: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  frames_seen: number;
  frame_duration_s: number;
  integration_seconds: number;
  mode: string;
  freqs_mhz: number[];
  power_db: number[];
  // [lo_mhz, hi_mhz] frequency bands flagged as narrowband RFI by the hardware.
  // The trace is left intact; the frontend shades these so viewers can discount
  // them by eye rather than having them silently scrubbed.
  rfi_bands?: number[][];
  baseline_corrected?: boolean;
}

interface SpectrumStatus {
  enabled: boolean;
  mode: string;
  center_freq_mhz?: number;
  sample_rate_mhz?: number;
  fft_size?: number;
  integration_frames?: number;
  publish_rate_hz?: number;
  latest_timestamp?: number | null;
  latest_frame_age_s?: number | null;
  latest_frames_seen?: number;
  subscriber_count?: number;
}

interface SpectrumPanelProps {
  enabled?: boolean;
  onStartGuided?: () => void;
}

type InlineInfoPopoverProps = {
  label: ReactNode;
  ariaLabel: string;
  children: ReactNode;
};

function InlineInfoPopover({ label, ariaLabel, children }: InlineInfoPopoverProps) {
  const [open, setOpen] = useState(false);

  return (
    <span
      className={`spectrum-inline-popover${open ? ' is-open' : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="spectrum-doppler-term"
        aria-label={ariaLabel}
        aria-expanded={open ? 'true' : 'false'}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      <span className="spectrum-inline-popover-panel" role="tooltip">
        {children}
      </span>
    </span>
  );
}

export function SpectrumPanel({ enabled = true, onStartGuided }: SpectrumPanelProps = {}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  // The waterfall is rendered straight to a 2D canvas: each tick we scroll the
  // existing pixels down one row with drawImage(self) and paint the newest
  // spectrum across the top row. That's far cheaper than rebuilding a heatmap
  // dataset of tens of thousands of cells per frame.
  const waterfallCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Signature of the current FFT layout. When the centre/sample-rate/bin count
  // or baseline correction toggles, the dB scale shifts wholesale, so we wipe
  // the canvas rather than render a mismatched colour-coded seam.
  const waterfallSigRef = useRef<string>('');
  // The last frame we actually painted. The draw effect also re-fires when
  // display scale changes; those must not duplicate
  // a row — it just relabels the colours we already drew (lossy, but cheap).
  const lastWaterfallFrameRef = useRef<SpectrumFrame | null>(null);
  const waterfallRowRef = useRef<ImageData | null>(null);
  const [status, setStatus] = useState<SpectrumStatus | null>(null);
  const [frame, setFrame] = useState<SpectrumFrame | null>(null);
  // Chart-axis y-range: parks the trace in the bottom half of the plot, leaving
  // the upper half clear for annotations. EMA-smoothed toward the target each
  // frame so it tracks the noise floor continuously without jitter or jumps.
  // Held in a ref (not state) so per-frame updates don't trigger React
  // re-renders.
  const yRangeRef = useRef<[number, number]>(DEFAULT_Y_RANGE);
  const yRangeInitRef = useRef(false);
  // Signature of the FFT layout + baseline state the range is tracking. When it
  // changes the dB scale shifts wholesale, so we snap rather than slide across.
  const yRangeSigRef = useRef<string>('');
  // Tight y-range used only for the waterfall colour mapping, so the inferno
  // palette spans the full trace rather than just the bottom third of the axis.
  const waterfallRangeRef = useRef<[number, number]>(DEFAULT_Y_RANGE);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [waterfallOpen, setWaterfallOpen] = useState(false);
  const [integrationRestarting, setIntegrationRestarting] = useState(false);
  const [integrationRestartError, setIntegrationRestartError] = useState<string | null>(null);

  // The hardware tells us, per frame, whether the live stream is baseline-
  // corrected (`baseline_corrected`). That flag is the single source of truth:
  // it stays correct across page refreshes and for viewers who didn't capture
  // the baseline themselves, neither of which any local UI state can track.
  const baselineApplies = frame?.baseline_corrected === true;

  const restartIntegration = async () => {
    if (integrationRestarting) return;
    setIntegrationRestarting(true);
    setIntegrationRestartError(null);
    try {
      const r = await fetch('/api/spectrum/reset', { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    } catch {
      setIntegrationRestartError('Integration restart failed. Try again in a moment.');
    } finally {
      setIntegrationRestarting(false);
    }
  };

  const displayed = useMemo(() => {
    if (!frame) return null;
    const values = frame.baseline_corrected === true
      ? zeroBaselineSpectrum(frame.power_db)
      : frame.power_db;
    return boxcarSmooth(values, TRACE_BOXCAR_BINS);
  }, [frame]);

  const waterfallDisplayed = useMemo(() => {
    if (!frame) return null;
    if (frame.baseline_corrected === true) {
      return zeroBaselineSpectrum(frame.power_db);
    }
    return frame.power_db;
  }, [frame]);

  // Initialise the ECharts instance once. ResizeObserver keeps it sized
  // against the panel even as the dashboard grid reflows.
  useEffect(() => {
    if (!chartRef.current) return;
    const chart = echarts.init(chartRef.current, undefined, { renderer: 'canvas' });
    chartInstance.current = chart;
    chart.setOption(baseOption(DEFAULT_Y_RANGE));

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(chartRef.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartInstance.current = null;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await fetch('/api/spectrum/status');
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        const s = await r.json() as SpectrumStatus;
        if (cancelled) return;
        setStatus(s);
      } catch {
        if (cancelled) return;
        setStatus({ enabled: false, mode: 'unavailable' });
      }
    };
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [enabled]);

  // Auto-recover the SDR when frames stop flowing. We avoid hammering the
  // reconnect endpoint unconditionally — tearing down and re-opening the
  // dongle while it's healthy would actually *interrupt* the stream. Only
  // fire when the receiver is in a non-streaming state or no frame has
  // arrived in the last ~6 s, and throttle to one attempt every 5 s.
  // The endpoint requires control; for spectators the 403 is harmless.
  useEffect(() => {
    if (!status || !status.enabled) return;
    const SDR_HEALTHY_MODES = new Set(['airspy', 'remote']);
    const ageStale = status.latest_frame_age_s != null && status.latest_frame_age_s > 6;
    const modeStale = !SDR_HEALTHY_MODES.has(status.mode);
    if (!ageStale && !modeStale) return;

    let cancelled = false;
    let inFlight = false;
    const attempt = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await fetch('/api/spectrum/reconnect', { method: 'POST' });
      } catch { /* network blip — next tick retries */ }
      finally { inFlight = false; }
    };
    void attempt();
    const id = window.setInterval(attempt, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [status?.enabled, status?.mode, (status?.latest_frame_age_s ?? 0) > 6]);

  // WebSocket subscription. Each frame is a fully-integrated spectrum from
  // the backend — we swap the series wholesale rather than appending.
  const { connected } = useJsonSocket<SpectrumFrame>('/ws/spectrum', {
    enabled: enabled && (status == null || status.enabled !== false),
    onMessage: setFrame,
  });

  useEffect(() => {
    if (connected && status?.latest_frame_age_s !== null) return;
    setFrame(null);
    lastWaterfallFrameRef.current = null;
    waterfallSigRef.current = '';
    yRangeInitRef.current = false;
    chartInstance.current?.setOption({
      series: [{ data: [], markArea: rfiMarkArea([]) }],
    });
  }, [connected, status?.latest_frame_age_s]);

  // Update the spectrum line chart on each new frame / range change.
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || !frame || !displayed) return;
    const data = frame.freqs_mhz.map((f, i) => [f, displayed[i]] as [number, number]);
    // Raw spectra still use the dynamic lower-half fit so receiver bandpass
    // shape remains legible. Baseline-corrected frames are rendered relative
    // to their own robust median (see zeroBaselineSpectrum), so the trace
    // baseline remains visually pinned at 0 dB even if receiver gain or
    // temperature drifts.
    // Both targets are robust percentile fits (spurs/dead bins can't blow them
    // open) that we EMA-smooth toward each frame, so the axis tracks without
    // jitter or jumps. We snap (skip the EMA) only when the FFT layout /
    // baseline state changes, since the dB scale shifts wholesale there and
    // sliding across it would look wrong. The waterfall keeps its own tight
    // colour range so its inferno palette still spans the full trace.
    const axisTarget = frame.baseline_corrected === true ? zeroBaselineYRange(displayed) : bottomHalfYRange(displayed);
    const wfTarget = robustYRange(displayed);
    const sig = `${frame.center_freq_mhz.toFixed(6)}|${frame.sample_rate_mhz.toFixed(6)}|${frame.freqs_mhz.length}|${baselineApplies ? 'baseline' : 'raw'}`;
    const fresh = !yRangeInitRef.current || sig !== yRangeSigRef.current;
    const k = 0.15;
    const ema = (cur: [number, number], target: [number, number]): [number, number] =>
      fresh ? target : [cur[0] + (target[0] - cur[0]) * k, cur[1] + (target[1] - cur[1]) * k];
    yRangeRef.current = ema(yRangeRef.current, axisTarget);
    waterfallRangeRef.current = ema(waterfallRangeRef.current, wfTarget);
    yRangeSigRef.current = sig;
    yRangeInitRef.current = true;
    const [yMin, yMax] = yRangeRef.current;
    const win = displayWindow(frame);
    const traceColor = baselineApplies ? NORMAL_TRACE_COLOR : ALERT_TRACE_COLOR;
    chart.setOption({
      xAxis: win ? { min: win.xMin, max: win.xMax } : {},
      yAxis: { min: round2(yMin), max: round2(yMax) },
      series: [{ data, ...traceStyle(traceColor), markArea: rfiMarkArea(frame.rfi_bands) }],
    });
  }, [frame, displayed, baselineApplies]);

  // Keep the waterfall canvas pixel-buffer in lockstep with its CSS box,
  // scaled for devicePixelRatio so the inferno colours stay crisp on HiDPI.
  // Resizes clear the buffer — there's no clean way to rescale a waterfall
  // and pretending we can would just produce a smeared frame.
  useEffect(() => {
    const canvas = waterfallCanvasRef.current;
    if (!canvas) return;
    const sync = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        waterfallSigRef.current = ''; // force a clear+redraw on next frame
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Paint one new row at the top of the waterfall per incoming frame.
  useEffect(() => {
    const canvas = waterfallCanvasRef.current;
    if (!canvas || !frame || !waterfallDisplayed) return;

    // Only paint genuine new frames. yRange changes re-fire this effect but
    // shouldn't shove a duplicate row into the rolling history.
    if (lastWaterfallFrameRef.current === frame) return;
    lastWaterfallFrameRef.current = frame;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    const plotLeft = Math.round(PLOT_LEFT_PX * dpr);
    const plotRight = Math.round(PLOT_RIGHT_PX * dpr);
    const plotW = Math.max(1, w - plotLeft - plotRight);
    // Each frame moves the data down by rowH device pixels. The minimum of 1
    // keeps very small canvases from stalling out at 0 px/frame.
    const rowH = Math.max(1, Math.round(WATERFALL_ROW_PX * dpr));

    // Reset the canvas when the FFT layout or baseline state changes — the
    // colour scale jumps and stitching old rows onto new ones would lie
    // about what the receiver was seeing.
    const sig = [
      w, h,
      frame.freqs_mhz.length,
      frame.center_freq_mhz.toFixed(6),
      frame.sample_rate_mhz.toFixed(6),
      baselineApplies ? 'baseline' : 'raw',
    ].join('|');
    if (sig !== waterfallSigRef.current) {
      ctx.clearRect(0, 0, w, h);
      waterfallSigRef.current = sig;
    }

    // Scroll the existing pixels down by rowH device-pixel rows. Drawing the
    // canvas onto itself with a y-offset is the fastest way to do this — no
    // ImageData round-trip, GPU-friendly under accelerated 2D contexts.
    ctx.imageSmoothingEnabled = false;
    if (h > rowH) {
      ctx.drawImage(canvas, 0, 0, w, h - rowH, 0, rowH, w, h - rowH);
    }

    // Build the new top row directly in an ImageData buffer. Compute each
    // column's colour once and replicate it down rowH rows so the new band
    // is a solid stripe of constant colour per frequency.
    const [yMin, yMax] = waterfallRangeRef.current;
    const yScale = yMax > yMin ? 1 / (yMax - yMin) : 1;
    const bins = waterfallDisplayed.length;
    const binsMaxIdx = bins - 1;

    if (!waterfallRowRef.current ||
        waterfallRowRef.current.width !== plotW ||
        waterfallRowRef.current.height !== rowH) {
      waterfallRowRef.current = ctx.createImageData(plotW, rowH);
    }
    const row = waterfallRowRef.current;
    const rowData = row.data;
    const lut = WATERFALL_LUT;
    const lutMaxIdx = (lut.length / 4) - 1;
    const stride = plotW * 4;

    // Map each pixel column through the same x-axis window the line chart uses
    // so the waterfall stays frequency-aligned with the trace above it. Bins
    // are evenly spaced across [dataMin, dataMax]; a pixel's frequency is a
    // linear interpolation over the visible window, then back to a bin index.
    const win = displayWindow(frame);
    const xMin = win ? win.xMin : frame.freqs_mhz[0];
    const xMax = win ? win.xMax : frame.freqs_mhz[binsMaxIdx];
    const dataMin = win ? win.dataMin : frame.freqs_mhz[0];
    const dataMax = win ? win.dataMax : frame.freqs_mhz[binsMaxIdx];
    const freqSpan = dataMax - dataMin;

    for (let px = 0; px < plotW; px++) {
      const ratio = plotW === 1 ? 0 : px / (plotW - 1);
      const freq = xMin + ratio * (xMax - xMin);
      const binF = freqSpan > 0
        ? ((freq - dataMin) / freqSpan) * binsMaxIdx
        : ratio * binsMaxIdx;
      const i = Math.min(binsMaxIdx, Math.max(0, Math.floor(binF)));
      const t = binF - i;
      const a = waterfallDisplayed[i];
      const b = waterfallDisplayed[Math.min(binsMaxIdx, i + 1)];
      const v = a + (b - a) * t;
      let norm = (v - yMin) * yScale;
      if (norm < 0) norm = 0; else if (norm > 1) norm = 1;
      const li = (norm * lutMaxIdx) | 0;
      const off = li * 4;
      const r = lut[off];
      const g = lut[off + 1];
      const bl = lut[off + 2];
      // First row
      const base = px * 4;
      rowData[base]     = r;
      rowData[base + 1] = g;
      rowData[base + 2] = bl;
      rowData[base + 3] = 255;
      // Replicate down rowH-1 more rows for the same column
      for (let yy = 1; yy < rowH; yy++) {
        const off2 = base + yy * stride;
        rowData[off2]     = r;
        rowData[off2 + 1] = g;
        rowData[off2 + 2] = bl;
        rowData[off2 + 3] = 255;
      }
    }
    ctx.putImageData(row, plotLeft, 0);
  }, [frame, waterfallDisplayed, baselineApplies]);

  const chartEmptyMessage = !connected || !frame
    ? 'Waiting for spectrum stream to start'
    : null;
  const integrationStats = useMemo(() => {
    if (!frame) return null;
    const bins = frame.freqs_mhz.length;
    // Bin spacing from the axis itself, not sample_rate / bins — the backend
    // crops each frame to the displayed H I window, so the array no longer
    // spans the full sample rate.
    const binHz = bins > 1 ? (frame.freqs_mhz[1] - frame.freqs_mhz[0]) * 1e6 : 0;
    const frameHz = frame.frame_duration_s > 0 ? 1 / frame.frame_duration_s : 0;
    const effectiveFrames = Math.min(frame.frames_seen, frame.integration_frames);
    return {
      windowSeconds: frame.integration_seconds,
      effectiveFrames,
      targetFrames: frame.integration_frames,
      binHz,
      frameHz,
    };
  }, [frame]);
  const hydrogenGuide = useMemo(() => {
    if (!frame) return null;
    const win = displayWindow(frame);
    if (!win) return null;
    const { xMin, xMax } = win;
    const span = xMax - xMin;
    if (span <= 0 || H1_REST_MHZ < xMin || H1_REST_MHZ > xMax) return null;
    const toPct = (mhz: number) => `${Math.max(0, Math.min(100, ((mhz - xMin) / span) * 100))}%`;
    return {
      lineLeft: toPct(H1_REST_MHZ),
    };
  }, [frame]);
  const rfiGuide = useMemo(() => {
    if (!frame?.rfi_bands?.length || !displayed?.length) return [];
    const win = displayWindow(frame);
    if (!win) return [];
    const { xMin, xMax } = win;
    const span = xMax - xMin;
    if (span <= 0) return [];
    const [yMin, yMax] = yRangeRef.current;
    if (yMax <= yMin) return [];
    const clamp = (v: number) => Math.max(0, Math.min(100, v));
    const markers = frame.rfi_bands
      .map(([lo, hi]) => {
        const visibleLo = Math.max(lo, xMin);
        const visibleHi = Math.min(hi, xMax);
        if (visibleHi < visibleLo) return null;
        const center = (visibleLo + visibleHi) / 2;
        let closestIdx = 0;
        let closestDistance = Infinity;
        for (let i = 0; i < frame.freqs_mhz.length; i++) {
          const distance = Math.abs(frame.freqs_mhz[i] - center);
          if (distance < closestDistance) {
            closestDistance = distance;
            closestIdx = i;
          }
        }
        const traceTop = clamp(((yMax - displayed[closestIdx]) / (yMax - yMin)) * 100);
        const leftPct = clamp(((center - xMin) / span) * 100);
        return {
          key: `${lo.toFixed(6)}-${hi.toFixed(6)}`,
          leftPct,
          left: `${leftPct}%`,
          bottom: `${clamp(100 - traceTop)}%`,
        };
      })
      .filter((marker): marker is { key: string; leftPct: number; left: string; bottom: string } => marker !== null)
      .sort((a, b) => a.leftPct - b.leftPct);

    let lastLabelPct = -Infinity;
    let labelCount = 0;
    return markers.map((marker) => {
      const showLabel =
        labelCount < RFI_LABEL_MAX_COUNT &&
        marker.leftPct - lastLabelPct >= RFI_LABEL_MIN_GAP_PCT;
      if (showLabel) {
        lastLabelPct = marker.leftPct;
        labelCount += 1;
      }
      return { ...marker, showLabel };
    });
  }, [frame, displayed]);

  // Live interpretation of the spectrum: the strongest bin inside the H I
  // search band, its height above the spectrum median, and the Doppler
  // velocity that frequency offset corresponds to. This is the readout that
  // turns "a bump on a chart" into "gas receding at 40 km/s".
  const detection = useMemo(() => {
    if (!frame || !displayed || frame.freqs_mhz.length < 16) return null;
    const freqs = frame.freqs_mhz;
    let peakIdx = -1;
    let peakDb = -Infinity;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i];
      if (f < H1_REST_MHZ - H1_SEARCH_HALF_WIDTH_MHZ || f > H1_REST_MHZ + H1_SEARCH_HALF_WIDTH_MHZ) continue;
      if (displayed[i] > peakDb) {
        peakDb = displayed[i];
        peakIdx = i;
      }
    }
    if (peakIdx < 0) return null;
    const sorted = Float64Array.from(displayed).sort();
    const medianDb = sorted[sorted.length >> 1];
    const prominenceDb = peakDb - medianDb;
    const freqMhz = freqs[peakIdx];
    // Positive radial velocity = receding (peak redshifted below rest).
    const velocityKms = SPEED_OF_LIGHT_KMS * (H1_REST_MHZ - freqMhz) / H1_REST_MHZ;
    return { freqMhz, peakDb, prominenceDb, velocityKms, detected: prominenceDb >= DETECTION_MIN_DB };
  }, [frame, displayed]);
  if (status && !status.enabled) {
    return (
      <section className="spectrum-section">
        <h2 className="panel-header head-amber">
          Hydrogen Observation
        </h2>
        <div className="spectrum-empty">SDR disabled in config.toml.</div>
      </section>
    );
  }

  const velocity = detection?.detected ? detection.velocityKms : null;

  // Pin a small marker on the trace at the detected peak. Positions are
  // percentages within the plot inset box (the same box the hydrogen guide
  // occupies), so the marker tracks the peak as the axis refits.
  let peakMarker: { left: string; top: string } | null = null;
  const peakWindow = frame ? displayWindow(frame) : null;
  if (frame && detection?.detected && hydrogenGuide && peakWindow) {
    const { xMin, xMax } = peakWindow;
    const span = xMax - xMin;
    const [yMin, yMax] = yRangeRef.current;
    if (span > 0 && yMax > yMin) {
      const clamp = (v: number) => Math.max(0, Math.min(100, v));
      peakMarker = {
        left: `${clamp(((detection.freqMhz - xMin) / span) * 100)}%`,
        top: `${clamp(((yMax - detection.peakDb) / (yMax - yMin)) * 100)}%`,
      };
    }
  }

  return (
    <section className="spectrum-section">
      <header className="spectrum-head">
        <div className="spectrum-head-titles">
          <div className="spectrum-head-row">
            <h2 className="panel-header head-amber spectrum-title-lg">
              Hydrogen Observation
            </h2>
            {onStartGuided && (
              <button
                type="button"
                className="spectrum-guided-cta"
                onClick={onStartGuided}
                disabled={!connected || !frame}
                title={!connected || !frame ? 'Waiting for SDR…' : 'Walk through a hydrogen-line observation step by step'}
              >
                <Sparkles size={14} /> Guided observation
              </button>
            )}
          </div>
          <p className="spectrum-subtitle">
            Neutral hydrogen in the Milky Way emits radio waves with a frequency of <strong>1420.4 MHz</strong>. This panel shows a live spectrum from the SDR, with a vertical marker at that reference frequency. Gas moving toward or away from the telescope shifts the signal slightly by the{' '}
            <InlineInfoPopover
              label="Doppler effect"
              ariaLabel="Show what the Doppler effect means"
            >
              <strong>Motion shifts the observed frequency.</strong>
              <span>
                Gas clouds moving toward us are blueshifted slightly higher in frequency, while gas clouds moving away are redshifted slightly lower.
              </span>
            </InlineInfoPopover>. By observing several points along the galactic plane, you can see the motion and distribution of the hydrogen gas in our own Milky Way galaxy.
          </p>
        </div>
        <div className="spectrum-status">
          {!connected && <span className="spectrum-disconnected">offline</span>}
        </div>
      </header>

      {!baselineApplies ? (
        <div className="baseline-prompt" role="status" aria-label="Baseline not captured">
          <p className="baseline-prompt-text">
            Without a cold-sky baseline, the spectrum is dominated by the receiver's bandpass shape and local radio frequency interference (RFI).
          </p>
          <button
            type="button"
            className="baseline-prompt-go"
            onClick={() => setWizardOpen(true)}
            title="Open the guided flow to point at empty sky and capture a baseline"
          >
            Capture baseline →
          </button>
        </div>
      ) : frame ? (
        <div className="spectrum-readouts" aria-label="Hydrogen line measurements">
          <div className="spectrum-readout">
            <span className="spectrum-readout-label">Peak</span>
            <span className="spectrum-readout-value">
              {detection?.detected ? `${detection.freqMhz.toFixed(3)} MHz` : '—'}
            </span>
          </div>
          <div className="spectrum-readout">
            <span className="spectrum-readout-label">Strength</span>
            <span className="spectrum-readout-value">
              {detection?.detected ? `+${detection.prominenceDb.toFixed(1)} dB` : '—'}
            </span>
          </div>
          <div className="spectrum-readout">
            <span className="spectrum-readout-label">Doppler velocity</span>
            <span className="spectrum-readout-value">
              {velocity == null ? '—' : `${velocity >= 0 ? '+' : '−'}${Math.abs(velocity).toFixed(0)} km/s`}
            </span>
            {velocity != null && Math.abs(velocity) >= 3 && (
              <span className="spectrum-readout-sub">
                {velocity >= 0 ? 'gas receding' : 'gas approaching'}
              </span>
            )}
          </div>
          {detection && !detection.detected && (
            <div className="spectrum-readout spectrum-readout-wide">
              <span className="spectrum-readout-hint">
                No clear hydrogen peak yet — the signal is strongest along the galactic plane
                (galactic latitude near 0°).
              </span>
            </div>
          )}
          <button
            type="button"
            className="ghost-btn spectrum-recapture-btn"
            onClick={() => setWizardOpen(true)}
            title="Capture a fresh baseline"
          >
            <Sliders size={12} /> Recapture
          </button>
        </div>
      ) : null}

      <div className="spectrum-chart-wrap">
        <div className="spectrum-chart-head">
          {baselineApplies && (
            <button
              type="button"
              className="spectrum-learn-link"
              onClick={() => startSpectrumTour()}
            >
              How to read this chart
            </button>
          )}
          {integrationRestartError && (
            <p className="spectrum-notice" role="status">
              {integrationRestartError}
            </p>
          )}
          <div className="spectrum-chart-caption">
            <span className="spectrum-chart-title">Power vs. frequency</span>
            {integrationStats && (
              <p className="spectrum-stats" aria-label="Integration statistics">
                Integrating <strong>{integrationStats.windowSeconds.toFixed(1)} s</strong>
                {' '}({integrationStats.effectiveFrames}/{integrationStats.targetFrames} frames)
                {' · '}
                <strong>{integrationStats.binHz.toFixed(0)} Hz</strong> bins
                {' · '}
                {integrationStats.frameHz.toFixed(1)} Hz FFT
              </p>
            )}
          </div>
          <button
            type="button"
            className="spectrum-restart-integration"
            onClick={restartIntegration}
            disabled={!connected || integrationRestarting}
            title={!connected ? 'Waiting for SDR stream' : 'Restart integration without clearing the baseline'}
            aria-label={integrationRestarting ? 'Restarting integration' : 'Restart integration'}
          >
            <RefreshCw
              size={14}
              className={integrationRestarting ? 'is-spinning' : undefined}
            />
          </button>
        </div>

        <div className="spectrum-chart-box">
          {baselineApplies && (
            <div className="spectrum-chart-note">Baseline corrected</div>
          )}
          {baselineApplies && hydrogenGuide && (
            <div
              className="spectrum-hydrogen-guide"
              style={{
                '--h1-line-left': hydrogenGuide.lineLeft,
              } as React.CSSProperties}
              aria-hidden
            >
              <span className="spectrum-hydrogen-line" />
              {peakMarker && (
                <span className="spectrum-peak-marker" style={{ left: peakMarker.left, top: peakMarker.top }} />
              )}
            </div>
          )}
          {rfiGuide.length > 0 && (
            <div className="spectrum-rfi-guide" aria-hidden>
              {rfiGuide.map((marker) => (
                <span className="spectrum-rfi-marker" style={{ left: marker.left }} key={marker.key}>
                  <span className="spectrum-rfi-line" style={{ bottom: marker.bottom }} />
                  {marker.showLabel && <span className="spectrum-rfi-label">RFI</span>}
                </span>
              ))}
            </div>
          )}
          <div className="spectrum-chart" ref={chartRef} />
          {chartEmptyMessage && (
            <div className="spectrum-chart-empty">
              {chartEmptyMessage}
            </div>
          )}
          {!baselineApplies && frame && (
            <div className="spectrum-baseline-overlay" aria-hidden>
              Baseline Needed
            </div>
          )}
        </div>

        <details
          className="spectrum-waterfall-dropdown"
          open={waterfallOpen}
          onToggle={(event) => setWaterfallOpen(event.currentTarget.open)}
        >
          <summary className="spectrum-waterfall-summary">
            <span>Waterfall</span>
            <small className="spectrum-waterfall-caption">signal history over time</small>
          </summary>
          <canvas className="spectrum-waterfall" ref={waterfallCanvasRef} />
        </details>
      </div>

      <BaselineWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        frame={frame}
      />
    </section>
  );
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function baseOption(yRange: [number, number]): EChartsOption {
  // Axis ticks/labels in a muted periwinkle; gridlines a hair dimmer than the
  // panel hairline so they read as background structure, not foreground noise.
  const tickColor = '#6f719a';
  const lineColor = '#262a44';
  const gridColor = '#1c1f33';
  const traceColor = '#ffbc42';

  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: 'inherit' },
    // Insets here must match PLOT_LEFT_PX / PLOT_RIGHT_PX so the waterfall
    // canvas painted below the chart shares the same frequency-axis pixels.
    grid: { left: PLOT_LEFT_PX, right: PLOT_RIGHT_PX, top: 12, bottom: 48, containLabel: false },
    xAxis: {
      type: 'value',
      name: 'Frequency (MHz)',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: tickColor, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: tickColor,
        fontSize: 11,
        margin: 10,
        hideOverlap: true,
        formatter: (v: number) => {
          const label = v.toFixed(1);
          return label === H1_REST_MHZ.toFixed(1) ? `{h1|${label}}` : label;
        },
        rich: {
          h1: {
            color: '#b8fff2',
            fontSize: 12,
            fontWeight: 800,
            backgroundColor: 'rgba(119, 203, 185, 0.12)',
            borderColor: 'rgba(119, 203, 185, 0.34)',
            borderWidth: 1,
            borderRadius: 3,
            padding: [2, 5],
          },
        },
      },
      splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
      splitNumber: 6,
      min: 'dataMin',
      max: 'dataMax',
    },
    yAxis: {
      type: 'value',
      name: 'dB',
      nameLocation: 'middle',
      nameRotate: 90,
      nameGap: 34,
      nameTextStyle: { color: tickColor, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: tickColor, fontSize: 11, margin: 8 },
      splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
      splitNumber: 5,
      min: yRange[0],
      max: yRange[1],
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(16, 18, 30, 0.95)',
      borderColor: lineColor,
      padding: [6, 10],
      textStyle: { color: '#eaebf5', fontSize: 12 },
      axisPointer: {
        type: 'line',
        lineStyle: { color: 'rgba(255, 188, 66, 0.45)', width: 1, type: 'dashed' },
      },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p?.value) return '';
        const [f, db] = p.value as [number, number];
        return `<strong style="color:${traceColor}">${f.toFixed(4)} MHz</strong><br/>${db.toFixed(2)} dB`;
      },
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        // No spline smoothing: each point is a real FFT bin, and smoothing
        // makes the spline (and its area fill) overshoot above sharp peaks,
        // so the gradient would poke above the trace. Straight segments keep
        // the fill strictly below the line.
        smooth: false,
        ...traceStyle(traceColor),
        data: [] as [number, number][],
      },
    ],
  };
}

// Translucent shaded bands over the stretches the hardware flagged as
// narrowband RFI. Returned fresh each frame (with an empty data array when the
// spectrum is clean) so ECharts' merge clears stale bands instead of leaving
// them painted. `silent` keeps the bands from stealing the trace's tooltip.
function rfiMarkArea(bands: number[][] | undefined) {
  const data = (bands ?? []).map(([lo, hi]) => [{ name: 'RFI', xAxis: lo }, { xAxis: hi }]);
  return {
    silent: true,
    itemStyle: { color: RFI_BAND_COLOR },
    label: { show: false },
    data,
  };
}

// Line + area styling for the spectrum trace, keyed off the trace colour so the
// amber (baseline applied) and red (no baseline) looks stay in sync between the
// initial baseOption and the per-frame setOption.
function traceStyle(color: string) {
  const rgb = TRACE_RGB[color] ?? TRACE_RGB[NORMAL_TRACE_COLOR];
  return {
    // A faint outer glow lifts the trace off the dark panel without the
    // 1 px line reading as thick.
    lineStyle: {
      color,
      width: 1.4,
      shadowColor: `rgba(${rgb}, 0.55)`,
      shadowBlur: 6,
    },
    // Vertical gradient: a haze at the trace fading to nothing toward the
    // noise floor, so the filled area suggests signal energy rather than a
    // flat tint.
    areaStyle: {
      opacity: 1,
      // The spectrum is dB and usually all-negative, so the default baseline
      // (y=0) is off the top of the plot — the fill would anchor upward to
      // zero. 'start' anchors it to the axis minimum so the gradient always
      // falls below the trace.
      origin: 'start' as const,
      color: {
        type: 'linear' as const,
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: `rgba(${rgb}, 0.55)` },
          { offset: 0.5, color: `rgba(${rgb}, 0.18)` },
          { offset: 1, color: `rgba(${rgb}, 0.04)` },
        ],
      },
    },
  };
}

// Tree-shakable echarts import. Pulling from `echarts/core` plus only the
// pieces we actually use keeps the bundle small enough that Rollup doesn't
// OOM when building on the Raspberry Pi. Adding any new feature (e.g. a
// scatter overlay, a legend, dataZoom) requires registering the matching
// component here.
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';

import { Sliders, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { HYDROGEN_LINE_MHZ } from '../lib/astro';
import { useJsonSocket } from '../lib/useJsonSocket';
import { BaselineWizard } from './BaselineWizard';

echarts.use([
  LineChart,
  GridComponent,
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

// 21 cm neutral-hydrogen line — the rolling integration is centred here.
const H1_REST_MHZ = HYDROGEN_LINE_MHZ;
// ±0.5 MHz around the rest line corresponds to ≈ ±105 km/s of Doppler shift,
// which covers the bulk of Galactic neutral-hydrogen velocities visible from
// the northern hemisphere. Wider than this and the marker band stops being
// useful as a "look here" hint.
const H1_SEARCH_HALF_WIDTH_MHZ = 0.5;

// Default locked y-range, chosen so the median-subtracted trace fits a
// freshly-tuned RTL-SDR's typical noise floor without clipping.
const DEFAULT_Y_RANGE: [number, number] = [-8, 8];

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

interface Baseline {
  captured_at: number;
  center_freq_mhz: number;
  sample_rate_mhz: number;
  integration_frames: number;
  freqs_mhz: number[];
  power_db: number[];
}

interface SpectrumPanelProps {
  onStartGuided?: () => void;
}

export function SpectrumPanel({ onStartGuided }: SpectrumPanelProps = {}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);
  // The waterfall is rendered straight to a 2D canvas: each tick we scroll the
  // existing pixels down one row with drawImage(self) and paint the newest
  // spectrum across the top row. That's far cheaper than rebuilding a heatmap
  // dataset of tens of thousands of cells per frame.
  const waterfallCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Signature of the current FFT layout. When the centre/sample-rate/bin count
  // or baseline subtraction toggles, the dB scale shifts wholesale, so we wipe
  // the canvas rather than render a mismatched colour-coded seam.
  const waterfallSigRef = useRef<string>('');
  // The last frame we actually painted. The draw effect also re-fires when
  // display scale changes; those must not duplicate
  // a row — it just relabels the colours we already drew (lossy, but cheap).
  const lastWaterfallFrameRef = useRef<SpectrumFrame | null>(null);
  const waterfallRowRef = useRef<ImageData | null>(null);
  const [status, setStatus] = useState<SpectrumStatus | null>(null);
  const [frame, setFrame] = useState<SpectrumFrame | null>(null);
  const [yRange] = useState<[number, number]>(DEFAULT_Y_RANGE);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [dopplerOpen, setDopplerOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [waterfallDropdown, setWaterfallDropdown] = useState(false);
  const [waterfallOpen, setWaterfallOpen] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const sync = () => setWaterfallDropdown(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // Baseline subtraction is what makes the H I line pop above the bandpass.
  // Only apply when the cached baseline matches the current FFT layout —
  // otherwise the arrays don't align and the subtraction is nonsense.
  const baselineApplies = useMemo(() => {
    if (!baseline || !frame) return false;
    return (
      baseline.power_db.length === frame.power_db.length &&
      Math.abs(baseline.center_freq_mhz - frame.center_freq_mhz) < 1e-6 &&
      Math.abs(baseline.sample_rate_mhz - frame.sample_rate_mhz) < 1e-6
    );
  }, [baseline, frame]);

  const displayed = useMemo(() => {
    if (!frame) return null;
    if (baselineApplies && baseline) {
      return frame.power_db.map((v, i) => v - baseline.power_db[i]);
    }
    return frame.power_db;
  }, [frame, baseline, baselineApplies]);

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
  }, []);

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
    enabled: status == null || status.enabled !== false,
    onMessage: setFrame,
  });

  // Update the spectrum line chart on each new frame / range change.
  useEffect(() => {
    const chart = chartInstance.current;
    if (!chart || !frame || !displayed) return;
    const data = frame.freqs_mhz.map((f, i) => [f, displayed[i]] as [number, number]);
    chart.setOption({
      yAxis: { min: yRange[0], max: yRange[1] },
      series: [{ data }],
    });
  }, [frame, displayed, yRange]);

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
    if (!canvas || !frame || !displayed) return;

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
    const yMin = yRange[0];
    const yMax = yRange[1];
    const yScale = yMax > yMin ? 1 / (yMax - yMin) : 1;
    const bins = displayed.length;
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

    for (let px = 0; px < plotW; px++) {
      const ratio = plotW === 1 ? 0 : px / (plotW - 1);
      const binF = ratio * binsMaxIdx;
      const i = Math.min(binsMaxIdx, Math.floor(binF));
      const t = binF - i;
      const a = displayed[i];
      const b = displayed[Math.min(binsMaxIdx, i + 1)];
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
  }, [frame, displayed, yRange, baselineApplies]);

  const chartEmptyMessage = !connected
    ? 'Spectrum websocket is offline.'
    : !frame
      ? 'Waiting for first spectrum frame from SDR service.'
      : null;
  const hydrogenGuide = useMemo(() => {
    if (!frame || frame.freqs_mhz.length < 2) return null;
    const min = frame.freqs_mhz[0];
    const max = frame.freqs_mhz[frame.freqs_mhz.length - 1];
    const span = max - min;
    if (span <= 0 || H1_REST_MHZ < min || H1_REST_MHZ > max) return null;
    const toPct = (mhz: number) => `${Math.max(0, Math.min(100, ((mhz - min) / span) * 100))}%`;
    return {
      lineLeft: toPct(H1_REST_MHZ),
      bandLeft: toPct(H1_REST_MHZ - H1_SEARCH_HALF_WIDTH_MHZ),
      bandRight: toPct(H1_REST_MHZ + H1_SEARCH_HALF_WIDTH_MHZ),
    };
  }, [frame]);
  if (status && !status.enabled) {
    return (
      <section className="spectrum-section">
        <h2 className="panel-header head-amber">
          Hydrogen line observation
        </h2>
        <div className="spectrum-empty">SDR disabled in config.toml.</div>
      </section>
    );
  }

  return (
    <section className="spectrum-section">
      <header className="spectrum-head">
        <h2 className="panel-header head-amber">
          The Hydrogen Line
        </h2>
        <div className="spectrum-status">
          {baseline && !baselineApplies && <span className="spectrum-tag spectrum-tag-warn">baseline mismatched</span>}
          {!connected && <span className="spectrum-disconnected">offline</span>}
          {onStartGuided && (
            <button
              type="button"
              className="spectrum-guided-cta"
              onClick={onStartGuided}
              disabled={!connected || !frame}
              title={!connected || !frame ? 'Waiting for SDR…' : 'Walk through a hydrogen-line observation step by step'}
            >
              <Sparkles size={12} /> Guided Observation
            </button>
          )}
        </div>
      </header>

      <div className="spectrum-observation-panel" aria-label="Hydrogen line observation guide">
        <div className="spectrum-observation-primary">
          <p>
            Neutral hydrogen in the Milky Way emits radio energy at <strong>1420.4 MHz</strong>. This panel shows a live spectrum from the SDR, with a vertical
            marker at that reference frequency. Gas moving toward or away from the telescope shifts the signal slightly by the{' '}
            <span className="spectrum-doppler-wrap">
              <button
                type="button"
                className="spectrum-doppler-term"
                onClick={() => setDopplerOpen((open) => !open)}
                aria-expanded={dopplerOpen}
                aria-controls="spectrum-doppler-popup"
                aria-describedby={dopplerOpen ? undefined : 'spectrum-doppler-preview'}
              >
                Doppler effect
              </button>
              {!dopplerOpen && (
                <span className="spectrum-doppler-preview" id="spectrum-doppler-preview" role="tooltip">
                  The H I marker shows the expected rest frequency. If hydrogen gas is moving relative
                  to the telescope, the received peak shifts left or right from that marker. Click for the lesson.
                </span>
              )}
            </span>
            . By observing several points along the galactic plane, you can see the motion and distribution of the hydrogen gas in our own Milky Way galaxy. 
          </p>
          {dopplerOpen && (
            <div className="spectrum-doppler-popup" id="spectrum-doppler-popup" role="status">
              <button
                type="button"
                className="spectrum-doppler-close"
                onClick={() => setDopplerOpen(false)}
                aria-label="Close Doppler effect explainer"
              >
                ×
              </button>
              <strong>Doppler effect lesson</strong>
              <p>
                This lesson will walk through why motion changes the received hydrogen-line frequency,
                how to compare the observed peak against the H I rest marker, and how observations in
                different sky directions reveal relative motion in neutral hydrogen gas.
              </p>
              <div className="spectrum-doppler-lesson-grid">
                <span>1. Rest frequency</span>
                <span>2. Shifted signal</span>
                <span>3. Sky comparison</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="spectrum-toolbar spectrum-toolbar-above" aria-label="Spectrum processing controls">
        <div className="spectrum-control-block">
          <div className="spectrum-control-label">
            <strong>Capture baseline</strong>
            <span>
              Save the current buffer to perform baseline subtraction, helping signals stand out.
            </span>
          </div>
          <div className="spectrum-tool-group" role="group" aria-label="Baseline controls">
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setWizardOpen(true)}
              title="Open the guided flow to point at empty sky and capture a baseline (or just load a saved one)"
            >
              <Sliders size={12} /> Set up baseline
            </button>
          </div>
        </div>
      </div>

      <div className="spectrum-chart-wrap">
        {baseline && baselineApplies && (
          <div className="spectrum-chart-note">Baseline subtracted</div>
        )}
        {hydrogenGuide && (
          <div
            className="spectrum-hydrogen-guide"
            style={{
              '--h1-line-left': hydrogenGuide.lineLeft,
              '--h1-band-left': hydrogenGuide.bandLeft,
              '--h1-band-right': hydrogenGuide.bandRight,
            } as React.CSSProperties}
            aria-hidden
          >
            <span className="spectrum-hydrogen-band" />
            <span className="spectrum-hydrogen-line">
              <small>{H1_REST_MHZ.toFixed(4)} MHz</small>
            </span>
          </div>
        )}
        <div className="spectrum-chart" ref={chartRef} />
        <details
          className="spectrum-waterfall-dropdown"
          open={!waterfallDropdown || waterfallOpen}
          onToggle={(event) => {
            if (waterfallDropdown) {
              setWaterfallOpen(event.currentTarget.open);
            }
          }}
        >
          <summary className="spectrum-waterfall-summary">
            <span>Waterfall</span>
          </summary>
          <canvas className="spectrum-waterfall" ref={waterfallCanvasRef} />
        </details>
        {chartEmptyMessage && <div className="spectrum-chart-empty">{chartEmptyMessage}</div>}
      </div>

      <BaselineWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        frame={frame}
        onBaselineReady={setBaseline}
      />
    </section>
  );
}

function baseOption(yRange: [number, number]): EChartsOption {
  // Axis ticks/labels in a muted periwinkle; gridlines a hair dimmer than the
  // panel hairline so they read as background structure, not foreground noise.
  const tickColor = '#6f719a';
  const lineColor = '#262a44';
  const gridColor = '#181a2c';

  return {
    backgroundColor: 'transparent',
    animation: false,
    textStyle: { fontFamily: 'inherit' },
    // Insets here must match PLOT_LEFT_PX / PLOT_RIGHT_PX so the waterfall
    // canvas painted below the chart shares the same frequency-axis pixels.
    grid: { left: PLOT_LEFT_PX, right: PLOT_RIGHT_PX, top: 26, bottom: 30, containLabel: false },
    xAxis: {
      type: 'value',
      axisLine: { lineStyle: { color: lineColor } },
      axisTick: { show: false },
      axisLabel: {
        color: tickColor,
        fontSize: 11,
        margin: 10,
        hideOverlap: true,
        formatter: (v: number) => v.toFixed(1),
      },
      splitLine: { lineStyle: { color: gridColor } },
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
      axisLine: { lineStyle: { color: lineColor } },
      axisTick: { show: false },
      axisLabel: { color: tickColor, fontSize: 11, margin: 8 },
      splitLine: { lineStyle: { color: gridColor } },
      splitNumber: 5,
      min: yRange[0],
      max: yRange[1],
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(16, 18, 30, 0.95)',
      borderColor: lineColor,
      textStyle: { color: '#eaebf5', fontSize: 12 },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params;
        if (!p?.value) return '';
        const [f, db] = p.value as [number, number];
        return `${f.toFixed(4)} MHz<br/>${db.toFixed(2)} dB`;
      },
    },
    series: [
      {
        type: 'line',
        showSymbol: false,
        sampling: 'lttb',
        lineStyle: { color: '#ffbc42', width: 1 },
        areaStyle: { color: 'rgba(255, 188, 66, 0.08)' },
        data: [] as [number, number][],
      },
    ],
  };
}

// Pure spectrum-scaling helpers shared by the main SpectrumPanel and the
// baseline wizard's live preview, so both crop the x-axis and fit the y-axis
// identically (a divergent copy here would make the wizard preview disagree
// with the chart the user is about to affect). No React / echarts deps — just
// the dB → axis math.

import { HYDROGEN_LINE_MHZ } from './astro';

// 21 cm neutral-hydrogen line — the rolling integration is centred here.
export const H1_REST_MHZ = HYDROGEN_LINE_MHZ;

// How much spectrum we actually draw on the x-axis. The SDR captures the full
// ~2–3 MHz bandwidth, but the edges are dominated by the receiver's bandpass
// roll-off; zooming to ±0.75 MHz (≈ ±158 km/s of Doppler) fills the plot with
// the H I search band and its immediate context. Clamped to the captured band
// below so a narrow-bandwidth dongle still shows everything it has.
export const H1_DISPLAY_HALF_WIDTH_MHZ = 0.75;

// Default locked y-range, chosen so the median-subtracted trace fits a
// freshly-tuned RTL-SDR's typical noise floor without clipping.
export const DEFAULT_Y_RANGE: [number, number] = [-8, 8];

export const TRACE_BOXCAR_BINS = 5;

// Robust bulk bounds for the spectrum: the percentile band that contains the
// noise floor and hydrogen bump, with spur bins / dead bins rejected and a
// minimum span enforced so a dead-flat spectrum doesn't collapse to a sliver.
// Reject low outliers (p2), not just the single lowest bin. Since the spectrum
// is cropped to the flat H I window, the band-edge roll-off that used to
// populate the bottom of the plot is gone, so a 0.5th-percentile floor just
// tracks sparse RFI notches / the DC dip and leaves dead space below the trace.
// p2 anchors on the real noise floor and is steadier frame-to-frame. The top
// stays at p99.5 — the broad hydrogen bump is far wider than 0.5% of the bins,
// so this never clips the signal peak.
export function robustBulkBounds(values: number[]): [number, number] {
  const n = values.length;
  const sorted = Float64Array.from(values).sort();
  const at = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  let lo = at(0.02);
  let hi = at(0.995);
  const MIN_SPAN = 1.5;
  if (hi - lo < MIN_SPAN) {
    const mid = (lo + hi) / 2;
    lo = mid - MIN_SPAN / 2;
    hi = mid + MIN_SPAN / 2;
  }
  return [lo, hi];
}

// Tight y-range that fits the bulk of the data with a little padding. Used for
// the waterfall colour mapping so the inferno palette spans the full trace.
export function robustYRange(values: number[]): [number, number] {
  if (values.length === 0) return DEFAULT_Y_RANGE;
  const [lo, hi] = robustBulkBounds(values);
  const pad = 0.18 * (hi - lo);
  return [lo - pad, hi + pad];
}

// Chart-axis y-range that parks the trace in the bottom half of the plot,
// leaving the upper half clear for annotations. The bulk band [lo, hi] (plus a
// sliver of pad below) is sized to occupy the lowest ~1/2 of the axis; the rest
// is headroom above the trace.
export function bottomHalfYRange(values: number[]): [number, number] {
  if (values.length === 0) return DEFAULT_Y_RANGE;
  const [lo, hi] = robustBulkBounds(values);
  const span = hi - lo;
  const padBelow = 0.15 * span;
  const axisMin = lo - padBelow;
  const axisMax = axisMin + 2 * (span + padBelow);
  return [axisMin, axisMax];
}

export function zeroBaselineSpectrum(values: number[]): number[] {
  if (values.length === 0) return values;
  const sorted = Float64Array.from(values).sort();
  const baselineDb = sorted[sorted.length >> 1];
  return values.map(value => value - baselineDb);
}

export function boxcarSmooth(values: number[], windowBins: number): number[] {
  if (values.length < 3 || windowBins < 3) return values;
  const radius = Math.floor(windowBins / 2);
  return values.map((_, i) => {
    const start = Math.max(0, i - radius);
    const end = Math.min(values.length - 1, i + radius);
    let sum = 0;
    for (let j = start; j <= end; j++) {
      sum += values[j];
    }
    return sum / (end - start + 1);
  });
}

export function zeroBaselineYRange(values: number[]): [number, number] {
  if (values.length === 0) return DEFAULT_Y_RANGE;
  const [lo, hi] = robustBulkBounds(values);
  const extent = Math.max(1.5, Math.abs(lo), Math.abs(hi));
  return [-extent, extent];
}

// Frequency window actually drawn on the x-axis: the H I display band clamped
// to the captured bandwidth. Returns the view bounds plus the full data bounds
// so the waterfall and overlay markers can map pixels the same way the chart
// does (bins are evenly spaced across [dataMin, dataMax]).
export function displayWindow(
  frame: { freqs_mhz: number[] },
): { xMin: number; xMax: number; dataMin: number; dataMax: number } | null {
  const bins = frame.freqs_mhz.length;
  if (bins < 2) return null;
  const dataMin = frame.freqs_mhz[0];
  const dataMax = frame.freqs_mhz[bins - 1];
  let xMin = Math.max(dataMin, H1_REST_MHZ - H1_DISPLAY_HALF_WIDTH_MHZ);
  let xMax = Math.min(dataMax, H1_REST_MHZ + H1_DISPLAY_HALF_WIDTH_MHZ);
  // Rest line outside the captured band (mistuned SDR): fall back to the full
  // span rather than collapsing to an empty window.
  if (xMax <= xMin) {
    xMin = dataMin;
    xMax = dataMax;
  }
  return { xMin, xMax, dataMin, dataMax };
}

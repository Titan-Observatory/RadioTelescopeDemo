import * as echarts from 'echarts/core';
import type { EChartsOption } from 'echarts';

import {
  HYDROGEN_LOG_FREQ,
  LOG_MAX_FREQ,
  LOG_MIN_FREQ,
  SPECTRUM_POINTS,
  type SurveyId,
  VISIBLE_HIGH_LOG_FREQ,
  VISIBLE_LOW_LOG_FREQ,
  logFreqToRatio,
  surveyDefinition,
  surveyLogFreq,
  surveySpectrumColor,
} from './surveys';


function formatAxisNumber(value: number, digits = 3): string {
  const rounded = Number(value.toPrecision(digits));
  return rounded.toLocaleString('en-US', {
    maximumFractionDigits: Math.max(0, digits - Math.floor(Math.log10(Math.abs(rounded || 1))) - 1),
  });
}


export function freqLabelFromLog(value: number): string {
  const mhz = 10 ** value;
  if (mhz >= 1_000_000_000) return `${formatAxisNumber(mhz / 1_000_000_000)} PHz`;
  if (mhz >= 1_000_000) return `${formatAxisNumber(mhz / 1_000_000)} THz`;
  if (mhz >= 1_000) return `${formatAxisNumber(mhz / 1_000)} GHz`;
  return `${formatAxisNumber(mhz)} MHz`;
}


export function wavelengthLabelFromLog(value: number): string {
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


export function buildSpectrumOption(
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

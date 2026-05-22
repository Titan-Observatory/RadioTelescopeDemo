import { LineChart } from 'echarts/charts';
import { GridComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef, useState } from 'react';

import { buildSpectrumOption } from './chartOption';
import {
  HYDROGEN_LOG_FREQ,
  LOG_MAX_FREQ,
  LOG_MIN_FREQ,
  SURVEYS,
  type SurveyId,
  logFreqToRatio,
  nearestSurveyForLogFreq,
  surveyDefinition,
  surveyLogFreq,
  surveyToneClass,
} from './surveys';

echarts.use([LineChart, GridComponent, CanvasRenderer]);


export function LightSpectrumSurveySelector({
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

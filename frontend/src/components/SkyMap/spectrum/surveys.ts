import { HYDROGEN_LINE_MHZ } from '../../../lib/astro';


export const SURVEYS = [
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


export type SurveyId = (typeof SURVEYS)[number]['id'];

export const HYDROGEN_SURVEY_ID: SurveyId = 'CDS/P/HI4PI/NHI';

export const SPECTRUM_POINTS = 320;
export const MIN_FREQ_MHZ = 50;
export const MAX_FREQ_MHZ = 3_000_000_000;
export const VISIBLE_LOW_MHZ = 400_000_000;
export const VISIBLE_HIGH_MHZ = 790_000_000;
export const LOG_MIN_FREQ = Math.log10(MIN_FREQ_MHZ);
export const LOG_MAX_FREQ = Math.log10(MAX_FREQ_MHZ);
export const HYDROGEN_LOG_FREQ = Math.log10(HYDROGEN_LINE_MHZ);
export const VISIBLE_LOW_LOG_FREQ = Math.log10(VISIBLE_LOW_MHZ);
export const VISIBLE_HIGH_LOG_FREQ = Math.log10(VISIBLE_HIGH_MHZ);


export function logFreqToRatio(logFreq: number): number {
  return (logFreq - LOG_MIN_FREQ) / (LOG_MAX_FREQ - LOG_MIN_FREQ);
}


export function surveyDefinition(surveyId: SurveyId): (typeof SURVEYS)[number] {
  return SURVEYS.find((survey) => survey.id === surveyId) ?? SURVEYS[0];
}


export function surveyLogFreq(survey: (typeof SURVEYS)[number]): number {
  return Math.log10(survey.spectrumMhz);
}


export function surveyToneClass(survey: (typeof SURVEYS)[number]): string {
  if (survey.id === HYDROGEN_SURVEY_ID) return ' hydrogen';
  if (survey.spectrumMhz >= VISIBLE_LOW_MHZ) return ' optical';
  if (survey.spectrumMhz <= 500) return ' radio';
  return '';
}


export function surveySpectrumColor(survey: (typeof SURVEYS)[number]): string {
  if (survey.spectrumMhz <= 500) return 'rgba(255, 188, 66, 0.96)';
  if (survey.spectrumMhz < 2_000_000) return 'rgba(104, 158, 255, 0.96)';
  if (survey.spectrumMhz < 400_000_000) return 'rgba(220, 114, 255, 0.96)';
  if (survey.spectrumMhz <= VISIBLE_HIGH_MHZ) return 'rgba(255, 113, 82, 0.98)';
  return 'rgba(184, 91, 255, 0.92)';
}


export function nearestSurveyForLogFreq(logFreq: number): SurveyId {
  return SURVEYS.reduce((nearest, survey) => {
    const nearestDistance = Math.abs(logFreq - surveyLogFreq(nearest));
    const surveyDistance = Math.abs(logFreq - surveyLogFreq(survey));
    return surveyDistance < nearestDistance ? survey : nearest;
  }, SURVEYS[0]).id;
}

import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';

import { track } from './analytics';
import tourCopy from './data/tourCopy.json';
import { markGuidedObservationSeen, hasSeenGuidedObservation } from './guidedObservation';

const TOUR_SEEN_KEY = 'rt-tour-seen';

function markTourSeen() {
  try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch { /* ignore */ }
}

function hasSeenTour(): boolean {
  try { return localStorage.getItem(TOUR_SEEN_KEY) === '1'; } catch { return false; }
}

export function hasSeenAnyOnboarding(): boolean {
  return hasSeenTour() || hasSeenGuidedObservation();
}

export function maybePromptFirstVisit(onStartGuided: () => void) {
  if (hasSeenAnyOnboarding()) return;

  const prompt = driver({
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover rt-tour-prompt',
    showButtons: [],
    steps: [
      {
        popover: {
          title: tourCopy.prompt.title,
          description: tourCopy.prompt.description,
          onPopoverRender: (popover) => {
            const footer = popover.footer as HTMLElement;
            footer.innerHTML = '';
            footer.style.justifyContent = 'flex-end';
            footer.style.flexWrap = 'wrap';

            const dontShow = document.createElement('button');
            dontShow.textContent = tourCopy.prompt.buttons.dontShow;
            dontShow.className = 'rt-tour-btn rt-tour-btn-ghost';
            dontShow.onclick = () => {
              track('tour_prompt_dismissed', { choice: 'dont_show' });
              markTourSeen();
              markGuidedObservationSeen();
              prompt.destroy();
            };

            const later = document.createElement('button');
            later.textContent = tourCopy.prompt.buttons.later;
            later.className = 'rt-tour-btn rt-tour-btn-ghost';
            later.onclick = () => {
              track('tour_prompt_dismissed', { choice: 'later' });
              prompt.destroy();
            };

            const controls = document.createElement('button');
            controls.textContent = tourCopy.prompt.buttons.controls;
            controls.className = 'rt-tour-btn rt-tour-btn-ghost';
            controls.onclick = () => {
              markTourSeen();
              prompt.destroy();
              startTour('first_visit');
            };

            const observe = document.createElement('button');
            observe.textContent = tourCopy.prompt.buttons.observe;
            observe.className = 'rt-tour-btn rt-tour-btn-primary';
            observe.onclick = () => {
              markGuidedObservationSeen();
              prompt.destroy();
              onStartGuided();
            };

            footer.appendChild(dontShow);
            footer.appendChild(later);
            footer.appendChild(controls);
            footer.appendChild(observe);
          },
        },
      },
    ],
  });

  prompt.drive();
}

// Walks the user through each part of the hydrogen-line spectrum, anchored to
// the live chart. Triggered from the "How to read this chart" link under the
// plot. Steps are built from whatever is actually on screen - the hydrogen
// marker, search band, peak marker and readouts only exist once a frame has
// arrived - so we never highlight a missing element.
export function startSpectrumTour() {
  track('spectrum_tour_started');

  const has = (sel: string) => document.querySelector(sel) != null;

  const steps: DriveStep[] = [];

  // Scroll the spectrum into view so the first highlight isn't offscreen.
  document.querySelector('.spectrum-section')?.scrollIntoView({ block: 'start', behavior: 'auto' });

  steps.push({
    element: '.spectrum-chart-box',
    popover: {
      title: tourCopy.spectrumTour.steps.trace.title,
      description: tourCopy.spectrumTour.steps.trace.description,
      side: 'bottom',
      align: 'start',
    },
  });

  if (has('.spectrum-hydrogen-line')) {
    steps.push({
      element: '.spectrum-hydrogen-line',
      popover: {
        title: tourCopy.spectrumTour.steps.hydrogenMarker.title,
        description: tourCopy.spectrumTour.steps.hydrogenMarker.description,
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-hydrogen-band')) {
    steps.push({
      element: '.spectrum-hydrogen-band',
      popover: {
        title: tourCopy.spectrumTour.steps.searchBand.title,
        description: tourCopy.spectrumTour.steps.searchBand.description,
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-peak-marker')) {
    steps.push({
      element: '.spectrum-peak-marker',
      popover: {
        title: tourCopy.spectrumTour.steps.detectedPeak.title,
        description: tourCopy.spectrumTour.steps.detectedPeak.description,
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-readouts')) {
    steps.push({
      element: '.spectrum-readouts',
      popover: {
        title: tourCopy.spectrumTour.steps.measurements.title,
        description: tourCopy.spectrumTour.steps.measurements.description,
        side: 'top',
      },
    });
  }

  if (has('.spectrum-baseline-row')) {
    steps.push({
      element: '.spectrum-baseline-row',
      popover: {
        title: tourCopy.spectrumTour.steps.baselineCorrection.title,
        description: tourCopy.spectrumTour.steps.baselineCorrection.description,
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-waterfall-dropdown')) {
    steps.push({
      element: '.spectrum-waterfall-dropdown',
      popover: {
        title: tourCopy.spectrumTour.steps.waterfall.title,
        description: tourCopy.spectrumTour.steps.waterfall.description,
        side: 'top',
      },
    });
  }

  const tour = driver({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover',
    nextBtnText: tourCopy.spectrumTour.buttons.next,
    prevBtnText: tourCopy.spectrumTour.buttons.back,
    doneBtnText: tourCopy.spectrumTour.buttons.done,
    steps,
  });

  tour.drive();
}

// Matches the breakpoint in main.css where .skymap-overlay-controls is hidden
// and the user is steered toward tapping in Aladin instead of jogging/typing
// a target. Re-evaluated on each tour start so a window resize between tours
// picks the right step list.
function isMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches;
}

export function startTour(source: 'first_visit' | 'button' = 'button') {
  markTourSeen();
  const mobile = isMobileLayout();
  track('tour_started', { source, layout: mobile ? 'mobile' : 'desktop' });
  let lastStepIndex = 0;
  let completed = false;
  const tour = driver({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover',
    nextBtnText: tourCopy.controlsTour.buttons.next,
    prevBtnText: tourCopy.controlsTour.buttons.back,
    doneBtnText: tourCopy.controlsTour.buttons.done,
    onHighlightStarted: (_el, _step, opts) => {
      lastStepIndex = opts.state.activeIndex ?? lastStepIndex;
    },
    onDestroyStarted: (_el, _step, opts) => {
      const total = opts.config.steps?.length ?? 0;
      const idx = opts.state.activeIndex ?? lastStepIndex;
      // driver.js calls onDestroyStarted both for "Done" and for early close;
      // we infer completion by whether we reached the last step.
      if (!completed && idx >= total - 1) {
        completed = true;
        track('tour_completed', { steps: total });
      } else if (!completed) {
        track('tour_abandoned', { last_step_index: idx, total_steps: total });
      }
      opts.driver.destroy();
    },
    steps: [
      {
        popover: {
          title: tourCopy.controlsTour.steps.welcome.title,
          description: tourCopy.controlsTour.steps.welcome.description,
        },
      },
      {
        element: '.topbar',
        popover: {
          title: tourCopy.controlsTour.steps.statusBar.title,
          description: tourCopy.controlsTour.steps.statusBar.description,
          side: 'bottom',
          align: 'start',
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: tourCopy.controlsTour.steps.spectrum.title,
          description: tourCopy.controlsTour.steps.spectrum.description,
          side: mobile ? 'top' : 'right',
        },
      },
      // The jog pad and numeric GoTo form are hidden on mobile in favour of
      // tap-to-target on the sky map, so skip those steps entirely there.
      ...(mobile ? [] : [
        {
          element: '.motion-card',
          popover: {
            title: tourCopy.controlsTour.steps.manualJog.title,
            description: tourCopy.controlsTour.steps.manualJog.description,
            side: 'right' as const,
          },
        },
        {
          element: '.target-form-overlay',
          popover: {
            title: tourCopy.controlsTour.steps.gotoTarget.title,
            description: tourCopy.controlsTour.steps.gotoTarget.description,
            side: 'right' as const,
          },
        },
      ]),
      {
        element: '.skymap-panel',
        popover: {
          title: tourCopy.controlsTour.steps.skyMapDesktop.title,
          description: mobile
            ? tourCopy.controlsTour.steps.skyMapMobile.description
            : tourCopy.controlsTour.steps.skyMapDesktop.description,
          side: mobile ? 'top' : 'left',
        },
      },
      {
        element: '.telemetry-panel',
        popover: {
          title: tourCopy.controlsTour.steps.telemetry.title,
          description: tourCopy.controlsTour.steps.telemetry.description,
          side: mobile ? 'top' : 'left',
        },
      },
      {
        popover: {
          title: tourCopy.controlsTour.steps.done.title,
          description: tourCopy.controlsTour.steps.done.description,
        },
      },
    ],
  });

  tour.drive();
}

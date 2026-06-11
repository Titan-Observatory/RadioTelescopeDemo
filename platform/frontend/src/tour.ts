import { driver, type DriveStep } from 'driver.js';
import 'driver.js/dist/driver.css';
import { track } from './analytics';

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
          title: 'Welcome',
          description:
            "First time here? Pick how you want to start. The control tour shows you what every panel does; the guided observation walks you through capturing a hydrogen-line signal end-to-end.",
          onPopoverRender: (popover) => {
            const footer = popover.footer as HTMLElement;
            footer.innerHTML = '';
            footer.style.justifyContent = 'flex-end';
            footer.style.flexWrap = 'wrap';

            const dontShow = document.createElement('button');
            dontShow.textContent = "Don't show again";
            dontShow.className = 'rt-tour-btn rt-tour-btn-ghost';
            dontShow.onclick = () => {
              track('tour_prompt_dismissed', { choice: 'dont_show' });
              markTourSeen();
              markGuidedObservationSeen();
              prompt.destroy();
            };

            const later = document.createElement('button');
            later.textContent = 'Maybe later';
            later.className = 'rt-tour-btn rt-tour-btn-ghost';
            later.onclick = () => {
              track('tour_prompt_dismissed', { choice: 'later' });
              prompt.destroy();
            };

            const controls = document.createElement('button');
            controls.textContent = 'Tour the controls';
            controls.className = 'rt-tour-btn rt-tour-btn-ghost';
            controls.onclick = () => {
              markTourSeen();
              prompt.destroy();
              startTour('first_visit');
            };

            const observe = document.createElement('button');
            observe.textContent = 'Try a guided observation';
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
// plot. Steps are built from whatever is actually on screen — the hydrogen
// marker, search band, peak marker and readouts only exist once a frame has
// arrived — so we never highlight a missing element.
export function startSpectrumTour() {
  track('spectrum_tour_started');

  const has = (sel: string) => document.querySelector(sel) != null;

  const steps: DriveStep[] = [];

  // Scroll the spectrum into view so the first highlight isn't offscreen.
  document.querySelector('.spectrum-section')?.scrollIntoView({ block: 'start', behavior: 'auto' });

  steps.push({
    element: '.spectrum-chart-box',
    popover: {
      title: 'The trace',
      description:
        'Each point is the radio power the dish hears (vertical axis, in dB) at a given frequency (horizontal axis, in MHz). The live line rides on a noise floor; a real signal pokes up as a bump above it.',
      side: 'bottom',
      align: 'start',
    },
  });

  if (has('.spectrum-hydrogen-line')) {
    steps.push({
      element: '.spectrum-hydrogen-line',
      popover: {
        title: 'The 1420 MHz marker',
        description:
          'Hydrogen atoms emit at exactly 1420.406 MHz when at rest. This vertical marker is where a stationary hydrogen cloud would appear — your reference point for everything else.',
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-hydrogen-band')) {
    steps.push({
      element: '.spectrum-hydrogen-band',
      popover: {
        title: 'The search band',
        description:
          'The shaded strip is ±0.5 MHz around the rest line — the range of Doppler shifts we expect from Galactic gas. A peak left of the marker means gas moving away; right means approaching. Every 0.1 MHz of shift is about 21 km/s.',
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-peak-marker')) {
    steps.push({
      element: '.spectrum-peak-marker',
      popover: {
        title: 'Detected peak',
        description:
          'When a clear bump rises above the noise, it is marked here. Its offset from the 1420 MHz line is what the Doppler velocity below is worked out from.',
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-readouts')) {
    steps.push({
      element: '.spectrum-readouts',
      popover: {
        title: 'The measurements',
        description:
          'The peak frequency, how far it stands above the noise (in dB), and the line-of-sight velocity that frequency shift implies — positive for gas receding, negative for gas approaching.',
        side: 'top',
      },
    });
  }

  if (has('.spectrum-baseline-row')) {
    steps.push({
      element: '.spectrum-baseline-row',
      popover: {
        title: 'Baseline correction',
        description:
          "Receivers have their own bandpass shape even with no signal. Capturing a baseline on empty sky subtracts that shape, so the hydrogen line stands out instead of getting lost in the receiver's own curve.",
        side: 'bottom',
      },
    });
  }

  if (has('.spectrum-waterfall-dropdown')) {
    steps.push({
      element: '.spectrum-waterfall-dropdown',
      popover: {
        title: 'The waterfall',
        description:
          'Open this to see signal strength stacked over time. A genuine hydrogen line shows up as a persistent vertical streak; random noise flickers and never lines up.',
        side: 'top',
      },
    });
  }

  const tour = driver({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover',
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
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
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Done',
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
          title: 'Welcome',
          description:
            'This is a short tour of the telescope control panel. Use Next/Back to step through, or press Esc to exit at any time.',
        },
      },
      {
        element: '.topbar',
        popover: {
          title: 'Status bar',
          description:
            'Connection state, telescope time, and — when you are in control — your session timer live up here.',
          side: 'bottom',
          align: 'start',
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: 'Spectrum',
          description:
            'Live FFT from the SDR. The rolling average is configured on the server; watch for the hydrogen line near 1420 MHz.',
          side: mobile ? 'top' : 'right',
        },
      },
      // The jog pad and numeric GoTo form are hidden on mobile in favour of
      // tap-to-target on the sky map, so skip those steps entirely there.
      ...(mobile ? [] : [
        {
          element: '.motion-card',
          popover: {
            title: 'Manual jog',
            description:
              'Press and hold a direction to nudge the dish. The center button is an emergency stop for all motion, and the speed presets set how fast it moves.',
            side: 'right' as const,
          },
        },
        {
          element: '.target-form-overlay',
          popover: {
            title: 'Go to a target',
            description:
              'Type a target\'s RA (hours) and Dec (degrees) — the coordinates any star chart or catalogue lists — then hit the arrow to drive the dish there automatically.',
            side: 'right' as const,
          },
        },
      ]),
      {
        element: '.skymap-panel',
        popover: {
          title: 'Sky map',
          description: mobile
            ? "Live view of the sky from the telescope's location. Tap a target on the map, then hit Slew to point the dish there."
            : "Live view of the sky from the telescope's location. Click a target on the map, then hit the Slew button that appears to point the dish there.",
          side: mobile ? 'top' : 'left',
        },
      },
      {
        element: '.telemetry-panel',
        popover: {
          title: 'Telemetry',
          description:
            'Encoder positions, motor currents, voltages, and safety state. Watch here if a move feels wrong — overcurrent trips show up immediately.',
          side: mobile ? 'top' : 'left',
        },
      },
      {
        popover: {
          title: 'You are set',
          description:
            'That covers the main sections. You can re-run this tour anytime from the Help button in the top bar.',
        },
      },
    ],
  });

  tour.drive();
}

import { driver } from 'driver.js';
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
              'Press and hold a direction to nudge the dish. The center button is an emergency stop for all motion. The fader sets jog speed.',
            side: 'right' as const,
          },
        },
        {
          element: '.target-form',
          popover: {
            title: 'Go to a target',
            description:
              'Type an azimuth and altitude in degrees, then hit Slew to drive the dish there automatically.',
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
            : "Live view of the sky from the telescope's location. Click a target on the map to load its alt/az into the Slew form.",
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

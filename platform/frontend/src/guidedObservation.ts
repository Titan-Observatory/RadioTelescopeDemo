import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';

import tourCopy from './data/tourCopy.json';

type DriverObj = ReturnType<typeof driver>;

const GUIDED_OBS_SEEN_KEY = 'rt-guided-obs-seen';

export function markGuidedObservationSeen() {
  try { localStorage.setItem(GUIDED_OBS_SEEN_KEY, '1'); } catch { /* ignore */ }
}

export function hasSeenGuidedObservation(): boolean {
  try { return localStorage.getItem(GUIDED_OBS_SEEN_KEY) === '1'; } catch { return false; }
}

// Hand-picked targets. Both sit at high northern declination so they clear the
// horizon for most of the night from a mid-northern site, keeping the demo
// reliable without time-of-day gating.
//
// Reference: Coma, near the North Galactic Pole. Looking "up" out of the
// galactic disk, where almost no hydrogen lies along the line of sight - a
// good "no signal" patch to learn the receiver's own response.
const REFERENCE_RA_DEG = 192.86;
const REFERENCE_DEC_DEG = 27.13;

// Target: Cygnus area, near galactic longitude 80 deg, latitude 0 deg. Long
// column of hydrogen gas through the disk - one of the strongest 21 cm
// directions accessible from northern latitudes.
const TARGET_RA_DEG = 305.0;
const TARGET_DEC_DEG = 40.7;

type SlewFn = (raDeg: number, decDeg: number) => Promise<void>;

function appendSlewButton(
  driverObj: DriverObj,
  popover: { footer: HTMLElement },
  label: string,
  slew: SlewFn,
  raDeg: number,
  decDeg: number,
) {
  const footer = popover.footer as HTMLElement;
  if (!footer) return;
  // Driver renders its own progress + Next/Back into the footer. We insert the
  // slew button to the left of the navigation buttons so it reads as the
  // primary call to action for this step.
  const nav = footer.querySelector('.driver-popover-navigation-btns');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.className = 'rt-tour-btn rt-tour-btn-primary rt-tour-btn-slew';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = tourCopy.guidedObservation.buttons.slewing;
    try {
      await slew(raDeg, decDeg);
    } catch {
      // The notice banner in the app already surfaces slew errors. Advance
      // anyway - the user can re-slew manually if needed.
    } finally {
      driverObj.moveNext();
    }
  };
  if (nav) {
    footer.insertBefore(btn, nav);
  } else {
    footer.appendChild(btn);
  }
}

export function startGuidedObservation(slewToRaDec: SlewFn) {
  markGuidedObservationSeen();

  const obs: DriverObj = driver({
    showProgress: true,
    allowClose: true,
    overlayOpacity: 0.65,
    popoverClass: 'rt-tour-popover',
    nextBtnText: tourCopy.guidedObservation.buttons.next,
    prevBtnText: tourCopy.guidedObservation.buttons.back,
    doneBtnText: tourCopy.guidedObservation.buttons.done,
    progressText: tourCopy.guidedObservation.progressText,
    steps: [
      {
        popover: {
          title: tourCopy.guidedObservation.steps.intro.title,
          description: tourCopy.guidedObservation.steps.intro.description,
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: tourCopy.guidedObservation.steps.liveSignal.title,
          description: tourCopy.guidedObservation.steps.liveSignal.description,
          side: 'left',
          align: 'start',
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: tourCopy.guidedObservation.steps.emptySky.title,
          description: tourCopy.guidedObservation.steps.emptySky.description,
          side: 'left',
          align: 'start',
          onPopoverRender: (popover) => {
            appendSlewButton(
              obs,
              popover,
              tourCopy.guidedObservation.buttons.slewReference,
              slewToRaDec,
              REFERENCE_RA_DEG,
              REFERENCE_DEC_DEG,
            );
          },
        },
      },
      {
        element: '.spectrum-toolbar',
        popover: {
          title: tourCopy.guidedObservation.steps.saveBaseline.title,
          description: tourCopy.guidedObservation.steps.saveBaseline.description,
          side: 'top',
          align: 'start',
        },
      },
      {
        element: '.spectrum-section',
        popover: {
          title: tourCopy.guidedObservation.steps.milkyWay.title,
          description: tourCopy.guidedObservation.steps.milkyWay.description,
          side: 'left',
          align: 'start',
          onPopoverRender: (popover) => {
            appendSlewButton(
              obs,
              popover,
              tourCopy.guidedObservation.buttons.slewGalacticPlane,
              slewToRaDec,
              TARGET_RA_DEG,
              TARGET_DEC_DEG,
            );
          },
        },
      },
      {
        element: '.spectrum-chart-wrap',
        popover: {
          title: tourCopy.guidedObservation.steps.done.title,
          description: tourCopy.guidedObservation.steps.done.description,
          side: 'left',
          align: 'start',
        },
      },
    ],
  });

  obs.drive();
}

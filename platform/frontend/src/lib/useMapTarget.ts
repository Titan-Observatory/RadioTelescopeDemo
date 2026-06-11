// Az/alt target pin that the SkyMap pushes into when the user clicks the sky.
// The Slew button in the dashboard reads this; the GoTo form mirrors it.

import { useCallback, useState } from 'react';
import { track } from '../analytics';

export interface UseMapTargetResult {
  targetAz: number;
  targetAlt: number;
  /** RA/Dec of the clicked point, in degrees. `null` until the first click. */
  targetRaDeg: number | null;
  targetDecDeg: number | null;
  hasMapTarget: boolean;
  setTargetAz: (v: number) => void;
  setTargetAlt: (v: number) => void;
  /** Pin the target on the map at the rounded (az, alt) with its RA/Dec. */
  setTarget: (az: number, alt: number, raDeg: number, decDeg: number) => void;
  /** Drop the pin; safe to call when no target exists. */
  clearTarget: () => void;
}

export function useMapTarget(): UseMapTargetResult {
  const [targetAz, setTargetAz] = useState(0);
  const [targetAlt, setTargetAlt] = useState(45);
  const [targetRaDeg, setTargetRaDeg] = useState<number | null>(null);
  const [targetDecDeg, setTargetDecDeg] = useState<number | null>(null);
  const [hasMapTarget, setHasMapTarget] = useState(false);

  const setTarget = useCallback((az: number, alt: number, raDeg: number, decDeg: number) => {
    setTargetAz(Math.round(az * 1000) / 1000);
    setTargetAlt(Math.round(alt * 1000) / 1000);
    setTargetRaDeg(raDeg);
    setTargetDecDeg(decDeg);
    setHasMapTarget(true);
    track('map_target_picked', { alt_deg: alt, az_deg: az });
  }, []);

  const clearTarget = useCallback(() => {
    setHasMapTarget((prev) => {
      if (!prev) return prev;
      track('map_target_cleared');
      return false;
    });
  }, []);

  return {
    targetAz, targetAlt, targetRaDeg, targetDecDeg, hasMapTarget,
    setTargetAz, setTargetAlt, setTarget, clearTarget,
  };
}

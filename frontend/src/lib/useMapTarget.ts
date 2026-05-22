// Az/alt target pin that the SkyMap pushes into when the user clicks the sky.
// The Slew button in the dashboard reads this; the GoTo form mirrors it.

import { useCallback, useState } from 'react';
import { track } from '../analytics';

export interface UseMapTargetResult {
  targetAz: number;
  targetAlt: number;
  hasMapTarget: boolean;
  setTargetAz: (v: number) => void;
  setTargetAlt: (v: number) => void;
  /** Pin the target on the map at the rounded (az, alt). */
  setTarget: (az: number, alt: number) => void;
  /** Drop the pin; safe to call when no target exists. */
  clearTarget: () => void;
}

export function useMapTarget(): UseMapTargetResult {
  const [targetAz, setTargetAz] = useState(0);
  const [targetAlt, setTargetAlt] = useState(45);
  const [hasMapTarget, setHasMapTarget] = useState(false);

  const setTarget = useCallback((az: number, alt: number) => {
    setTargetAz(Math.round(az * 1000) / 1000);
    setTargetAlt(Math.round(alt * 1000) / 1000);
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

  return { targetAz, targetAlt, hasMapTarget, setTargetAz, setTargetAlt, setTarget, clearTarget };
}

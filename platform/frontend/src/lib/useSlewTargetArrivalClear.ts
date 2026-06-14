import { useCallback, useEffect, useRef } from 'react';

import { normalizeDeg, unwrapDeg } from './astro';
import type { RoboClawTelemetry } from '../types';

const ARRIVAL_TOLERANCE_DEG = 0.15;
const TARGET_CHANGE_EPSILON_DEG = 0.001;

interface SlewTarget {
  alt: number;
  az: number;
  altArrived: boolean;
  azArrived: boolean;
  lastAltDelta: number | null;
  lastAzDelta: number | null;
}

export function useSlewTargetArrivalClear({
  hasMapTarget,
  targetAlt,
  targetAz,
  telemetry,
  clearTarget,
}: {
  hasMapTarget: boolean;
  targetAlt: number;
  targetAz: number;
  telemetry: RoboClawTelemetry | null;
  clearTarget: () => void;
}): (alt: number, az: number) => void {
  const submittedRef = useRef<SlewTarget | null>(null);

  useEffect(() => {
    const submitted = submittedRef.current;
    if (!hasMapTarget || submitted == null) {
      submittedRef.current = null;
      return;
    }
    if (
      Math.abs(targetAlt - submitted.alt) > TARGET_CHANGE_EPSILON_DEG ||
      Math.abs(shortestAzDelta(targetAz, submitted.az)) > TARGET_CHANGE_EPSILON_DEG
    ) {
      submittedRef.current = null;
    }
  }, [hasMapTarget, targetAlt, targetAz]);

  useEffect(() => {
    const submitted = submittedRef.current;
    if (!hasMapTarget || submitted == null || telemetry?.altitude_deg == null || telemetry.azimuth_deg == null) {
      return;
    }

    const altDelta = telemetry.altitude_deg - submitted.alt;
    const azDelta = shortestAzDelta(telemetry.azimuth_deg, submitted.az);
    const altArrived = submitted.altArrived || axisReached(altDelta, submitted.lastAltDelta);
    const azArrived = submitted.azArrived || axisReached(azDelta, submitted.lastAzDelta);

    if (altArrived && azArrived) {
      submittedRef.current = null;
      clearTarget();
      return;
    }

    submittedRef.current = {
      ...submitted,
      altArrived,
      azArrived,
      lastAltDelta: altDelta,
      lastAzDelta: azDelta,
    };
  }, [clearTarget, hasMapTarget, telemetry?.altitude_deg, telemetry?.azimuth_deg]);

  return useCallback((alt: number, az: number) => {
    submittedRef.current = {
      alt,
      az: normalizeDeg(az),
      altArrived: false,
      azArrived: false,
      lastAltDelta: null,
      lastAzDelta: null,
    };
  }, []);
}

function axisReached(delta: number, lastDelta: number | null): boolean {
  if (Math.abs(delta) <= ARRIVAL_TOLERANCE_DEG) return true;
  return lastDelta != null && ((lastDelta < 0 && delta > 0) || (lastDelta > 0 && delta < 0));
}

function shortestAzDelta(fromAz: number, toAz: number): number {
  return unwrapDeg(fromAz, toAz) - toAz;
}

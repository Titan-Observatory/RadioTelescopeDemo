import {
  altAzToRaDec,
  normalizeDeg,
  positionAngleDeg,
  raDecToAltAz,
} from '../../../lib/astro';
import type { AltAzPoint, RaDecTarget, TelescopeConfig } from '../../../types';


export const DEFAULT_HORIZON_VIEW: AltAzPoint = {
  altitude_deg: 15,
  azimuth_deg: 45,
};


export function localUpOrientationDeg(center: RaDecTarget, config: TelescopeConfig, date: Date): number {
  const centerAltAz = raDecToAltAz(center.ra_deg, center.dec_deg, config, date);
  const upAlt = Math.min(89.5, centerAltAz.altitude_deg + 1);
  const localUp = altAzToRaDec(
    { altitude_deg: upAlt, azimuth_deg: centerAltAz.azimuth_deg },
    config,
    date,
  );
  return positionAngleDeg(center, localUp);
}


export function initialHorizonRotationDeg(center: RaDecTarget, config: TelescopeConfig, date: Date): number {
  const rotation = normalizeDeg(360 - localUpOrientationDeg(center, config, date));
  return rotation === 0 ? 0.001 : rotation;
}

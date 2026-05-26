import { Activity, Navigation, Zap } from 'lucide-react';
import React from 'react';

import { altAzToRaDec, raDecToGalactic } from '../lib/astro';
import {
  amps, celsius, encoder, maxAbsReading, maxReading, motorState,
  tempClass, voltClass, volts,
} from '../lib/formatters';
import type { LnaStatus, RoboClawTelemetry, TelescopeConfig } from '../types';

type ReadoutRow = [label: string, value: React.ReactNode, valueClass?: string];

function DenseReadout({ title, icon, rows }: { title?: string; icon?: React.ReactNode; rows: ReadoutRow[] }) {
  return (
    <div className="dense-readout">
      {title && (
        <h3>
          {icon && <span className="readout-icon">{icon}</span>}
          {title}
        </h3>
      )}
      <dl>
        {rows.map(([label, val, cls]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd className={cls ?? ''}>{val}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

function LnaIndicator({ status }: { status: LnaStatus | null | undefined }) {
  const state = status?.state ?? 'unknown';
  const label = status?.label ?? 'Unknown';
  return (
    <span className={`lna-status-text lna-status-${state}`} title={status?.detail ?? ''}>
      {label}
    </span>
  );
}

export function TelemetryDashboard({
  telemetry,
  config,
  lnaStatus,
}: {
  telemetry: RoboClawTelemetry | null;
  config: TelescopeConfig | null;
  lnaStatus: LnaStatus | null;
}) {
  const systemPower = telemetry?.main_battery_v ?? null;
  const roboclawTemp = maxReading(telemetry?.temperature_c, telemetry?.temperature_2_c);
  const motorOutput = maxAbsReading(telemetry?.motors.m1?.pwm, telemetry?.motors.m2?.pwm);
  const motorSpeed = maxAbsReading(telemetry?.motors.m1?.speed_qpps, telemetry?.motors.m2?.speed_qpps);

  const galactic = React.useMemo(() => {
    if (telemetry?.azimuth_deg == null || telemetry?.altitude_deg == null || config == null) return null;
    const radec = altAzToRaDec(
      { altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg },
      config,
      new Date(),
    );
    return raDecToGalactic(radec.ra_deg, radec.dec_deg);
  }, [telemetry?.azimuth_deg, telemetry?.altitude_deg, config]);

  return (
    <div className="telemetry-dense">
      <DenseReadout title="System" icon={<Activity size={11} />} rows={[
        ['Connection', telemetry?.connection?.connected === false ? 'Issue' : 'Stable', telemetry?.connection?.connected === false ? 'val-crit' : 'val-ok'],
        ['LNA', <LnaIndicator status={lnaStatus} />],
        ['Power', volts(systemPower), voltClass(systemPower)],
        ['RoboClaw temp', celsius(roboclawTemp), tempClass(roboclawTemp)],
        ['Pi temp', celsius(telemetry?.host.cpu_temp_c), tempClass(telemetry?.host.cpu_temp_c)],
      ]} />
      <DenseReadout title="Pointing" icon={<Navigation size={11} />} rows={[
        ['Azimuth', telemetry?.azimuth_deg == null ? '—' : `${telemetry.azimuth_deg.toFixed(2)}°`],
        ['Elevation', telemetry?.altitude_deg == null ? '—' : `${telemetry.altitude_deg.toFixed(2)}°`],
        ['Gal. lon (l)', galactic == null ? '—' : `${galactic.l_deg.toFixed(2)}°`],
        ['Gal. lat (b)', galactic == null ? '—' : `${galactic.b_deg.toFixed(2)}°`],
      ]} />
      <DenseReadout title="Drive" icon={<Zap size={11} />} rows={[
        ['State', motorState(motorSpeed, motorOutput)],
        ['Azimuth amps', amps(telemetry?.motors.m1?.current_a)],
        ['Elevation amps', amps(telemetry?.motors.m2?.current_a)],
        ['Azimuth encoder', encoder(telemetry?.motors.m1?.encoder)],
        ['Elevation encoder', encoder(telemetry?.motors.m2?.encoder)],
      ]} />
    </div>
  );
}

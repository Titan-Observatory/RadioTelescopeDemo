import { Activity, ChevronDown, ChevronUp, Navigation, Zap } from 'lucide-react';
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

function raHours(raDeg: number): string {
  const hours = ((raDeg / 15) % 24 + 24) % 24;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m === 60 ? `${(h + 1) % 24}h 00m` : `${h}h ${String(m).padStart(2, '0')}m`;
}

function decDegrees(decDeg: number): string {
  return `${decDeg >= 0 ? '+' : '-'}${Math.abs(decDeg).toFixed(1)}°`;
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
  const [collapsed, setCollapsed] = React.useState(false);
  const panelId = React.useId();

  const sky = React.useMemo(() => {
    if (telemetry?.azimuth_deg == null || telemetry?.altitude_deg == null || config == null) return null;
    const radec = altAzToRaDec(
      { altitude_deg: telemetry.altitude_deg, azimuth_deg: telemetry.azimuth_deg },
      config,
      new Date(),
    );
    return { radec, galactic: raDecToGalactic(radec.ra_deg, radec.dec_deg) };
  }, [telemetry?.azimuth_deg, telemetry?.altitude_deg, config]);

  const connectionRow: ReadoutRow = telemetry == null
    ? ['Link', 'Waiting...', 'val-muted']
    : telemetry.connection?.connected === false
      ? ['Link', 'Issue', 'val-crit']
      : ['Link', 'Stable', 'val-ok'];

  return (
    <div className={`telemetry-dashboard${collapsed ? ' is-collapsed' : ''}`}>
      <button
        type="button"
        className="telemetry-collapse-toggle"
        aria-expanded={!collapsed}
        aria-controls={panelId}
        aria-label={collapsed ? 'Expand telemetry panel' : 'Collapse telemetry panel'}
        onClick={() => setCollapsed((value) => !value)}
      >
        {collapsed ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      <div id={panelId} className="telemetry-collapse-body">
        <div className="telemetry-dense">
          <DenseReadout
            title="System"
            icon={<Activity size={11} />}
            rows={[
              connectionRow,
              ['LNA', <LnaIndicator status={lnaStatus} />],
              ['Power', volts(systemPower), voltClass(systemPower)],
              ['Controller temp', celsius(roboclawTemp), tempClass(roboclawTemp)],
              ['Pi temp', celsius(telemetry?.host.cpu_temp_c), tempClass(telemetry?.host.cpu_temp_c)],
            ]}
          />
          <DenseReadout
            title="Pointing"
            icon={<Navigation size={11} />}
            rows={[
              ['Azimuth', telemetry?.azimuth_deg == null ? '-' : `${telemetry.azimuth_deg.toFixed(2)}°`],
              ['Elevation', telemetry?.altitude_deg == null ? '-' : `${telemetry.altitude_deg.toFixed(2)}°`],
              ['RA', sky == null ? '-' : raHours(sky.radec.ra_deg)],
              ['Dec', sky == null ? '-' : decDegrees(sky.radec.dec_deg)],
              ['Galactic l', sky == null ? '-' : `${sky.galactic.l_deg.toFixed(1)}°`],
              ['Galactic b', sky == null ? '-' : `${sky.galactic.b_deg.toFixed(1)}°`],
            ]}
          />
          <DenseReadout
            title="Drive"
            icon={<Zap size={11} />}
            rows={[
              ['State', motorState(motorSpeed, motorOutput)],
              ['Az current', amps(telemetry?.motors.m1?.current_a)],
              ['El current', amps(telemetry?.motors.m2?.current_a)],
              ['Az encoder', encoder(telemetry?.motors.m1?.encoder)],
              ['El encoder', encoder(telemetry?.motors.m2?.encoder)],
            ]}
          />
        </div>
      </div>
    </div>
  );
}

import { Activity, Navigation, Zap } from 'lucide-react';
import React from 'react';

import {
  amps, celsius, encoder, maxAbsReading, maxReading, minReading, motorState,
  tempClass, voltClass, volts,
} from '../lib/formatters';
import type { LnaStatus, RoboClawTelemetry } from '../types';

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

function LnaPill({
  status,
  changing,
  onToggle,
}: {
  status: LnaStatus | null | undefined;
  changing: boolean;
  onToggle: () => void;
}) {
  const state = status?.state ?? 'unknown';
  const label = changing ? '...' : (status?.label ?? 'Unknown');
  const next = state === 'on' ? 'off' : 'on';
  return (
    <button
      type="button"
      className={`lna-status-pill lna-status-${state}`}
      title={status?.detail ?? `Turn LNA ${next}`}
      aria-label={`Turn LNA ${next}`}
      aria-pressed={state === 'on'}
      disabled={changing}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

export function TelemetryDashboard({
  telemetry,
  lnaStatus,
  lnaChanging,
  onToggleLna,
}: {
  telemetry: RoboClawTelemetry | null;
  lnaStatus: LnaStatus | null;
  lnaChanging: boolean;
  onToggleLna: () => void;
}) {
  const systemPower = minReading(telemetry?.main_battery_v, telemetry?.logic_battery_v);
  const roboclawTemp = maxReading(telemetry?.temperature_c, telemetry?.temperature_2_c);
  const motorOutput = maxAbsReading(telemetry?.motors.m1?.pwm, telemetry?.motors.m2?.pwm);
  const motorSpeed = maxAbsReading(telemetry?.motors.m1?.speed_qpps, telemetry?.motors.m2?.speed_qpps);

  return (
    <div className="telemetry-dense">
      <DenseReadout title="System" icon={<Activity size={11} />} rows={[
        ['Connection', telemetry?.connection?.connected === false ? 'Issue' : 'Stable', telemetry?.connection?.connected === false ? 'val-crit' : 'val-ok'],
        ['LNA', <LnaPill status={lnaStatus} changing={lnaChanging} onToggle={onToggleLna} />],
        ['Power', volts(systemPower), voltClass(systemPower)],
        ['RoboClaw temp', celsius(roboclawTemp), tempClass(roboclawTemp)],
        ['Pi temp', celsius(telemetry?.host.cpu_temp_c), tempClass(telemetry?.host.cpu_temp_c)],
      ]} />
      <DenseReadout title="Pointing" icon={<Navigation size={11} />} rows={[
        ['Azimuth', telemetry?.azimuth_deg == null ? '—' : `${telemetry.azimuth_deg.toFixed(2)}°`],
        ['Elevation', telemetry?.altitude_deg == null ? '—' : `${telemetry.altitude_deg.toFixed(2)}°`],
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

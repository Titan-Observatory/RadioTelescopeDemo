// Wraps the four motion entry points (runCommand, gotoAltAz, stopMotion,
// startObservationGuide) with analytics. The telemetry websocket
// (`useTelemetry`) pushes fresh snapshots on its own ~200 ms cadence, so
// these wrappers don't tail every command with an HTTP status fetch — that
// round-trip used to double the perceived latency of every button press.

import { useCallback, useMemo } from 'react';
import { api } from '../api';
import { track } from '../analytics';
import { startGuidedObservation } from '../guidedObservation';
import { errorMessage } from './formatters';
import type { JogDirection } from '../api';
import type { CommandInfo } from '../types';

export interface UseMotionCommandsResult {
  runCommand: (commandId: string, args: Record<string, number | boolean>) => Promise<void>;
  jog: (direction: JogDirection, speed: number, token: string, seq: number) => Promise<void>;
  stopJog: (token: string, seq: number) => Promise<void>;
  gotoAltAz: (altDeg: number, azDeg: number) => Promise<void>;
  gotoRaDec: (raDeg: number, decDeg: number) => Promise<void>;
  stopMotion: () => Promise<void>;
  startObservationGuide: () => void;
}

export function useMotionCommands(
  commands: CommandInfo[],
): UseMotionCommandsResult {
  const commandById = useMemo(
    () => Object.fromEntries(commands.map((c) => [c.id, c])),
    [commands],
  );

  const runCommand = useCallback(async (commandId: string, args: Record<string, number | boolean>) => {
    const command = commandById[commandId];
    if (!command) {
      track('command_failed', { command_id: commandId, message: 'unavailable' });
      return;
    }
    try {
      await api.execute(command.id, args);
    } catch (err) {
      track('command_failed', { command_id: commandId, message: errorMessage(err).slice(0, 200) });
    }
  }, [commandById]);

  const gotoAltAz = useCallback(async (altDeg: number, azDeg: number) => {
    track('goto_submitted', { alt_deg: altDeg, az_deg: azDeg });
    try {
      await api.gotoAltAz(altDeg, azDeg);
    } catch (err) {
      track('goto_failed', { message: errorMessage(err).slice(0, 200) });
    }
  }, []);

  const jog = useCallback(async (
    direction: JogDirection,
    speed: number,
    token: string,
    seq: number,
  ) => {
    try {
      await api.jog(direction, speed, token, seq);
    } catch (err) {
      track('jog_failed', { direction, message: errorMessage(err).slice(0, 200) });
    }
  }, []);

  const stopJog = useCallback(async (token: string, seq: number) => {
    try {
      await api.stopJog(token, seq);
    } catch (err) {
      track('command_failed', { command_id: 'jog_stop', message: errorMessage(err).slice(0, 200) });
    }
  }, []);

  const stopMotion = useCallback(async () => {
    track('motion_stop');
    try {
      await api.stop();
    } catch (err) {
      track('command_failed', { command_id: 'stop', message: errorMessage(err).slice(0, 200) });
    }
  }, []);

  const gotoRaDec = useCallback(async (raDeg: number, decDeg: number) => {
    track('goto_radec_submitted', { ra_deg: raDeg, dec_deg: decDeg });
    try {
      await api.gotoRaDec({ ra_deg: raDeg, dec_deg: decDeg });
    } catch (err) {
      track('goto_radec_failed', { message: errorMessage(err).slice(0, 200) });
      throw err;
    }
  }, []);

  const startObservationGuide = useCallback(() => {
    startGuidedObservation();
  }, []);

  return { runCommand, jog, stopJog, gotoAltAz, gotoRaDec, stopMotion, startObservationGuide };
}

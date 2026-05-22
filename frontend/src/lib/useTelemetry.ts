// Owns the RoboClaw telemetry stream: the initial fetch, the websocket
// subscription, and the latest snapshot. `setTelemetry` is exposed so command
// handlers can prime the cache with a fresh status read immediately after a
// motion command (without waiting for the next WS frame).

import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorMessage } from './formatters';
import { useJsonSocket } from './useJsonSocket';
import type { RoboClawTelemetry } from '../types';

export interface UseTelemetryOptions {
  onError: (source: string, message: string) => void;
}

export interface UseTelemetryResult {
  telemetry: RoboClawTelemetry | null;
  setTelemetry: (next: RoboClawTelemetry) => void;
}

export function useTelemetry({ onError }: UseTelemetryOptions): UseTelemetryResult {
  const [telemetry, setTelemetry] = useState<RoboClawTelemetry | null>(null);

  useEffect(() => {
    void api.status().then((next) => {
      setTelemetry(next);
      if (next.last_error) onError('RoboClaw', next.last_error);
    }).catch((err) => onError('API', errorMessage(err)));
  }, [onError]);

  useJsonSocket<RoboClawTelemetry>('/ws/roboclaw', {
    onMessage: (next) => {
      setTelemetry(next);
      if (next.last_error) onError('RoboClaw', next.last_error);
    },
    onError: () => onError('WebSocket', 'RoboClaw telemetry websocket disconnected.'),
  });

  return { telemetry, setTelemetry };
}

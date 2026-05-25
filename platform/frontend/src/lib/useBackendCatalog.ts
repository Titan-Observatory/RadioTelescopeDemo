// Read-only bootstrap state: the command catalogue + telescope geometry config.
// Neither changes after page load, so a single fetch on mount is sufficient.

import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorMessage } from './formatters';
import type { CommandInfo, TelescopeConfig } from '../types';

// Fallback so the SkyMap (horizon overlay, zenith-locked rotation, alt/az grid)
// still renders when the hardware service is unreachable. Mirrors the hardware
// defaults from config.example.toml — close enough to keep the horizon math
// sane for a visitor with no live backend.
const DEFAULT_TELESCOPE_CONFIG: TelescopeConfig = {
  beam_fwhm_deg: 6.5,
  goto_speed_qpps: 10000,
  goto_accel_qpps2: 25000,
  goto_decel_qpps2: 25000,
  observer_latitude_deg: 51.5,
  observer_longitude_deg: -0.1,
  pointing_limit_altaz: [],
};

export interface UseBackendCatalogOptions {
  onError: (source: string, message: string) => void;
  enabled?: boolean;
}

export interface UseBackendCatalogResult {
  commands: CommandInfo[];
  telescopeConfig: TelescopeConfig | null;
}

export function useBackendCatalog({ onError, enabled = true }: UseBackendCatalogOptions): UseBackendCatalogResult {
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [telescopeConfig, setTelescopeConfig] = useState<TelescopeConfig | null>(DEFAULT_TELESCOPE_CONFIG);

  useEffect(() => {
    if (!enabled) return;
    void api.commands().then(setCommands).catch((err) => onError('API', errorMessage(err)));
    // If the backend is reachable we overwrite the default with real values;
    // otherwise the SkyMap keeps rendering against the fallback above.
    void api.telescopeConfig().then(setTelescopeConfig).catch(() => { /* non-critical */ });
  }, [enabled, onError]);

  return { commands, telescopeConfig };
}

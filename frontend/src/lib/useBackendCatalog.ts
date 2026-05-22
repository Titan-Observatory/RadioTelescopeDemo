// Read-only bootstrap state: the command catalogue + telescope geometry config.
// Neither changes after page load, so a single fetch on mount is sufficient.

import { useEffect, useState } from 'react';
import { api } from '../api';
import { errorMessage } from './formatters';
import type { CommandInfo, TelescopeConfig } from '../types';

export interface UseBackendCatalogOptions {
  onError: (source: string, message: string) => void;
}

export interface UseBackendCatalogResult {
  commands: CommandInfo[];
  telescopeConfig: TelescopeConfig | null;
}

export function useBackendCatalog({ onError }: UseBackendCatalogOptions): UseBackendCatalogResult {
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [telescopeConfig, setTelescopeConfig] = useState<TelescopeConfig | null>(null);

  useEffect(() => {
    void api.commands().then(setCommands).catch((err) => onError('API', errorMessage(err)));
    // telescope config is non-critical — the SkyMap renders without it.
    void api.telescopeConfig().then(setTelescopeConfig).catch(() => { /* non-critical */ });
  }, [onError]);

  return { commands, telescopeConfig };
}

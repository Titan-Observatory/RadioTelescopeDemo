// LNA bias-tee status. Polls every 3 s in the background so the readout stays
// current when the hardware service initializes or external tools inspect it.

import { useCallback, useEffect, useState } from 'react';
import type { LnaStatus } from '../types';

interface RfStatus {
  lna?: LnaStatus;
}

export interface UseLnaResult {
  lnaStatus: LnaStatus | null;
}

export function useLna(enabled = true): UseLnaResult {
  const [lnaStatus, setLnaStatus] = useState<LnaStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/spectrum/status');
      if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
      const next = await resp.json() as RfStatus;
      setLnaStatus(next.lna ?? null);
    } catch {
      setLnaStatus({ state: 'unknown', label: 'Unknown', detail: 'RF status unavailable' });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = async () => { if (!cancelled) await refresh(); };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, refresh]);

  return { lnaStatus };
}

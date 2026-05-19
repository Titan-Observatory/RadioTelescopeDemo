// LNA bias-tee status + toggle. Polls every 3 s in the background so the
// readout stays current when external tools (CLI, deploy scripts) flip the
// state behind our back.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { track } from '../analytics';
import { errorMessage } from './formatters';
import type { LnaStatus } from '../types';

interface RfStatus {
  lna?: LnaStatus;
}

export interface UseLnaResult {
  lnaStatus: LnaStatus | null;
  lnaChanging: boolean;
  toggleLna: () => Promise<void>;
}

export function useLna(): UseLnaResult {
  const [lnaStatus, setLnaStatus] = useState<LnaStatus | null>(null);
  const [lnaChanging, setLnaChanging] = useState(false);

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
    let cancelled = false;
    const tick = async () => { if (!cancelled) await refresh(); };
    void tick();
    const id = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refresh]);

  const toggleLna = useCallback(async () => {
    if (lnaChanging) return;
    const enabled = lnaStatus?.state !== 'on';
    setLnaChanging(true);
    setLnaStatus({
      state: enabled ? 'on' : 'off',
      label: enabled ? 'On' : 'Off',
      detail: enabled ? 'Turning Airspy bias tee on' : 'Turning Airspy bias tee off',
    });
    try {
      const result = await api.setSpectrumLna(enabled);
      setLnaStatus(result.lna);
      track('lna_toggled', { enabled, ok: result.ok });
    } catch (err) {
      track('lna_toggle_failed', { enabled, message: errorMessage(err).slice(0, 200) });
      await refresh();
    } finally {
      setLnaChanging(false);
    }
  }, [lnaChanging, lnaStatus, refresh]);

  return { lnaStatus, lnaChanging, toggleLna };
}

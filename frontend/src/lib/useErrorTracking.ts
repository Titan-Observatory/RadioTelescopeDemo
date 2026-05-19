// Errors are tracked for analytics but never surfaced to the demo user —
// public visitors see a quiet UI even when the controller is misbehaving.
// Dedup last (source, message) to avoid flooding the events log on a flap.

import { useCallback, useRef } from 'react';
import { track } from '../analytics';

export function useErrorTracking(): { trackErrorOnce: (source: string, message: string) => void } {
  const lastErrorRef = useRef<{ source: string; message: string } | null>(null);
  const trackErrorOnce = useCallback((source: string, message: string) => {
    const last = lastErrorRef.current;
    if (last && last.source === source && last.message === message) return;
    lastErrorRef.current = { source, message };
    track('error_shown', { source, message: message.slice(0, 200) });
  }, []);
  return { trackErrorOnce };
}

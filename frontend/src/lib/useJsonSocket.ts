// Tiny React hook around `WebSocket` that:
//   • picks `ws` vs `wss` from the current page protocol,
//   • JSON-parses each incoming text frame,
//   • tracks the connection state for the caller,
//   • cleans up on unmount.
// Auto-reconnect is intentionally NOT included — none of today's call sites
// reconnect, and adding it here without a real call site to drive its shape
// would over-design the helper.

import { useEffect, useRef, useState } from 'react';

export function wsUrl(path: string): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

export interface UseJsonSocketOptions<T> {
  /** Called for every successfully-parsed message. */
  onMessage: (msg: T) => void;
  /** Optional hook for one-shot error reporting (e.g. analytics). */
  onError?: (event: Event) => void;
  /** Disable the connection without unmounting the component. */
  enabled?: boolean;
}

export interface UseJsonSocketResult {
  connected: boolean;
  /** Send a string frame if the socket is open. No-op otherwise. */
  send: (data: string) => void;
}

export function useJsonSocket<T>(
  path: string,
  opts: UseJsonSocketOptions<T>,
): UseJsonSocketResult {
  const { onMessage, onError, enabled = true } = opts;
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // Stash the latest callbacks so the effect can re-use them without
  // re-mounting the socket every time the parent re-renders with fresh
  // inline closures.
  const onMessageRef = useRef(onMessage);
  const onErrorRef = useRef(onError);
  onMessageRef.current = onMessage;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) return;
    const ws = new WebSocket(wsUrl(path));
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = (event) => {
      setConnected(false);
      onErrorRef.current?.(event);
    };
    ws.onmessage = (event) => {
      try {
        onMessageRef.current(JSON.parse(event.data) as T);
      } catch { /* drop malformed frames */ }
    };
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [path, enabled]);

  return {
    connected,
    send: (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    },
  };
}

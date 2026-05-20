// Tiny React hook around `WebSocket` that:
//   • picks `ws` vs `wss` from the current page protocol,
//   • JSON-parses each incoming text frame,
//   • tracks the connection state for the caller,
//   • reconnects with exponential backoff (1s, 2s, 4s, 8s, 16s cap) after a
//     disconnect, resetting the delay on a successful open,
//   • cleans up on unmount.

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
  /** True between a drop and the next successful open. UI can use this to
   *  surface a "reconnecting…" hint instead of going silently dead. */
  reconnecting: boolean;
  /** Send a string frame if the socket is open. No-op otherwise. */
  send: (data: string) => void;
}

// Public network can drop a socket for any number of reasons (proxy idle
// timeout, WiFi handoff, brief backend reload). Back off in a sequence the
// user might tolerate but never give up entirely while the page is open.
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;

export function useJsonSocket<T>(
  path: string,
  opts: UseJsonSocketOptions<T>,
): UseJsonSocketResult {
  const { onMessage, onError, enabled = true } = opts;
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
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

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt += 1;
      setReconnecting(true);
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(wsUrl(path));
      wsRef.current = ws;
      ws.onopen = () => {
        if (cancelled) return;
        attempt = 0;
        setConnected(true);
        setReconnecting(false);
      };
      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        scheduleReconnect();
      };
      ws.onerror = (event) => {
        if (cancelled) return;
        setConnected(false);
        onErrorRef.current?.(event);
        // `onclose` follows `onerror`; let it drive the reconnect to avoid
        // double-scheduling.
      };
      ws.onmessage = (event) => {
        try {
          onMessageRef.current(JSON.parse(event.data) as T);
        } catch { /* drop malformed frames */ }
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [path, enabled]);

  return {
    connected,
    reconnecting,
    send: (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    },
  };
}

// Owns everything queue/lease-related: the initial fetches, the WS
// subscription, the activity heartbeat that keeps the lease alive while the
// user interacts, lease-expiry auto-reload, the join flow, and the derived
// "am I the active controller" flag (including the welcome-card ack).

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, RateLimitError } from '../api';
import { track } from '../analytics';
import { errorMessage } from './formatters';
import { useJsonSocket } from './useJsonSocket';
import type { QueueConfig, QueueStatus } from '../queue';

export interface UseQueueLeaseResult {
  queueStatus: QueueStatus | null;
  queueConfig: QueueConfig | null;
  /** True once the initial queue config request has completed. */
  queueReady: boolean;
  /** True iff the server has a queue configured. */
  queueEnabled: boolean;
  /** True if either the queue is off OR we currently hold the lease. */
  hasControl: boolean;
  /** True iff we hold the lease AND the user has acknowledged the welcome card. */
  isActiveController: boolean;
  joining: boolean;
  joinError: string | null;
  /** Seconds left until the user can retry a rate-limited join. Ticks down to
   *  null when the cooldown elapses. */
  joinRateLimitedSec: number | null;
  join: (turnstileToken: string | null, betaPassword: string | null) => Promise<void>;
  /** Move past the welcome card once the user clicks "Continue". */
  acknowledgeContinue: () => void;
}

export function useQueueLease(): UseQueueLeaseResult {
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [queueConfig, setQueueConfig] = useState<QueueConfig | null>(null);
  const [queueReady, setQueueReady] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinRateLimitedSec, setJoinRateLimitedSec] = useState<number | null>(null);
  const [continueAcked, setContinueAcked] = useState(false);
  const prevIsActiveRef = useRef<boolean | null>(null);
  const lastLeaseRemainingRef = useRef<number | null>(null);

  // Bootstrap.
  useEffect(() => {
    void api.queueConfig()
      .then(setQueueConfig)
      .catch(() => { /* queue may be disabled */ })
      .finally(() => setQueueReady(true));
    void api.queueStatus().then(setQueueStatus).catch(() => { /* not joined yet */ });
  }, []);

  const queueEnabled = queueConfig?.enabled ?? false;
  const hasControl = !queueEnabled || queueStatus?.is_active === true;
  const isActiveController = hasControl && (!queueEnabled || continueAcked);

  // Subscribe to queue status updates as long as we have a session cookie.
  const wsEnabled = queueStatus != null && queueStatus.position >= 0;
  const { send: sendQueueActivity } = useJsonSocket<QueueStatus>('/ws/queue', {
    enabled: wsEnabled,
    onMessage: (next) => {
      if (typeof next.position === 'number') setQueueStatus(next);
    },
  });

  // Treat any UI activity (click, scroll, keypress, pointer) as a heartbeat
  // that resets the server-side idle countdown. Throttled so we send at most
  // once every few seconds while the user is interacting.
  useEffect(() => {
    if (!wsEnabled) return;
    let lastSent = 0;
    const sendActivity = () => {
      const now = Date.now();
      if (now - lastSent < 5000) return;
      lastSent = now;
      sendQueueActivity('a');
    };
    const events: (keyof DocumentEventMap)[] = ['click', 'scroll', 'keydown', 'pointerdown', 'wheel', 'touchstart'];
    for (const e of events) {
      document.addEventListener(e, sendActivity, { passive: true, capture: true });
    }
    return () => {
      for (const e of events) {
        document.removeEventListener(e, sendActivity, { capture: true });
      }
    };
  }, [wsEnabled, sendQueueActivity]);

  // Track the last known lease time so we can distinguish lease expiry from
  // idle timeout when the session drops.
  useEffect(() => {
    if (queueStatus?.lease_remaining_s != null) {
      lastLeaseRemainingRef.current = queueStatus.lease_remaining_s;
    }
  }, [queueStatus?.lease_remaining_s]);

  // Auto-refresh only on hard lease expiry with an empty queue. An idle
  // timeout leaves plenty of lease time remaining, so lastLeaseRemainingRef
  // will still be high — correctly skipping the reload in that case.
  useEffect(() => {
    const wasActive = prevIsActiveRef.current;
    prevIsActiveRef.current = queueStatus?.is_active ?? null;
    if (
      wasActive === true &&
      queueStatus?.is_active === false &&
      queueStatus.queue_length === 0 &&
      lastLeaseRemainingRef.current != null &&
      lastLeaseRemainingRef.current < 15
    ) {
      window.location.reload();
    }
  }, [queueStatus?.is_active, queueStatus?.queue_length]);

  const join = useCallback(async (turnstileToken: string | null, betaPassword: string | null) => {
    setJoining(true);
    setJoinError(null);
    setJoinRateLimitedSec(null);
    track('queue_join_attempt', { turnstile: turnstileToken != null });
    try {
      const next = await api.joinQueue(turnstileToken, betaPassword);
      setQueueStatus(next);
      track('queue_joined', { position: next.position, queue_length: next.queue_length });
    } catch (err) {
      const message = errorMessage(err);
      setJoinError(message);
      if (err instanceof RateLimitError) {
        setJoinRateLimitedSec(Math.max(1, err.retryAfterSec));
        track('queue_join_rate_limited', { retry_after_sec: err.retryAfterSec });
      } else {
        track('queue_join_failed', { message: message.slice(0, 200) });
      }
    } finally {
      setJoining(false);
    }
  }, []);

  // Tick the rate-limit countdown down to null once it elapses. The QueuePage
  // reads this each render to drive the disabled-button label.
  useEffect(() => {
    if (joinRateLimitedSec == null || joinRateLimitedSec <= 0) return;
    const t = setTimeout(() => {
      setJoinRateLimitedSec((v) => (v != null && v > 1 ? v - 1 : null));
    }, 1000);
    return () => clearTimeout(t);
  }, [joinRateLimitedSec]);

  const acknowledgeContinue = useCallback(() => setContinueAcked(true), []);

  return {
    queueStatus,
    queueConfig,
    queueReady,
    queueEnabled,
    hasControl,
    isActiveController,
    joining,
    joinError,
    joinRateLimitedSec,
    join,
    acknowledgeContinue,
  };
}

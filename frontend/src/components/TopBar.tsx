import { Activity, HelpCircle, MessageSquare } from 'lucide-react';
import { useState } from 'react';

import { track } from '../analytics';
import { BRAND } from '../branding';
import { formatSeconds } from '../lib/formatters';
import { startTour } from '../tour';
import type { QueueStatus } from '../queue';
import type { RoboClawTelemetry } from '../types';
import { FeedbackDialog } from './FeedbackDialog';

function LeaseChip({ status }: { status: QueueStatus }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const remaining = Math.max(0, Math.round(status.lease_remaining_s ?? 0));
  const idle = status.idle_remaining_s == null ? null : Math.max(0, Math.round(status.idle_remaining_s));
  return (
    <button
      type="button"
      className={`topbar-lease${detailOpen ? ' topbar-lease-open' : ''}`}
      aria-label="Session time limit explanation"
      aria-expanded={detailOpen}
      aria-describedby="session-limit-popover"
      onClick={() => setDetailOpen((open) => !open)}
      onBlur={() => setDetailOpen(false)}
    >
      <Activity size={12} />
      <span className="topbar-lease-label">Session</span>
      <strong>{formatSeconds(remaining)}</strong>
      {idle != null && idle < 30 && (
        <span className="topbar-lease-idle">· idle {idle}s</span>
      )}
      <span id="session-limit-popover" className="topbar-lease-popover" role="tooltip">
        <strong>Why sessions are timed</strong>
        <span>
          This demo is limited to give everyone an opportunity to use it.
          When your timer ends, control passes to the next visitor.
        </span>
      </span>
    </button>
  );
}

export function TopBar({
  telemetry,
  leaseStatus,
}: {
  telemetry: RoboClawTelemetry | null;
  leaseStatus: QueueStatus | null;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  return (
    <>
      <header className="topbar">
        <a className="topbar-brand" href={BRAND.homepage} target="_blank" rel="noreferrer">
          <img src={BRAND.logoUrl} alt={BRAND.name} className="brand-logo" />
        </a>
        <div className="topbar-status">
          {leaseStatus && <LeaseChip status={leaseStatus} />}
          <button
            type="button"
            className="topbar-feedback"
            onClick={() => { track('feedback_opened'); setFeedbackOpen(true); }}
            title="Share feedback about the telescope experience"
          >
            <MessageSquare size={14} /> Feedback
          </button>
          <button
            type="button"
            className="topbar-help"
            onClick={() => { track('tour_button_clicked'); startTour('button'); }}
            title="Take a guided tour of the controls"
          >
            <HelpCircle size={14} /> Tour
          </button>
          <span className="topbar-time" title="Time at the telescope (EST)">
            <span className="topbar-time-label">Telescope time</span>
            {telemetry
              ? `${new Date(telemetry.timestamp * 1000).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false })} EST`
              : '—'}
          </span>
        </div>
      </header>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </>
  );
}

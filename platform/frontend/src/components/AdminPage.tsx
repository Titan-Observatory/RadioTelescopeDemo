// LAN-admin control panel. The backend gates every /api/admin/* route with
// require_lan_admin → 404 for non-LAN clients, so this page silently fails to
// load data when accessed from off-LAN. The /ws/roboclaw bridge and live
// hardware reads also accept LAN admins now, so the embedded SkyMap and
// telemetry dashboard work without going through the queue.

import { Maximize2, Minimize2, Navigation } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api';
import { BRAND } from '../branding';
import { useBackendCatalog } from '../lib/useBackendCatalog';
import { useErrorTracking } from '../lib/useErrorTracking';
import { useFullscreen } from '../lib/useFullscreen';
import { useLna } from '../lib/useLna';
import { useMapTarget } from '../lib/useMapTarget';
import { useMotionCommands } from '../lib/useMotionCommands';
import { useSlewTargetArrivalClear } from '../lib/useSlewTargetArrivalClear';
import { useTelemetry } from '../lib/useTelemetry';
import type {
  PidBundle,
  PositionPid,
  QueueSnapshot,
  SpectrumProcessing,
  SpectrumProcessingUpdate,
  TelescopeState,
  TelescopeStatus,
  VelocityPid,
} from '../types';

import { MotionControls } from './MotionControls';
import { SkyMap } from './SkyMap';
import { SpectrumPanel } from './SpectrumPanel';
import { TelemetryDashboard } from './TelemetryDashboard';

type StatusBlock = { kind: 'ok' | 'err'; msg: string } | null;

export function AdminPage() {
  const { trackErrorOnce } = useErrorTracking();
  const { telemetry, setTelemetry } = useTelemetry({ enabled: true, onError: trackErrorOnce });
  const { lnaStatus } = useLna(true);
  const { commands, telescopeConfig } = useBackendCatalog({ enabled: true, onError: trackErrorOnce });
  const map = useMapTarget();
  const motion = useMotionCommands(commands, setTelemetry);
  const trackSubmittedSlewTarget = useSlewTargetArrivalClear({
    hasMapTarget: map.hasMapTarget,
    targetAlt: map.targetAlt,
    targetAz: map.targetAz,
    telemetry,
    clearTarget: map.clearTarget,
  });

  // Stable identity so the sky-map pin overlay isn't redrawn on every telemetry tick.
  const pendingTarget = useMemo(
    () => (map.hasMapTarget && map.targetRaDeg != null && map.targetDecDeg != null
      ? { ra_deg: map.targetRaDeg, dec_deg: map.targetDecDeg }
      : null),
    [map.hasMapTarget, map.targetRaDeg, map.targetDecDeg],
  );

  const skymapPanelRef = useRef<HTMLElement>(null);
  const { isFullscreen, toggle: toggleFullscreen } = useFullscreen(skymapPanelRef);

  // Spectrum is opt-in: the SDR + GNU Radio subprocess on the Pi runs hot, and
  // the SpectrumService closes 5s after the last subscriber disconnects.
  // Persist the choice across reloads so a tab refresh doesn't wake the SDR.
  const [spectrumEnabled, setSpectrumEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('admin.spectrumEnabled') === '1';
  });
  useEffect(() => {
    window.localStorage.setItem('admin.spectrumEnabled', spectrumEnabled ? '1' : '0');
  }, [spectrumEnabled]);

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-topbar-title">
          <span className="admin-topbar-brand">{BRAND.name}</span>
          <span className="admin-topbar-sep">·</span>
          <span>Operator control panel</span>
        </div>
        <a className="admin-topbar-link" href="/">Back to live view →</a>
      </header>

      <p className="admin-banner-note">
        LAN-only operator surface. All status changes, kicks, and PID writes are appended to <code>motion.jsonl</code>.
      </p>

      <section className="admin-live-row">
        <section className="panel skymap-panel admin-skymap" ref={skymapPanelRef}>
          <SkyMap
            telemetry={telemetry}
            config={telescopeConfig}
            onNotice={() => { /* errors suppressed */ }}
            onTarget={map.setTarget}
            onClearTarget={map.clearTarget}
            pendingTarget={pendingTarget}
            tooltipsEnabled={true}
            toolbarLeading={(
              <button
                type="button"
                className="skymap-fullscreen-btn"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
                aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
                title={isFullscreen ? 'Exit full screen' : 'Full screen'}
              >
                {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}
          />
          <div className="skymap-bottom-dock">
            <div className="skymap-overlay-controls">
              <MotionControls
                jog={motion.jog}
                stopJog={motion.stopJog}
                onPickTarget={(raDeg, decDeg) => {
                  if (telescopeConfig) map.setTargetFromRaDec(raDeg, decDeg, telescopeConfig);
                }}
                onStop={motion.stopMotion}
                targetRaDeg={map.targetRaDeg}
                targetDecDeg={map.targetDecDeg}
              />
            </div>
            {map.hasMapTarget && (
              <button
                type="button"
                className="skymap-slew-target"
                onClick={() => {
                  trackSubmittedSlewTarget(map.targetAlt, map.targetAz);
                  void motion.gotoAltAz(map.targetAlt, map.targetAz);
                }}
                title={`Slew to Az ${map.targetAz.toFixed(3)}°, Alt ${map.targetAlt.toFixed(3)}°`}
              >
                <Navigation size={15} />
                <span>Slew</span>
              </button>
            )}
          </div>
        </section>
        <section className="panel admin-telemetry-panel">
          <TelemetryDashboard telemetry={telemetry} config={telescopeConfig} lnaStatus={lnaStatus} />
        </section>
      </section>

      <section className="panel admin-card admin-spectrum-card">
        <header className="admin-card-header">
          <h2>SDR spectrum</h2>
          <label className="admin-toggle">
            <input
              type="checkbox"
              checked={spectrumEnabled}
              onChange={(e) => setSpectrumEnabled(e.target.checked)}
            />
            <span className="admin-toggle-track" aria-hidden="true">
              <span className="admin-toggle-thumb" />
            </span>
            <span className="admin-toggle-label">{spectrumEnabled ? 'Running' : 'Off'}</span>
          </label>
        </header>
        <p className="admin-card-sub">
          Powers up the Airspy + GNU Radio flowgraph on the Pi. Spectrum stops within
          ~5&nbsp;s of toggling off, idling the SDR back down.
        </p>
        {spectrumEnabled ? (
          <>
            <div className="admin-spectrum-host">
              <SpectrumPanel enabled={true} />
            </div>
            <SpectrumTuningPanel />
          </>
        ) : (
          <p className="admin-spectrum-placeholder">
            SDR is idle. Toggle on to start the flowgraph.
          </p>
        )}
      </section>

      <div className="admin-grid">
        <StatusCard />
        <QueueCard />
      </div>
      <PidCard />
    </div>
  );
}

// ─── Telescope status ────────────────────────────────────────────────────────

function StatusCard() {
  const [status, setStatus] = useState<TelescopeStatus | null>(null);
  const [state, setState] = useState<TelescopeState>('operational');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<StatusBlock>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.adminGetStatus();
      setStatus(next);
      setState(next.state);
      setMessage(next.message ?? '');
    } catch (err) {
      setHint({ kind: 'err', msg: `Load failed: ${(err as Error).message}` });
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const onSave = async () => {
    setSaving(true);
    setHint(null);
    try {
      const next = await api.adminSetStatus(state, message.trim() || null);
      setStatus(next);
      setHint({ kind: 'ok', msg: `Saved at ${next.updated_at}` });
    } catch (err) {
      setHint({ kind: 'err', msg: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel admin-card">
      <header className="admin-card-header">
        <h2>Telescope status</h2>
        <span className={`admin-state-pill admin-state-${status?.state ?? 'operational'}`}>
          {status?.state ?? '…'}
        </span>
      </header>
      <p className="admin-card-sub">
        Anything other than <code>operational</code> blocks new queue joins.
        Existing sessions are not evicted.
      </p>
      <div className="admin-radio-group">
        {(['operational', 'maintenance', 'closed'] as TelescopeState[]).map((s) => (
          <label key={s} className={`admin-radio admin-radio-${s}${state === s ? ' is-active' : ''}`}>
            <input type="radio" name="state" checked={state === s} onChange={() => setState(s)} />
            <span>{s}</span>
          </label>
        ))}
      </div>
      <label className="admin-field">
        <span className="admin-field-label">Message (shown in queue banner)</span>
        <textarea
          rows={2}
          maxLength={500}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="e.g. Cleaning the dish — back online around 18:00"
        />
      </label>
      <div className="admin-actions-row">
        <button className="admin-btn admin-btn-primary" onClick={() => void onSave()} disabled={saving}>
          {saving ? 'Saving…' : 'Save status'}
        </button>
        {status?.updated_at && (
          <span className="admin-meta">Updated {status.updated_at}</span>
        )}
      </div>
      <Hint hint={hint} />
    </section>
  );
}

// ─── Queue ───────────────────────────────────────────────────────────────────

function QueueCard() {
  const [snap, setSnap] = useState<QueueSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSnap(await api.adminGetQueue());
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 2000);
    return () => clearInterval(t);
  }, [reload]);

  const onKick = async (token: string) => {
    if (!confirm(`Kick session ${token.slice(0, 8)}… ?`)) return;
    try {
      await api.adminKick(token);
      void reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const lease = snap?.active_lease_remaining_s;
  const idle = snap?.active_idle_remaining_s;

  return (
    <section className="panel admin-card">
      <header className="admin-card-header">
        <h2>Queue</h2>
        <span className="admin-meta">
          {snap ? `${snap.sessions.length} session${snap.sessions.length === 1 ? '' : 's'}` : '…'}
        </span>
      </header>
      {err && <Hint hint={{ kind: 'err', msg: err }} />}
      {!snap || snap.sessions.length === 0 ? (
        <p className="admin-card-sub">No sessions in the queue.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Pos</th>
                <th>Token</th>
                <th>IP hash</th>
                <th>Age</th>
                <th>WS</th>
                <th aria-label="kick" />
              </tr>
            </thead>
            <tbody>
              {snap.sessions.map((s) => (
                <tr key={s.token} className={s.is_active ? 'is-active' : undefined}>
                  <td>{s.is_active ? <span className="admin-active-tag">ACTIVE</span> : `#${s.queue_position}`}</td>
                  <td><code>{s.token.slice(0, 12)}…</code></td>
                  <td><code>{s.ip_hash}</code></td>
                  <td>{Math.round(s.age_s)}s</td>
                  <td>{s.ws_connected ? '✓' : '✗'}</td>
                  <td>
                    <button className="admin-btn admin-btn-danger admin-btn-small" onClick={() => void onKick(s.token)}>
                      Kick
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(lease != null || idle != null) && (
        <p className="admin-meta">
          {lease != null && <>Lease: <strong>{Math.round(lease)}s</strong> left</>}
          {lease != null && idle != null && ' · '}
          {idle != null && <>idle in <strong>{Math.round(idle)}s</strong></>}
        </p>
      )}
    </section>
  );
}

// ─── PID ─────────────────────────────────────────────────────────────────────

function PidCard() {
  const [loaded, setLoaded] = useState<PidBundle | null>(null);
  const [draft, setDraft] = useState<PidBundle | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<StatusBlock>(null);

  const onLoad = async () => {
    setBusy(true);
    setHint(null);
    try {
      const next = await api.adminReadPid();
      setLoaded(next);
      setDraft(JSON.parse(JSON.stringify(next)) as PidBundle);
      setHint({ kind: 'ok', msg: 'Loaded current PID values from controller.' });
    } catch (e) {
      setHint({ kind: 'err', msg: `Read failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onWrite = async () => {
    if (!draft) return;
    if (!confirm('Write these PID values to the controller? Bad values can prevent the motors from moving correctly.')) return;
    setBusy(true);
    setHint(null);
    try {
      const next = await api.adminWritePid(draft);
      setLoaded(next);
      setDraft(JSON.parse(JSON.stringify(next)) as PidBundle);
      setHint({ kind: 'ok', msg: 'Wrote PID values. They reset on power cycle unless you save to NVM.' });
    } catch (e) {
      setHint({ kind: 'err', msg: `Write failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onSaveNvm = async () => {
    if (!confirm('Persist all controller settings to EEPROM? This survives power cycles.')) return;
    setBusy(true);
    setHint(null);
    try {
      const r = await api.adminSavePidNvm();
      setHint({ kind: 'ok', msg: r.message });
    } catch (e) {
      setHint({ kind: 'err', msg: `NVM save failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!draft && !!loaded && JSON.stringify(draft) !== JSON.stringify(loaded);

  return (
    <section className="panel admin-card">
      <header className="admin-card-header">
        <h2>RoboClaw PID tuning</h2>
        {dirty && <span className="admin-state-pill admin-state-dirty">unsaved edits</span>}
      </header>
      <p className="admin-card-sub">
        Reads/writes the four PID parameter sets (velocity M1/M2, position M1/M2) over serial.
        Save to NVM (EEPROM) so values survive a power cycle.
      </p>
      <div className="admin-actions-row">
        <button className="admin-btn admin-btn-primary" onClick={() => void onLoad()} disabled={busy}>
          Load from controller
        </button>
        <button className="admin-btn admin-btn-primary" onClick={() => void onWrite()} disabled={busy || !draft || !dirty}>
          Write to controller
        </button>
        <button className="admin-btn admin-btn-danger" onClick={() => void onSaveNvm()} disabled={busy}>
          Save to NVM
        </button>
      </div>
      <Hint hint={hint} />
      {draft && loaded ? (
        <div className="admin-pid-grid">
          <VelCard title="Velocity M1 (azimuth)" loaded={loaded.vel_m1} value={draft.vel_m1}
            onChange={(v) => setDraft({ ...draft, vel_m1: v })} />
          <VelCard title="Velocity M2 (elevation)" loaded={loaded.vel_m2} value={draft.vel_m2}
            onChange={(v) => setDraft({ ...draft, vel_m2: v })} />
          <PosCard title="Position M1 (azimuth)" loaded={loaded.pos_m1} value={draft.pos_m1}
            onChange={(v) => setDraft({ ...draft, pos_m1: v })} />
          <PosCard title="Position M2 (elevation)" loaded={loaded.pos_m2} value={draft.pos_m2}
            onChange={(v) => setDraft({ ...draft, pos_m2: v })} />
        </div>
      ) : (
        <p className="admin-card-sub admin-pid-empty">
          Press <strong>Load from controller</strong> to read the current PID values from the RoboClaw.
        </p>
      )}
    </section>
  );
}

function VelCard({
  title, value, loaded, onChange,
}: { title: string; value: VelocityPid; loaded: VelocityPid; onChange: (v: VelocityPid) => void }) {
  return (
    <div className="admin-pid-card">
      <h3>{title}</h3>
      {(['p', 'i', 'd', 'qpps'] as (keyof VelocityPid)[]).map((k) => (
        <NumberRow key={k} label={k.toUpperCase()} value={value[k]} loaded={loaded[k]}
          onChange={(n) => onChange({ ...value, [k]: n })} />
      ))}
    </div>
  );
}

function PosCard({
  title, value, loaded, onChange,
}: { title: string; value: PositionPid; loaded: PositionPid; onChange: (v: PositionPid) => void }) {
  return (
    <div className="admin-pid-card">
      <h3>{title}</h3>
      {(['p', 'i', 'd', 'i_max', 'deadzone', 'min', 'max'] as (keyof PositionPid)[]).map((k) => (
        <NumberRow key={k} label={k} value={value[k]} loaded={loaded[k]} signed={k === 'min' || k === 'max'}
          onChange={(n) => onChange({ ...value, [k]: n })} />
      ))}
    </div>
  );
}

function NumberRow({
  label, value, loaded, signed = false, onChange,
}: { label: string; value: number; loaded: number; signed?: boolean; onChange: (n: number) => void }) {
  const dirty = value !== loaded;
  return (
    <div className={`admin-pid-row${dirty ? ' is-dirty' : ''}`}>
      <span className="admin-pid-row-label">{label}</span>
      <input
        type="number"
        step={1}
        min={signed ? -2147483648 : 0}
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
      />
      <span className="admin-pid-row-was">was {loaded}</span>
    </div>
  );
}

// ─── Spectrum tuning ─────────────────────────────────────────────────────────

function SpectrumTuningPanel() {
  const [server, setServer] = useState<SpectrumProcessing | null>(null);
  const [draft, setDraft] = useState<SpectrumProcessing | null>(null);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<StatusBlock>(null);

  const reload = useCallback(async () => {
    try {
      const next = await api.adminGetSpectrumProcessing();
      setServer(next);
      setDraft(next);
      setHint(null);
    } catch (e) {
      setHint({ kind: 'err', msg: `Load failed: ${(e as Error).message}` });
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const apply = useCallback(async (patch: SpectrumProcessingUpdate, debounceMs = 0) => {
    setBusy(true);
    try {
      const next = await api.adminSetSpectrumProcessing(patch);
      setServer(next);
      setDraft((d) => (d ? { ...d, ...next } : next));
      if (next.restarted) {
        setHint({ kind: 'ok', msg: 'Applied · GNU Radio flowgraph restarted' });
      } else {
        setHint({ kind: 'ok', msg: 'Applied live' });
      }
    } catch (e) {
      setHint({ kind: 'err', msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
    // debounceMs unused — slider throttling is handled via commit-on-release below.
    void debounceMs;
  }, []);

  if (!draft || !server) {
    return <p className="admin-card-sub admin-spectrum-placeholder">Loading processing knobs…</p>;
  }

  // Every knob is a flowgraph-build parameter now, so they're all staged and
  // applied together via the batch button (one flowgraph bounce, not one per
  // slider drag).
  const subprocessDirty =
    Math.abs(draft.integration_seconds - server.integration_seconds) > 1e-6 ||
    Math.abs(draft.baseline_scale - server.baseline_scale) > 1e-6 ||
    Math.abs(draft.baseline_offset_db - server.baseline_offset_db) > 1e-6 ||
    draft.gain_db !== server.gain_db ||
    draft.agc !== server.agc ||
    Math.abs(draft.center_freq_mhz - server.center_freq_mhz) > 1e-6 ||
    Math.abs(draft.sample_rate_msps - server.sample_rate_msps) > 1e-6 ||
    draft.fft_size !== server.fft_size ||
    Math.abs(draft.publish_rate_hz - server.publish_rate_hz) > 1e-6;

  // Changing the FFT layout clears the captured baseline; warn only then.
  const axisDirty =
    Math.abs(draft.center_freq_mhz - server.center_freq_mhz) > 1e-6 ||
    Math.abs(draft.sample_rate_msps - server.sample_rate_msps) > 1e-6 ||
    draft.fft_size !== server.fft_size;

  const applySubprocess = () => {
    const patch: SpectrumProcessingUpdate = {};
    if (Math.abs(draft.integration_seconds - server.integration_seconds) > 1e-6)
      patch.integration_seconds = draft.integration_seconds;
    if (Math.abs(draft.baseline_scale - server.baseline_scale) > 1e-6)
      patch.baseline_scale = draft.baseline_scale;
    if (Math.abs(draft.baseline_offset_db - server.baseline_offset_db) > 1e-6)
      patch.baseline_offset_db = draft.baseline_offset_db;
    if (draft.agc !== server.agc || draft.gain_db !== server.gain_db) {
      if (draft.agc) patch.agc = true;
      else patch.gain_db = draft.gain_db ?? 0;
    }
    if (Math.abs(draft.center_freq_mhz - server.center_freq_mhz) > 1e-6)
      patch.center_freq_mhz = draft.center_freq_mhz;
    if (Math.abs(draft.sample_rate_msps - server.sample_rate_msps) > 1e-6)
      patch.sample_rate_msps = draft.sample_rate_msps;
    if (draft.fft_size !== server.fft_size)
      patch.fft_size = draft.fft_size;
    if (Math.abs(draft.publish_rate_hz - server.publish_rate_hz) > 1e-6)
      patch.publish_rate_hz = draft.publish_rate_hz;
    const warning = axisDirty
      ? 'Apply changes? This will bounce the GNU Radio flowgraph and clear any captured baseline.'
      : 'Apply changes? This will bounce the GNU Radio flowgraph.';
    if (!confirm(warning)) return;
    void apply(patch);
  };

  return (
    <div className="admin-tuning">
      <div className="admin-tuning-section">
        <div className="admin-tuning-section-head">
          <h3>Processing &amp; SDR (requires flowgraph restart)</h3>
          {subprocessDirty && <span className="admin-state-pill admin-state-dirty">staged</span>}
        </div>

        <SliderRow
          label="EMA integration"
          unit="s"
          min={0.5} max={60} step={0.5}
          value={draft.integration_seconds}
          onDraft={(v) => setDraft({ ...draft, integration_seconds: v })}
          onCommit={() => { /* staged — commit via Apply */ }}
          hint={`${server.integration_frames} published frames`}
          disabled={busy}
        />
        <SliderRow
          label="Baseline scale"
          unit="×"
          min={0.5} max={2.0} step={0.005}
          value={draft.baseline_scale}
          onDraft={(v) => setDraft({ ...draft, baseline_scale: v })}
          onCommit={() => { /* staged — commit via Apply */ }}
          hint="Multiplier on the stored baseline before division"
          disabled={busy}
        />
        <SliderRow
          label="Baseline offset"
          unit="dB"
          min={-10} max={10} step={0.1}
          value={draft.baseline_offset_db}
          onDraft={(v) => setDraft({ ...draft, baseline_offset_db: v })}
          onCommit={() => { /* staged — commit via Apply */ }}
          hint="Additive dB shift on the displayed spectrum"
          disabled={busy}
        />

        <div className="admin-tuning-row">
          <span className="admin-tuning-label">Gain</span>
          <div className="admin-tuning-pills">
            <button
              className={`admin-pill${draft.agc ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => setDraft({ ...draft, agc: true })}
            >AGC</button>
            <button
              className={`admin-pill${!draft.agc ? ' is-active' : ''}`}
              disabled={busy}
              onClick={() => setDraft({ ...draft, agc: false, gain_db: draft.gain_db ?? 14 })}
            >Manual</button>
          </div>
        </div>
        {!draft.agc && (
          <SliderRow
            label="Gain index"
            unit=""
            min={0} max={21} step={1}
            value={draft.gain_db ?? 14}
            onDraft={(v) => setDraft({ ...draft, gain_db: v })}
            onCommit={() => { /* staged — commit via Apply */ }}
            hint="Airspy linearity index 0–21 (higher = more gain + more noise)"
            disabled={busy}
          />
        )}

        <NumberField
          label="Centre frequency"
          unit="MHz"
          step={0.001}
          value={draft.center_freq_mhz}
          onChange={(v) => setDraft({ ...draft, center_freq_mhz: v })}
          disabled={busy}
        />
        <div className="admin-tuning-row">
          <span className="admin-tuning-label">Sample rate</span>
          <div className="admin-tuning-pills">
            {[3, 6].map((r) => (
              <button
                key={r}
                className={`admin-pill${Math.abs(draft.sample_rate_msps - r) < 1e-6 ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => setDraft({ ...draft, sample_rate_msps: r })}
              >{r} Msps</button>
            ))}
          </div>
        </div>
        <div className="admin-tuning-row">
          <span className="admin-tuning-label">FFT size</span>
          <div className="admin-tuning-pills">
            {[2048, 4096, 8192, 16384].map((n) => (
              <button
                key={n}
                className={`admin-pill${draft.fft_size === n ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => setDraft({ ...draft, fft_size: n })}
              >{n}</button>
            ))}
          </div>
        </div>
        <NumberField
          label="Publish rate"
          unit="Hz"
          step={0.5}
          value={draft.publish_rate_hz}
          onChange={(v) => setDraft({ ...draft, publish_rate_hz: v })}
          disabled={busy}
        />

        <div className="admin-actions-row">
          <button
            className="admin-btn admin-btn-primary"
            disabled={busy || !subprocessDirty}
            onClick={applySubprocess}
          >Apply &amp; restart flowgraph</button>
          <button
            className="admin-btn"
            disabled={busy || !subprocessDirty}
            onClick={() => setDraft(server)}
          >Revert</button>
          <span className="admin-meta">
            {server.integration_frames} EMA frames · {(server.freq_resolution_hz / 1000).toFixed(2)} kHz/bin
          </span>
        </div>
      </div>
      <Hint hint={hint} />
    </div>
  );
}

function SliderRow({
  label, unit, min, max, step, value, hint, disabled,
  onDraft, onCommit,
}: {
  label: string;
  unit: string;
  min: number; max: number; step: number;
  value: number;
  hint?: string;
  disabled?: boolean;
  onDraft: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <div className="admin-slider-row">
      <div className="admin-slider-row-head">
        <span className="admin-tuning-label">{label}</span>
        <span className="admin-slider-value">{formatNumber(value)} {unit}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onDraft(Number(e.target.value))}
        onMouseUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
      />
      {hint && <span className="admin-slider-hint">{hint}</span>}
    </div>
  );
}

function NumberField({
  label, unit, step, value, onChange, disabled,
}: {
  label: string;
  unit: string;
  step: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="admin-tuning-row">
      <span className="admin-tuning-label">{label}</span>
      <div className="admin-tuning-numfield">
        <input
          type="number"
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
        />
        <span>{unit}</span>
      </div>
    </div>
  );
}

function formatNumber(v: number): string {
  if (Math.abs(v) >= 100) return v.toFixed(1);
  if (Math.abs(v) >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

// ─── shared bits ─────────────────────────────────────────────────────────────

function Hint({ hint }: { hint: StatusBlock }) {
  if (!hint) return null;
  return <p className={`admin-hint admin-hint-${hint.kind}`}>{hint.msg}</p>;
}

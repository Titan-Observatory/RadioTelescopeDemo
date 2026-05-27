// LAN-admin control panel. The backend gates every /api/admin/* route with
// require_lan_admin → 404 for non-LAN clients, so this page silently fails to
// load data when accessed from off-LAN. Deliberately ugly + utilitarian so it
// can be lifted into its own repo later without much shared chrome to untangle.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type {
  PidBundle,
  PositionPid,
  QueueSnapshot,
  TelescopeState,
  TelescopeStatus,
  VelocityPid,
} from '../types';

type StatusBlock = { kind: 'ok' | 'err'; msg: string } | null;

export function AdminPage() {
  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={{ margin: 0 }}>Admin · Telescope control panel</h1>
        <p style={{ margin: '6px 0 0 0', opacity: 0.7, fontSize: 13 }}>
          LAN-only operator surface. All actions are logged to motion.jsonl.
        </p>
      </header>
      <StatusSection />
      <QueueSection />
      <PidSection />
    </div>
  );
}

// ─── Telescope status ────────────────────────────────────────────────────────

function StatusSection() {
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
    <section style={cardStyle}>
      <h2 style={h2Style}>Telescope status</h2>
      <p style={subStyle}>
        Setting state to anything other than <code>operational</code> blocks new
        queue joins. Existing sessions are not evicted.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(['operational', 'maintenance', 'closed'] as TelescopeState[]).map((s) => (
          <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="radio" name="state" checked={state === s} onChange={() => setState(s)} />
            <span style={{ textTransform: 'capitalize' }}>{s}</span>
          </label>
        ))}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={labelStyle}>Message (shown in queue banner)</span>
          <textarea
            rows={3}
            maxLength={500}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. Cleaning the dish — back online around 18:00"
            style={textareaStyle}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button style={btnPrimary} onClick={() => void onSave()} disabled={saving}>
            {saving ? 'Saving…' : 'Save status'}
          </button>
          {status && (
            <span style={subStyle}>
              Current: <strong>{status.state}</strong>
              {status.updated_at && ` (updated ${status.updated_at})`}
            </span>
          )}
        </div>
        {hint && <Hint hint={hint} />}
      </div>
    </section>
  );
}

// ─── Queue ───────────────────────────────────────────────────────────────────

function QueueSection() {
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

  return (
    <section style={cardStyle}>
      <h2 style={h2Style}>Queue (live)</h2>
      {err && <Hint hint={{ kind: 'err', msg: err }} />}
      {!snap || snap.sessions.length === 0 ? (
        <p style={subStyle}>No sessions in the queue.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Pos</th>
              <th style={thStyle}>Token</th>
              <th style={thStyle}>IP hash</th>
              <th style={thStyle}>Age</th>
              <th style={thStyle}>WS</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {snap.sessions.map((s) => (
              <tr key={s.token} style={s.is_active ? { background: 'rgba(80,160,80,0.18)' } : undefined}>
                <td style={tdStyle}>{s.is_active ? 'ACTIVE' : `#${s.queue_position}`}</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{s.token.slice(0, 12)}…</td>
                <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{s.ip_hash}</td>
                <td style={tdStyle}>{Math.round(s.age_s)}s</td>
                <td style={tdStyle}>{s.ws_connected ? '✓' : '✗'}</td>
                <td style={tdStyle}>
                  <button style={btnDanger} onClick={() => void onKick(s.token)}>Kick</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {snap?.active_lease_remaining_s != null && (
        <p style={subStyle}>
          Active lease: {Math.round(snap.active_lease_remaining_s)}s left
          {snap.active_idle_remaining_s != null && ` · idle in ${Math.round(snap.active_idle_remaining_s)}s`}
        </p>
      )}
    </section>
  );
}

// ─── PID ─────────────────────────────────────────────────────────────────────

function PidSection() {
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
      setHint({ kind: 'ok', msg: 'Loaded current PID values from controller' });
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
      setHint({ kind: 'ok', msg: 'Wrote PID values. They will reset on power cycle unless you save to NVM.' });
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

  return (
    <section style={cardStyle}>
      <h2 style={h2Style}>RoboClaw PID tuning</h2>
      <p style={subStyle}>
        Reads/writes the four PID parameter sets (velocity M1/M2, position M1/M2)
        over serial. Save to NVM (EEPROM) so values survive a power cycle.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button style={btnPrimary} onClick={() => void onLoad()} disabled={busy}>
          Load from controller
        </button>
        <button style={btnPrimary} onClick={() => void onWrite()} disabled={busy || !draft}>
          Write to controller
        </button>
        <button style={btnDanger} onClick={() => void onSaveNvm()} disabled={busy}>
          Save to NVM
        </button>
      </div>
      {hint && <Hint hint={hint} />}
      {draft && loaded && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
          <VelCard title="Velocity M1 (azimuth)" loaded={loaded.vel_m1} value={draft.vel_m1}
            onChange={(v) => setDraft({ ...draft, vel_m1: v })} />
          <VelCard title="Velocity M2 (elevation)" loaded={loaded.vel_m2} value={draft.vel_m2}
            onChange={(v) => setDraft({ ...draft, vel_m2: v })} />
          <PosCard title="Position M1 (azimuth)" loaded={loaded.pos_m1} value={draft.pos_m1}
            onChange={(v) => setDraft({ ...draft, pos_m1: v })} />
          <PosCard title="Position M2 (elevation)" loaded={loaded.pos_m2} value={draft.pos_m2}
            onChange={(v) => setDraft({ ...draft, pos_m2: v })} />
        </div>
      )}
    </section>
  );
}

function VelCard({
  title, value, loaded, onChange,
}: { title: string; value: VelocityPid; loaded: VelocityPid; onChange: (v: VelocityPid) => void }) {
  return (
    <div style={pidCardStyle}>
      <h3 style={h3Style}>{title}</h3>
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
    <div style={pidCardStyle}>
      <h3 style={h3Style}>{title}</h3>
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
    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 120px', alignItems: 'center', gap: 8, marginBottom: 4 }}>
      <span style={labelStyle}>{label}</span>
      <input
        type="number"
        step={1}
        min={signed ? -2147483648 : 0}
        value={value}
        onChange={(e) => onChange(Math.round(Number(e.target.value) || 0))}
        style={{ ...inputStyle, borderColor: dirty ? '#ffaa3c' : '#444' }}
      />
      <span style={{ ...subStyle, fontFamily: 'monospace', fontSize: 11 }}>was: {loaded}</span>
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────

function Hint({ hint }: { hint: NonNullable<StatusBlock> }) {
  const color = hint.kind === 'ok' ? '#a4f0a4' : '#ffb0b0';
  return <p style={{ ...subStyle, color }}>{hint.msg}</p>;
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1100,
  margin: '0 auto',
  padding: '32px 24px 64px',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  color: '#e6e6e6',
  background: '#111',
  minHeight: '100vh',
};
const headerStyle: React.CSSProperties = { marginBottom: 24 };
const cardStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #2c2c2c',
  borderRadius: 8,
  padding: 20,
  marginBottom: 20,
};
const pidCardStyle: React.CSSProperties = {
  background: '#222',
  border: '1px solid #333',
  borderRadius: 6,
  padding: 12,
};
const h2Style: React.CSSProperties = { margin: '0 0 8px 0', fontSize: 18 };
const h3Style: React.CSSProperties = { margin: '0 0 8px 0', fontSize: 14 };
const subStyle: React.CSSProperties = { fontSize: 12, opacity: 0.75, margin: '4px 0' };
const labelStyle: React.CSSProperties = { fontSize: 12, opacity: 0.85 };
const inputStyle: React.CSSProperties = {
  background: '#111',
  color: '#e6e6e6',
  border: '1px solid #444',
  borderRadius: 4,
  padding: '4px 8px',
  fontFamily: 'monospace',
};
const textareaStyle: React.CSSProperties = { ...inputStyle, padding: 8, fontFamily: 'inherit', resize: 'vertical' };
const btnPrimary: React.CSSProperties = {
  background: '#2c5fa0',
  color: 'white',
  border: 'none',
  padding: '8px 14px',
  borderRadius: 4,
  cursor: 'pointer',
};
const btnDanger: React.CSSProperties = { ...btnPrimary, background: '#a02c2c' };
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #333', opacity: 0.7 };
const tdStyle: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #222' };

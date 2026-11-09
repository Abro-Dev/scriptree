import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { PageTop } from '../../components/Shell';
import { ChartLegend, ReconChart, Ring } from '../../components/officer';
import { Pill, useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp, sessionPill, type SessionSummary } from '../../lib/officer';
import { fetchAlerts, fetchStats, fetchSummaries } from '../../lib/queries';

interface AuditRow { id: number; at: string; actor_name: string; action: string; detail: string; hash: string }
interface Chain { ok: boolean; entries: number; broken_at: number | null }
type Filter = 'all' | 'issues' | 'live' | 'ok';

const FILTERS: [Filter, string][] = [['all', 'All'], ['issues', 'Open issues'], ['live', 'Live'], ['ok', 'Reconciled']];

/** Open issues on a closed session: unresolved candidates plus a headcount mismatch. */
const issues = (s: SessionSummary) => (s.status === 'closed' ? s.open_issues + (s.hc_mismatch ? 1 : 0) : 0);

/** Read-only system overview for admins. Every figure comes from the same RPCs the officer dashboard uses. */
export function Overview() {
  const nav = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [chain, setChain] = useState<Chain | null>(null);
  const [checking, setChecking] = useState(false);

  const { data, error } = useLoad(async () => {
    const [sessions, alerts, stats, audit] = await Promise.all([
      fetchSummaries(), fetchAlerts(), fetchStats(),
      supabase.from('audit_log').select('id, at, actor_name, action, detail, hash').order('id', { ascending: false }).limit(6).then((r) => must(r) as AuditRow[]),
    ]);
    return { sessions, alerts, stats, audit };
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.sessions.filter((s) => {
      const f = filter === 'all' || (filter === 'issues' && issues(s) > 0) || (filter === 'live' && s.status === 'live')
        || (filter === 'ok' && s.status === 'closed' && issues(s) === 0);
      const text = `${s.course_code} ${s.course_title} ${s.venue} ${s.invigilator_name ?? ''}`.toLowerCase();
      return f && (!needle || text.includes(needle));
    });
  }, [data, filter, q]);

  async function verifyChain() {
    setChecking(true);
    const { data: r, error: e } = await supabase.rpc('verify_audit_chain').single<Chain>();
    setChecking(false);
    if (e) { toast(errText(e)); return; }
    setChain(r);
  }

  const sub = 'System health across sessions, scripts and records';
  if (error) return <><PageTop title="Overview" /><div className="content"><div className="banner crit">{error}</div></div></>;
  if (!data) return <><PageTop title="Overview" sub={sub} /><div className="content muted">Loading…</div></>;

  const { sessions, alerts, stats, audit } = data;
  const closed = sessions.filter((s) => s.status === 'closed');
  const present = closed.reduce((a, s) => a + s.present, 0), complete = closed.reduce((a, s) => a + s.complete, 0);
  const reconPct = present ? Math.round((complete / present) * 1000) / 10 : 100;
  const openD = closed.reduce((a, s) => a + issues(s), 0);
  const liveN = sessions.filter((s) => s.status === 'live').length;
  const urgent = alerts.filter((a) => a.severity === 'crit' || a.severity === 'high').length;

  const checked = stats.files_checked, failed = stats.files_failed, unchecked = Math.max(0, stats.files_total - checked);
  const verifiedPct = checked ? Math.round(((checked - failed) / checked) * 1000) / 10 : 0;
  const ringCol = !checked ? 'var(--ink3)' : failed ? 'var(--crit)' : 'var(--ok)';
  const charted = sessions.filter((s) => s.status !== 'scheduled').slice(0, 8).reverse();

  return (
    <>
      <PageTop title="Overview" sub={sub} />
      <div className="content">
        <div className="band">
          <div className="kpi"><div className="lab">Scripts tracked</div><div className="val">{stats.scripts_total.toLocaleString()}</div>
            <div className="note">{sessions.length} sessions · {liveN} live now</div></div>
          <div className="kpi"><div className="lab">Fully reconciled</div><div className="val">{reconPct}%</div>
            <div className="note">{complete.toLocaleString()} of {present.toLocaleString()} present candidates</div></div>
          <div className="kpi"><div className="lab">Open discrepancies</div><div className="val" style={openD ? { color: 'var(--crit)' } : undefined}>{openD}</div>
            <div className="note">{alerts.length} open alerts{urgent ? ` · ${urgent} urgent` : ''}</div></div>
          <div className="kpi"><div className="lab">Preserved scans</div><div className="val">{stats.scan_files.toLocaleString()}</div>
            <div className="note">SHA-256 hashed at upload</div></div>
        </div>

        <div className="grid g21" style={{ marginBottom: 18 }}>
          <div className="card">
            <div className="row between" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Four counts per session</h3><ChartLegend /></div>
            <div className="small muted" style={{ marginBottom: 8 }}>Red numbers show present candidates with no physical script or no scan.</div>
            {charted.length ? <ReconChart sessions={charted} /> : <div className="muted small">No sessions have run yet.</div>}
          </div>

          <div className="card">
            <h3>Integrity check <span className="muted small">· SHA-256</span></h3>
            <div className="integrity">
              <div className="ring-big">
                <Ring pct={checked ? verifiedPct : 0} col={ringCol} size={128} w={11} />
                <div><b>{checked ? `${verifiedPct}%` : '—'}</b><span>verified</span></div>
              </div>
              <div className="integrity-legend">
                <div><span><i style={{ background: 'var(--ok)' }} />Hash match</span><b>{(checked - failed).toLocaleString()}</b></div>
                <div><span><i style={{ background: 'var(--crit)' }} />Mismatch</span><b>{failed.toLocaleString()}</b></div>
                <div><span><i style={{ background: 'var(--ink3)' }} />Not yet checked</span><b>{unchecked.toLocaleString()}</b></div>
              </div>
            </div>
            <div className="small muted" style={{ marginTop: 14 }}>
              {stats.last_check_at ? `Last run ${fmtStamp(stats.last_check_at)}. ` : 'No check has run yet. '}
              Runs nightly; exams officers can also run it from the archive.
            </div>
            {failed > 0 && <div className="banner crit small" style={{ marginTop: 10 }}><b>{failed} file{failed === 1 ? '' : 's'} failed verification.</b> The stored copy no longer matches the hash taken at upload.</div>}
          </div>
        </div>

        <div className="card table-card" style={{ marginBottom: 18 }}>
          <div className="row between" style={{ marginBottom: 14 }}>
            <div><h3 style={{ margin: 0 }}>Four-count reconciliation</h3><div className="small muted">Registered · Present · Physical scripts · Scanned</div></div>
            <div className="row">
              <input className="input" type="search" placeholder="Search course, venue, invigilator…" aria-label="Search sessions"
                value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
              <div className="seg" role="group" aria-label="Filter sessions">
                {FILTERS.map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
              </div>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr>
                <th>Course</th><th>Date &amp; venue</th><th>Invigilator</th>
                <th className="num">Registered</th><th className="num">Present</th><th className="num">Physical</th><th className="num">Scanned</th><th>Status</th>
              </tr></thead>
              <tbody>
                {rows.map((s) => {
                  const [label, cls] = sessionPill(s);
                  // live sessions are still counting, so only a closed session's shortfall is a discrepancy
                  const short = (v: number) => s.status === 'closed' && v < s.present;
                  return (
                    <tr key={s.id}>
                      <td><b>{s.course_code}</b><div className="small muted">{s.course_title}</div></td>
                      <td className="small">{s.exam_date}<div className="muted">{s.venue}</div></td>
                      <td className="small">{s.invigilator_name ?? <span className="muted">Unassigned</span>}</td>
                      <td className="num">{s.registered}</td>
                      <td className="num">{s.present}</td>
                      <td className={`num${short(s.physical) ? ' cross' : ''}`}>{s.physical}</td>
                      <td className={`num${short(s.scanned) ? ' cross' : ''}`}>{s.scanned}</td>
                      <td><span className={`pill ${cls}`}>{label}</span></td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 28 }}>
                  {sessions.length ? 'No sessions match this filter.' : 'No exam sessions yet. Exams officers create them.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="grid g2">
          <div className="card">
            <h3>Open alerts <span className="muted small">· {alerts.length}</span></h3>
            {alerts.slice(0, 6).map((a) => (
              <div key={a.alert_key} className="alertitem">
                <Pill sev={a.severity} />
                <div style={{ minWidth: 0 }}><b className="small">{a.title}</b><div className="small muted">{a.detail}</div>
                  {a.acked_by && <div className="small muted">Acknowledged by {a.acked_by}</div>}</div>
              </div>
            ))}
            {!alerts.length && <div className="muted">All clear. Nothing needs attention.</div>}
            {alerts.length > 6 && <div className="small muted" style={{ marginTop: 8 }}>+{alerts.length - 6} more, handled by exams officers.</div>}
          </div>

          <div className="card">
            <div className="row between" style={{ marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>Audit chain</h3>
              {chain
                ? <span className={`pill ${chain.ok ? 'p-ok' : 'p-crit'}`}>{chain.ok ? `Intact · ${chain.entries} entries` : `Broken at #${chain.broken_at}`}</span>
                : <button className="btn sm" disabled={checking} onClick={verifyChain}>{checking ? 'Verifying…' : 'Verify chain'}</button>}
            </div>
            <ul className="audit-feed">
              {audit.map((e) => (
                <li key={e.id}>
                  <div><b>{e.actor_name}</b> <span className="muted">{e.action}</span></div>
                  {e.detail && <div className="small muted">{e.detail}</div>}
                  <div className="small muted"><span className="mono">#{e.id} · {e.hash.slice(0, 10)}…</span> · {fmtStamp(e.at)}</div>
                </li>
              ))}
            </ul>
            {!audit.length && <div className="muted small">No entries yet.</div>}
            <button className="btn sm" style={{ marginTop: 6 }} onClick={() => nav('/audit')}>Open audit log</button>
          </div>
        </div>
      </div>
    </>
  );
}

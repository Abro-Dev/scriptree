import { useNavigate } from 'react-router';
import { PageTop } from '../../components/Shell';
import { AlertRow, ChartLegend, Kpi, ReconChart, Ring } from '../../components/officer';
import { supabase } from '../../lib/supabase';
import { fetchAlerts, fetchDocTypes, fetchStats, fetchSummaries } from '../../lib/queries';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp, sessionPill } from '../../lib/officer';

interface AuditRow { id: number; at: string; action: string; detail: string }

const CUSTODY: [string, string][] = [['submitted', 'Submitted'], ['bundled', 'Bundled'], ['received', 'Received'], ['stored', 'Stored'], ['out', 'Out (retrieved)']];

export function Dashboard() {
  const nav = useNavigate();
  const { data, error } = useLoad(async () => {
    const [sessions, alerts, stats, types, audit] = await Promise.all([
      fetchSummaries(), fetchAlerts(), fetchStats(), fetchDocTypes(),
      supabase.from('audit_log').select('id, at, action, detail').order('id', { ascending: false }).limit(5).then((r) => must(r) as AuditRow[]),
    ]);
    return { sessions, alerts, stats, types, audit };
  }, []);

  if (error) return <><PageTop title="Dashboard" /><div className="content"><div className="banner crit">{error}</div></div></>;
  if (!data) return <><PageTop title="Dashboard" sub="Reconciliation status across all exam sessions" /><div className="content muted">Loading…</div></>;

  const { sessions, alerts, stats, types, audit } = data;
  const closed = sessions.filter((s) => s.status === 'closed');
  const present = closed.reduce((a, s) => a + s.present, 0), complete = closed.reduce((a, s) => a + s.complete, 0);
  const openD = closed.reduce((a, s) => a + s.open_issues + (s.hc_mismatch ? 1 : 0), 0);
  const pc = present ? Math.round((complete / present) * 100) : 100;
  const liveN = sessions.filter((s) => s.status === 'live').length;
  const docPct = stats.students_total ? Math.round((stats.students_complete / stats.students_total) * 100) : 0;
  const charted = sessions.filter((s) => s.status !== 'scheduled').slice(0, 8).reverse();

  return (
    <>
      <PageTop title="Dashboard" sub="Reconciliation status across all exam sessions" />
      <div className="content">
        <div className="band">
          <Kpi lab="Scripts tracked" val={stats.scripts_total} note={`across ${sessions.length} sessions, ${liveN} live now`} />
          <Kpi lab="Record completeness" val={`${pc}%`} note={`${complete} of ${present} present candidates fully reconciled`} />
          <Kpi lab="Integrity checks" val={stats.files_failed ? <span style={{ color: 'var(--crit)' }}>{stats.files_failed} failed</span> : stats.files_checked ? 'All pass' : 'Not run'}
            note={`${stats.scan_files} preserved scans, SHA-256${stats.last_check_at ? ` · last ${fmtStamp(stats.last_check_at)}` : ''}`} />
          <Kpi lab="Open discrepancies" val={openD} note={`${alerts.length} open alerts`} />
        </div>

        <div className="grid g21">
          <div>
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="row between" style={{ marginBottom: 6 }}><h3 style={{ margin: 0 }}>Where scripts go missing</h3><ChartLegend /></div>
              <div className="small muted" style={{ marginBottom: 8 }}>Red numbers show how many present candidates have no physical script or no scan.</div>
              {charted.length ? <ReconChart sessions={charted} /> : <div className="muted small">No sessions have run yet.</div>}
            </div>
            <div className="card">
              <h3>Sessions</h3>
              {sessions.map((s) => {
                const st = sessionPill(s);
                const pct = s.present ? Math.round((s.complete / s.present) * 100) : 0;
                const col = pct === 100 ? '#21a67a' : pct >= 90 ? '#ffc83d' : '#ff6b57';
                return (
                  <div key={s.id} className="sess" role="link" tabIndex={0} onClick={() => nav(`/sessions/${s.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/sessions/${s.id}`)}>
                    <div className="ring-wrap"><Ring pct={pct} col={col} /><b>{pct}%</b></div>
                    <div>
                      <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 15 }}>{s.course_code} <span className="sess-t">{s.course_title}</span></div>
                      <div className="small muted">{s.exam_date} in {s.venue}: {s.registered} registered, {s.present} present, {s.physical} scripts, {s.scanned} scans</div>
                    </div>
                    <span className={`pill ${st[1]}`}>{st[0]}</span>
                  </div>
                );
              })}
              {!sessions.length && <div className="muted small">No exam sessions yet. Create one from Exam sessions.</div>}
            </div>
          </div>
          <div className="card">
            <h3>Latest alerts <span className="muted small">· {alerts.length} open</span></h3>
            {alerts.slice(0, 6).map((a) => <AlertRow key={a.alert_key} a={a} />)}
            {!alerts.length && <div className="muted">No open alerts.</div>}
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => nav('/alerts')}>View all alerts</button>
          </div>
        </div>

        <div className="grid g3" style={{ marginTop: 16 }}>
          <div className="card">
            <h3>Student document completeness</h3>
            <div className="kpi"><div className="val">{docPct}%</div><div className="note">{stats.students_complete} of {stats.students_total} students have every required document verified</div></div>
            <div style={{ marginTop: 12 }}>{types.filter((t) => t.required).map((t) => {
              const p = stats.students_total ? Math.round(((stats.docs_verified_by_type[t.id] ?? 0) / stats.students_total) * 100) : 0;
              return <div key={t.id}><div className="row between small" style={{ marginTop: 8 }}><span>{t.name}</span><span className="muted">{p}%</span></div><div className="bar"><i style={{ width: `${p}%`, background: 'var(--pres)' }} /></div></div>;
            })}</div>
          </div>
          <div className="card">
            <h3>Custody status of scripts</h3>
            {CUSTODY.map(([k, l]) => {
              const n = stats.scripts_by_status[k] ?? 0, p = stats.scripts_total ? Math.round((n / stats.scripts_total) * 100) : 0;
              return <div key={k}><div className="row between small" style={{ marginTop: 8 }}><span>{l}</span><span className="muted">{n}</span></div><div className="bar"><i style={{ width: `${p}%`, background: 'var(--track)' }} /></div></div>;
            })}
            <div className="legend" style={{ marginTop: 12 }}>In order: submitted, bundled, received, stored.</div>
          </div>
          <div className="card">
            <h3>Recent activity</h3>
            {audit.map((e) => <div key={e.id} className="small" style={{ padding: '6px 0', borderBottom: '1px solid #eef1f4' }}>
              <b>{e.action}</b> <span className="muted">· {fmtStamp(e.at)}</span><div className="muted">{e.detail}</div></div>)}
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => nav('/audit')}>Open audit log</button>
          </div>
        </div>
      </div>
    </>
  );
}

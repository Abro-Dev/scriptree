import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PageTop } from '../../components/Shell';
import { Modal, Pill, useToast } from '../../components/ui';
import { FixModal } from './FixModal';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp, type SessionSummary } from '../../lib/officer';
import type { Counts, ExamSession, ReconRow } from '../../lib/hall';
import { ImportModal } from './Sessions';

const Yes = ({ v }: { v: boolean | null }) => v === true ? <span className="tick">✓</span> : v === false ? <span className="cross">✕</span> : <span className="dash">—</span>;

type Detail = ExamSession & { last_reconciled_at: string | null; invig: { full_name: string } | null };

export function SessionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [filter, setFilter] = useState('issues');
  const [resolving, setResolving] = useState<ReconRow | null>(null);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const { data, error, reload } = useLoad(async () => {
    const [s, c, r] = await Promise.all([
      supabase.from('exam_sessions').select('*, invig:profiles!invigilator_id(full_name)').eq('id', id!).single(),
      supabase.rpc('session_counts', { p_session: id }).single(),
      supabase.rpc('reconcile_session', { p_session: id }),
    ]);
    return { s: must(s) as Detail, c: must(c) as Counts, rows: must(r) as ReconRow[] };
  }, [id]);

  if (error) return <><PageTop title="Exam session" /><div className="content"><div className="banner crit">{error}</div></div></>;
  if (!data) return <><PageTop title="Exam session" /><div className="content muted">Loading…</div></>;
  const { s, c, rows } = data;
  const live = s.status !== 'closed';
  const issues = rows.filter((x) => ['crit', 'high', 'med'].includes(x.severity));
  const open = issues.filter((x) => !x.resolved).length;
  const hcMismatch = s.status === 'closed' && c.headcount != null && c.headcount !== c.physical;
  const outcomes = [...new Set(rows.map((x) => x.outcome))];
  const shown = filter === 'issues' ? rows.filter((x) => ['crit', 'high', 'med', 'pend'].includes(x.severity))
    : filter === 'all' ? rows : rows.filter((x) => x.outcome === filter);

  async function runRecon() {
    setBusy(true);
    const { data: r, error } = await supabase.rpc('run_reconciliation', { p_session: s.id }).single<{ complete_count: number; open_count: number }>();
    setBusy(false);
    if (error) { toast(errText(error)); return; }
    toast(`Reconciliation complete: ${r!.open_count} open discrepancies`);
    reload();
  }

  async function reopen() {
    const why = prompt(`Reopen ${s.course_code} in ${s.venue}?\nAttendance, check-in and scanning unlock until it is closed again. Say why (it goes in the audit log):`);
    if (why == null) return;
    if (why.trim().length < 5) { toast('Give a reason (at least 5 characters)'); return; }
    const { error } = await supabase.rpc('reopen_session', { p_session: s.id, p_note: why.trim().slice(0, 300) });
    if (error) { toast(errText(error)); return; }
    toast(`${s.course_code} is live again`);
    reload(); window.dispatchEvent(new Event('alerts-changed'));
  }

  async function cancel() {
    const why = prompt(`Cancel ${s.course_code} on ${s.exam_date} in ${s.venue}?\nThe session and its ${c.registered} registrations are removed. Say why (it goes in the audit log):`);
    if (why == null) return;
    if (why.trim().length < 5) { toast('Give a reason (at least 5 characters)'); return; }
    const { error } = await supabase.rpc('delete_exam_session', { p_session: s.id, p_reason: why.trim().slice(0, 300) });
    if (error) { toast(errText(error)); return; }
    toast(`${s.course_code} cancelled`);
    nav('/sessions');
  }

  const gap = (v: number, ref: number) => v < ref ? <div className="gap" style={{ color: 'var(--crit)' }}>−{ref - v} vs present</div>
    : v > ref ? <div className="gap" style={{ color: 'var(--high)' }}>+{v - ref} over</div>
    : <div className="gap" style={{ color: 'var(--ok)' }}>✓ matches</div>;

  const summary: SessionSummary = { ...s, invigilator_name: s.invig?.full_name ?? null, registered: c.registered, present: c.present, physical: c.physical,
    scanned: c.scanned, complete: 0, open_issues: 0, pending: 0, hc_mismatch: false } as SessionSummary;

  return (
    <>
      <PageTop title={`${s.course_code} · ${s.course_title}`}
        sub={`${s.exam_date} · ${s.start_time.slice(0, 5)} · ${s.venue} · Invigilator: ${s.invig?.full_name ?? '—'}`}
        actions={<>
          <button className="btn" onClick={() => nav('/sessions')}>Back to sessions</button>
          {s.status === 'scheduled' && <button className="btn danger" onClick={cancel}>Cancel session</button>}
          {s.status === 'closed' && <button className="btn" onClick={reopen}>Reopen</button>}
          {s.status !== 'closed' && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
          {s.status !== 'closed' && <button className="btn" title="Run attendance, check-in and scanning yourself, e.g. when the invigilator is away" onClick={() => nav(`/hall/${s.id}`)}>Exam hall</button>}
          {s.status !== 'closed' && <button className="btn" onClick={() => setImporting(true)}>Import candidates</button>}
          <button className="btn pri" disabled={busy} onClick={runRecon}>Run reconciliation</button>
        </>} />
      <div className="content">
        {s.status === 'scheduled' ? <div className="banner info" style={{ marginBottom: 16 }}><b>Scheduled.</b> The invigilator opens the session in the exam hall. {c.registered} candidates registered so far.</div>
          : live ? <div className="banner info" style={{ marginBottom: 16 }}><b>Live session.</b> Counts update as the invigilator checks in scripts and the scan station uploads. Gaps show as <i>pending</i> until the session is closed, then become discrepancies.</div>
          : open || hcMismatch ? <div className="banner warn" style={{ marginBottom: 16 }}><b>{open} candidate{open === 1 ? '' : 's'} need attention{hcMismatch ? ` · headcount (${c.headcount}) ≠ physical scripts (${c.physical})` : ''}.</b> Each row below shows exactly where the record breaks.</div>
          : <div className="banner ok" style={{ marginBottom: 16 }}><b>Fully reconciled.</b> Every present candidate has a physical script and one verified scan.</div>}

        <div className="funnel" style={{ marginBottom: 16 }}>
          <div><div className="lab">Registered (expected)</div><div className="val">{c.registered}</div><div className="gap muted">from CSV import</div></div>
          <div><div className="lab">Present (attendance)</div><div className="val">{c.present}</div>
            {c.present < c.registered ? <div className="gap muted">{c.registered - c.present} not present · headcount {c.headcount ?? '—'}</div> : <div className="gap" style={{ color: 'var(--ok)' }}>all present</div>}</div>
          <div><div className="lab">Physical scripts received</div><div className="val">{c.physical}</div>{gap(c.physical, c.present)}</div>
          <div><div className="lab">Digital scans</div><div className="val">{c.scanned}</div>{gap(c.scanned, c.present)}</div>
        </div>

        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="row">
              <button className={`chip ${filter === 'issues' ? 'on' : ''}`} onClick={() => setFilter('issues')}>Needs attention ({rows.filter((x) => ['crit', 'high', 'med', 'pend'].includes(x.severity)).length})</button>
              <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All ({rows.length})</button>
              {outcomes.map((o) => <button key={o} className={`chip ${filter === o ? 'on' : ''}`} onClick={() => setFilter(o)}>{o} ({rows.filter((x) => x.outcome === o).length})</button>)}
            </div>
            <span className="small muted">Last run: {fmtStamp(s.last_reconciled_at)}</span>
          </div>
          <table>
            <thead><tr><th>Student ID</th><th>Candidate</th><th>Registered</th><th>Present</th><th>Physical</th><th>Scans</th><th>Hash</th><th>Outcome</th><th /></tr></thead>
            <tbody>
              {shown.map((x) => {
                const isIssue = ['crit', 'high', 'med'].includes(x.severity);
                return (
                  <tr key={x.student_id}>
                    <td className="mono">{x.matric_no}</td>
                    <td>{x.full_name}</td>
                    <td><Yes v={x.is_registered} /></td><td><Yes v={x.present} /></td><td><Yes v={x.has_physical} /></td>
                    <td>{x.n_scans > 1 ? <b style={{ color: 'var(--med)' }}>{x.n_scans}</b> : x.n_scans ? <span className="tick">1</span> : <span className="cross">0</span>}</td>
                    <td>{x.n_scans ? (x.integrity_bad ? <span className="cross">fail</span> : <span className="tick">ok</span>) : <span className="dash">—</span>}</td>
                    <td><Pill sev={x.severity}>{x.outcome}</Pill>{x.resolved && <> <span className="pill p-ok">Resolved</span></>}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      {(x.has_physical || x.n_scans > 0) && <button className="btn sm" onClick={() => nav(`/tracker?q=${encodeURIComponent(x.matric_no)}&session=${s.id}`)}>Trace</button>}{' '}
                      {isIssue && !x.resolved && <button className="btn sm pri" onClick={() => setResolving(x)}>Fix</button>}
                    </td>
                  </tr>
                );
              })}
              {!shown.length && <tr><td colSpan={9} className="muted">No candidates match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {resolving && <FixModal sid={s.id} code={s.course_code} live={live} row={resolving} onClose={() => setResolving(null)} onDone={() => { setResolving(null); reload(); window.dispatchEvent(new Event('alerts-changed')); }} />}
      {editing && <EditSessionModal s={s} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
      {importing && <ImportModal sessions={[summary]} initial={s.id} onClose={() => { setImporting(false); reload(); }} />}
    </>
  );
}


/** Change a session that hasn't closed. Once it is live only the title, venue and invigilator can change. */
function EditSessionModal({ s, onClose, onDone }: { s: Detail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data: invigs } = useLoad(async () => must(await supabase.from('profiles').select('id, full_name').eq('role', 'invigilator').eq('status', 'active').order('full_name')) as { id: string; full_name: string }[], []);
  const [f, setF] = useState({ title: s.course_title, date: s.exam_date, time: s.start_time.slice(0, 5), venue: s.venue, invig: s.invigilator_id ?? '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const isLive = s.status === 'live';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.title.trim().length < 3) return setErr('Enter the course title.');
    if (!f.date) return setErr('Choose the exam date.');
    if (!/^\d{2}:\d{2}$/.test(f.time)) return setErr('Enter the start time.');
    if (f.venue.trim().length < 2) return setErr('Enter the venue.');
    if (!f.invig) return setErr('Choose an invigilator.');
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('update_exam_session', {
      p_session: s.id, p_course_title: f.title.trim(), p_date: f.date, p_time: f.time, p_venue: f.venue.trim(), p_invigilator: f.invig,
    });
    setBusy(false);
    if (error) return setErr(errText(error));
    toast('Session updated');
    onDone();
  }

  return (
    <Modal onClose={onClose}>
      <h3>Edit {s.course_code}</h3>
      <p className="muted small">{isLive ? 'The session is open, so the date and time are fixed. You can still change the venue or hand it to another invigilator.' : 'Change the details or hand the session to another invigilator. Every change is written to the audit log.'}</p>
      <form onSubmit={submit} noValidate>
        <div className="grid g2" style={{ margin: '14px 0' }}>
          <input className="input" style={{ gridColumn: '1 / -1' }} placeholder="Course title" value={f.title} onChange={set('title')} maxLength={200} aria-label="Course title" />
          <input className="input" type="date" value={f.date} onChange={set('date')} disabled={isLive} aria-label="Exam date" />
          <input className="input" type="time" value={f.time} onChange={set('time')} disabled={isLive} aria-label="Start time" />
          <input className="input" placeholder="Venue" value={f.venue} onChange={set('venue')} maxLength={120} aria-label="Venue" />
          <select className="input" value={f.invig} onChange={set('invig')} aria-label="Invigilator">
            <option value="">Invigilator…</option>
            {s.invigilator_id && !(invigs ?? []).some((i) => i.id === s.invigilator_id) && <option value={s.invigilator_id}>{s.invig?.full_name ?? 'Current invigilator'} (not active)</option>}
            {(invigs ?? []).map((i) => <option key={i.id} value={i.id}>{i.full_name}</option>)}
          </select>
        </div>
        <div className="err" role="alert">{err}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>
    </Modal>
  );
}

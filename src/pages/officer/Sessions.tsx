import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { PageTop } from '../../components/Shell';
import { Modal, useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp, sessionPill, type SessionSummary } from '../../lib/officer';
import { fetchSettings, fetchSummaries } from '../../lib/queries';
import { ATT_MODES, type AttMode } from '../../lib/hall';
import { parseCsv, toCandidates, downloadCandidateTemplate, type CandidateRow } from '../../lib/csv';
import { isMatric } from '../../lib/validate';

export function Sessions() {
  const nav = useNavigate();
  const [modal, setModal] = useState<'new' | 'import' | null>(null);
  const { data, error, reload } = useLoad(fetchSummaries, []);

  return (
    <>
      <PageTop title="Exam sessions" sub="Expected vs present vs physical vs scanned" />
      <div className="content">
        {error && <div className="banner crit">{error}</div>}
        <div className="card" style={{ overflowX: 'auto' }}><table>
          <thead><tr><th>Course</th><th>Date</th><th>Venue</th><th>Invigilator</th><th className="num">Registered</th><th className="num">Present</th><th className="num">Physical</th><th className="num">Scanned</th><th>Last reconciled</th><th>Status</th></tr></thead>
          <tbody>
            {(data ?? []).map((s) => {
              const st = sessionPill(s);
              return (
                <tr key={s.id} className="click" onClick={() => nav(`/sessions/${s.id}`)}>
                  <td><b>{s.course_code}</b> <span className="muted">{s.course_title}</span></td>
                  <td>{s.exam_date}</td><td>{s.venue}</td><td>{s.invigilator_name ?? '—'}</td>
                  <td className="num">{s.registered}</td><td className="num">{s.present}</td><td className="num">{s.physical}</td><td className="num">{s.scanned}</td>
                  <td className="small muted">{fmtStamp(s.last_reconciled_at)}</td>
                  <td><span className={`pill ${st[1]}`}>{st[0]}</span></td>
                </tr>
              );
            })}
            {data && !data.length && <tr><td colSpan={10} className="muted">No sessions yet.</td></tr>}
            {!data && !error && <tr><td colSpan={10} className="muted">Loading…</td></tr>}
          </tbody>
        </table></div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => setModal('new')}>+ New exam session</button>
          <button className="btn" onClick={() => setModal('import')} disabled={!data?.some((s) => s.status !== 'closed')}>Import candidates (CSV)</button>
        </div>
      </div>
      {modal === 'new' && <NewSessionModal onClose={() => setModal(null)} onCreated={(id) => { setModal(null); nav(`/sessions/${id}`); }} />}
      {modal === 'import' && data && <ImportModal sessions={data.filter((s) => s.status !== 'closed')} onClose={() => { setModal(null); reload(); }} />}
    </>
  );
}

function NewSessionModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const { data: invigs } = useLoad(async () => must(await supabase.from('profiles').select('id, full_name').eq('role', 'invigilator').eq('status', 'active').order('full_name')) as { id: string; full_name: string }[], []);
  const { data: settings } = useLoad(fetchSettings, []);
  const [f, setF] = useState({ code: '', title: '', date: '', time: '09:00', venue: '', invig: '', mode: '' as AttMode | '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    const code = f.code.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!/^[A-Z]{2,5} [0-9]{3}$/.test(code)) return setErr('Course code looks like “CSC 411”.');
    if (f.title.trim().length < 3) return setErr('Enter the course title.');
    if (!f.date) return setErr('Choose the exam date.');
    if (!/^\d{2}:\d{2}$/.test(f.time)) return setErr('Enter the start time.');
    if (f.venue.trim().length < 2) return setErr('Enter the venue.');
    if (!f.invig) return setErr('Choose an invigilator.');
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('create_exam_session', {
      p_course_code: code, p_course_title: f.title.trim(), p_date: f.date, p_time: f.time, p_venue: f.venue.trim(),
      p_invigilator: f.invig, p_att_mode: f.mode || settings?.default_att_mode || 'start',
    });
    setBusy(false);
    if (error) return setErr(error.message.includes('duplicate') ? `${code} already has a session on ${f.date}.` : errText(error));
    toast(`${code} created — import candidates next`);
    onCreated(data as string);
  }

  return (
    <Modal onClose={onClose}>
      <h3>New exam session</h3>
      <p className="muted small">Creates the session. Import the registered candidates next. Each script gets its ID (student ID + course code) when it's handed in.</p>
      <form onSubmit={submit} noValidate>
        <div className="grid g2" style={{ margin: '14px 0' }}>
          <input className="input" placeholder="Course code e.g. CSC 411" value={f.code} onChange={set('code')} maxLength={10} aria-label="Course code" />
          <input className="input" placeholder="Course title" value={f.title} onChange={set('title')} maxLength={120} aria-label="Course title" />
          <input className="input" type="date" value={f.date} onChange={set('date')} aria-label="Exam date" />
          <input className="input" type="time" value={f.time} onChange={set('time')} aria-label="Start time" />
          <input className="input" placeholder="Venue" value={f.venue} onChange={set('venue')} maxLength={60} aria-label="Venue" />
          <select className="input" value={f.invig} onChange={set('invig')} aria-label="Invigilator">
            <option value="">Invigilator…</option>
            {(invigs ?? []).map((i) => <option key={i.id} value={i.id}>{i.full_name}</option>)}
          </select>
          <select className="input" value={f.mode || settings?.default_att_mode || 'start'} onChange={set('mode')} aria-label="Attendance timing" style={{ gridColumn: '1 / -1' }}>
            {(Object.keys(ATT_MODES) as AttMode[]).map((k) => <option key={k} value={k}>Attendance {ATT_MODES[k].toLowerCase()}</option>)}
          </select>
        </div>
        <div className="err" role="alert">{err}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={busy}>{busy ? 'Creating…' : 'Create session'}</button>
        </div>
      </form>
    </Modal>
  );
}

interface ImportResult { added: number; created: number; already: number; skipped: { matric_no: string; reason: string }[] }

export function ImportModal({ sessions, initial, onClose }: { sessions: SessionSummary[]; initial?: string; onClose: () => void }) {
  const toast = useToast();
  const [sid, setSid] = useState(initial ?? sessions[0]?.id ?? '');
  const [rows, setRows] = useState<CandidateRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function pick(file?: File) {
    setErr(''); setRows(null); setResult(null);
    if (!file) return;
    if (file.size > 2 * 1048576) return setErr('CSV must be under 2 MB.');
    const parsed = toCandidates(parseCsv(await file.text()));
    if (parsed.error) return setErr(parsed.error);
    if (parsed.rows.length > 5000) return setErr('At most 5000 candidates per import.');
    setFileName(file.name); setRows(parsed.rows);
  }

  const seen = new Set<string>();
  const dupes = (rows ?? []).filter((r) => { const m = (r.matric_no ?? '').toUpperCase(); if (seen.has(m)) return true; seen.add(m); return false; });
  const bad = (rows ?? []).filter((r) => !isMatric(r.matric_no ?? ''));

  async function run() {
    if (!rows) return;
    const unique = [...new Map(rows.filter((r) => isMatric(r.matric_no ?? '')).map((r) => [(r.matric_no ?? '').toUpperCase(), r])).values()];
    setBusy(true);
    const { data, error } = await supabase.rpc('import_candidates', { p_session: sid, p_rows: unique }).single<ImportResult>();
    setBusy(false);
    if (error) return setErr(errText(error));
    setResult(data);
    toast(`${data!.added} candidates registered`);
  }

  const s = sessions.find((x) => x.id === sid);
  return (
    <Modal onClose={onClose}>
      <h3>Import registered candidates</h3>
      <p className="muted small">
        Upload the departmental registration list as a CSV file. Only <span className="mono">matric_no</span> is required for students already on record.
        For a student who isn't on record yet, also fill in <span className="mono">full_name, student_code, email, department, level</span> and they're added automatically.
        <span className="mono"> course_code</span> is optional; rows for a different course are skipped.
      </p>
      <button type="button" className="btn sm" style={{ marginBottom: 4 }} onClick={() => downloadCandidateTemplate(s?.course_code)}>⬇ Download template</button>
      <select className="input" style={{ width: '100%', margin: '10px 0' }} value={sid} onChange={(e) => { setSid(e.target.value); setResult(null); }} aria-label="Session">
        {sessions.map((x) => <option key={x.id} value={x.id}>{x.course_code} · {x.course_title} · {x.exam_date}</option>)}
      </select>
      {!result && <label className="drop" style={{ margin: '4px 0 10px' }}>
        <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        {fileName ? <><b>{fileName}</b> · {rows?.length ?? 0} rows</> : <>Drop CSV here or <b>browse</b></>}
      </label>}
      {rows && !result && <div className="small" style={{ marginBottom: 10 }}>
        <div>{rows.length - bad.length - dupes.length} valid rows for {s?.course_code}.</div>
        {bad.length > 0 && <div style={{ color: 'var(--crit)' }}>{bad.length} with an invalid matric number (e.g. “{bad[0].matric_no}”) — will be skipped.</div>}
        {dupes.length > 0 && <div style={{ color: 'var(--med)' }}>{dupes.length} duplicate rows in the file — imported once.</div>}
      </div>}
      {result && <div className="banner ok" style={{ marginBottom: 10 }}>
        <b>{result.added} registered</b>{result.created ? `, ${result.created} new students added` : ''}{result.already ? `, ${result.already} already registered` : ''}.
        {result.created > 0 && <div className="small" style={{ marginTop: 6 }}>New students can't sign in until an admin issues their one-time passwords (Admin → Users → Students).</div>}
        {result.skipped.length > 0 && <div style={{ marginTop: 6, maxHeight: 160, overflow: 'auto' }}>
          <b>{result.skipped.length} skipped:</b>
          {result.skipped.map((x, i) => <div key={i} className="small"><span className="mono">{x.matric_no}</span> — {x.reason}</div>)}
        </div>}
      </div>}
      <div className="err" role="alert">{err}</div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
        {!result && <button className="btn pri" disabled={!rows || busy || !sid} onClick={run}>{busy ? 'Importing…' : 'Import'}</button>}
      </div>
    </Modal>
  );
}

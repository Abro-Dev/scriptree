import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { PageTop } from '../../components/Shell';
import { Pill, useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fileId, fmtStamp } from '../../lib/officer';
import { mb, shortHash } from '../../lib/pdf';

interface ScanFile { id: string; file_no: number; version: number; active: boolean; uploaded_at: string; uploaded_by_name: string; size_bytes: number; sha256: string; session_id: string; storage_path: string }
interface ScriptRec {
  id: string; script_code: string; status: string; location: string; session_id: string;
  exam_sessions: { course_code: string; course_title: string; exam_date: string; venue: string };
  students: { full_name: string; matric_no: string };
  custody_events: { action: string; location: string; actor_name: string; at: string }[];
}
interface Trace { scripts: ScriptRec[]; files: ScanFile[]; integrity: Record<string, boolean | null>; registered: Set<string>; orphanFiles: ScanFile[] }

const STATUS_LABEL: Record<string, string> = { submitted: 'Submitted', bundled: 'Bundled', received: 'Received', stored: 'Stored', out: 'Out' };
const CUSTODY_ACTIONS = ['Sealed in batch', 'Received at exams office', 'Stored in records room', 'Retrieved for marking', 'Returned to records room', 'Released for result verification'];

async function trace(q: string, session: string | null): Promise<Trace | null> {
  const id = must(await supabase.rpc('resolve_identifier', { p_q: q, p_session: session })) as string | null;
  if (!id) return null;
  let sq = supabase.from('scripts')
    .select('id, script_code, status, location, session_id, exam_sessions(course_code, course_title, exam_date, venue), students(full_name, matric_no), custody_events(action, location, actor_name, at)')
    .eq('student_id', id).order('created_at', { ascending: false }).order('at', { referencedTable: 'custody_events' });
  let fq = supabase.from('files').select('id, file_no, version, active, uploaded_at, uploaded_by_name, size_bytes, sha256, session_id, storage_path')
    .eq('kind', 'script').eq('student_id', id).order('version');
  if (session) { sq = sq.eq('session_id', session); fq = fq.eq('session_id', session); }
  const [scripts, files, regs] = await Promise.all([
    sq.then((r) => must(r) as unknown as ScriptRec[]),
    fq.then((r) => must(r) as ScanFile[]),
    supabase.from('registrations').select('session_id').eq('student_id', id).then((r) => must(r) as { session_id: string }[]),
  ]);
  const integ = files.length ? must(await supabase.from('file_integrity').select('file_id, ok').in('file_id', files.map((f) => f.id))) as { file_id: string; ok: boolean | null }[] : [];
  const withScript = new Set(scripts.map((s) => s.session_id));
  return {
    scripts, files, registered: new Set(regs.map((r) => r.session_id)),
    integrity: Object.fromEntries(integ.map((i) => [i.file_id, i.ok])),
    orphanFiles: files.filter((f) => f.active && !withScript.has(f.session_id)),
  };
}

export function Tracker() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '', session = params.get('session');
  const [input, setInput] = useState(q);
  const { profile } = useAuth();
  const officer = profile?.role === 'officer';
  const { data, error, reload } = useLoad(async () => (q ? trace(q, session) : undefined), [q, session]);

  function go(e: FormEvent) {
    e.preventDefault();
    const v = input.trim().slice(0, 40);
    setParams(v ? { q: v } : {});
  }

  return (
    <>
      <PageTop title={officer ? 'Script tracker' : 'Script lookup'} sub="Chain of custody for any script" />
      <div className="content">
        <div className="card" style={{ marginBottom: 16 }}>
          <form className="row" onSubmit={go}>
            <input className="input" style={{ flex: 1, minWidth: 240 }} placeholder="Student ID or script ID" value={input} maxLength={40}
              onChange={(e) => setInput(e.target.value)} aria-label="Student ID or script ID" autoFocus />
            <button className="btn pri">Trace</button>
          </form>
          {session && <div className="legend" style={{ marginTop: 8 }}>Showing one session only · <a href="#" onClick={(e) => { e.preventDefault(); setParams({ q }); }}>show all sessions</a></div>}
          {!officer && <div className="legend" style={{ marginTop: 8 }}>You can look up scripts from sessions you invigilated.</div>}
        </div>
        {error && <div className="banner crit">{error}</div>}
        {q && data === null && <div className="banner warn">No student or script found for “{q}”.</div>}
        {data && !data.scripts.length && !data.orphanFiles.length && <div className="banner warn">No script found for “{q}”. If the candidate sat the exam, this is a missing-script case.</div>}
        {data?.scripts.map((sc) => <ScriptCard key={sc.id} sc={sc} t={data} officer={officer} onChange={reload} />)}
        {data?.orphanFiles.map((f) => (
          <div key={f.id} className="card" style={{ marginBottom: 16 }}>
            <div className="banner crit" style={{ marginBottom: 12 }}><b>Scan exists but no physical script was checked in.</b></div>
            <FileBox f={f} ok={data.integrity[f.id]} officer={officer} />
          </div>
        ))}
      </div>
    </>
  );
}

function FileBox({ f, ok, officer }: { f: ScanFile; ok: boolean | null | undefined; officer: boolean }) {
  const toast = useToast();
  async function open() {
    const { data, error } = await supabase.storage.from('scans').createSignedUrl(f.storage_path, 120);
    if (error) toast(errText(error)); else window.open(data.signedUrl, '_blank', 'noopener');
  }
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 10, marginBottom: 8 }}>
      <div className="row between"><b className="small">v{f.version} · {fileId(f.file_no)}</b>
        {!f.active ? <Pill sev="pend">Superseded</Pill> : ok === false ? <Pill sev="crit">Hash mismatch</Pill> : ok ? <Pill sev="ok">Hash verified</Pill> : <span className="small muted">Not yet re-checked</span>}</div>
      <div className="small muted" style={{ margin: '4px 0' }}>{fmtStamp(f.uploaded_at)} · {f.uploaded_by_name} · {mb(f.size_bytes)}</div>
      <div className="row between"><span className="hash" title={f.sha256}>{shortHash(f.sha256)}</span>{officer && <button className="btn sm" onClick={open}>Open PDF</button>}</div>
    </div>
  );
}

function ScriptCard({ sc, t, officer, onChange }: { sc: ScriptRec; t: Trace; officer: boolean; onChange: () => void }) {
  const toast = useToast();
  const [act, setAct] = useState(CUSTODY_ACTIONS[1]);
  const [loc, setLoc] = useState('');
  const [busy, setBusy] = useState(false);
  const s = sc.exam_sessions, st = sc.students;
  const files = t.files.filter((f) => f.session_id === sc.session_id);

  async function record() {
    setBusy(true);
    const { error } = await supabase.rpc('add_custody_event', { p_script: sc.id, p_action: act, p_location: loc.trim().slice(0, 120) });
    setBusy(false);
    if (error) { toast(errText(error)); return; }
    toast('Custody event recorded'); setLoc(''); onChange();
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="grid g21">
        <div>
          <div className="row between">
            <div>
              <div className="mono muted">{sc.script_code}</div>
              <h3 style={{ margin: '2px 0 4px', fontSize: 17 }}>{st.full_name} · {st.matric_no}</h3>
              <div className="small muted mono">Student ID {st.matric_no}</div>
              <div className="small muted">{s.course_code} {s.course_title} · {s.exam_date} · {s.venue}</div>
            </div>
            <div style={{ textAlign: 'right' }}><span className="pill p-live">{STATUS_LABEL[sc.status] ?? sc.status}</span><div className="small muted" style={{ marginTop: 4 }}>{sc.location}</div></div>
          </div>
          {!t.registered.has(sc.session_id) && <div className="banner crit" style={{ marginTop: 12 }}>Candidate is not on the registered list for {s.course_code}.</div>}
          <h3 style={{ marginTop: 18 }}>Chain of custody</h3>
          <div className="timeline">{sc.custody_events.map((e, i) => (
            <div key={i} className="ev"><b>{e.action}</b><div className="small muted">{fmtStamp(e.at)} · {e.actor_name} · {e.location}</div></div>
          ))}</div>
          {officer && <div className="row" style={{ marginTop: 4 }}>
            <select className="input" value={act} onChange={(e) => setAct(e.target.value)} aria-label="Custody event">{CUSTODY_ACTIONS.map((a) => <option key={a}>{a}</option>)}</select>
            <input className="input" style={{ flex: 1 }} placeholder="Location / note, e.g. Records room · Shelf 4" value={loc} maxLength={120} onChange={(e) => setLoc(e.target.value)} aria-label="Location" />
            <button className="btn" disabled={busy} onClick={record}>Record event</button>
          </div>}
        </div>
        <div>
          <h3>Digital copies</h3>
          {files.length ? files.map((f) => <FileBox key={f.id} f={f} ok={t.integrity[f.id]} officer={officer} />) : <div className="banner warn">No scan uploaded for this script.</div>}
          <div className="orig" style={{ marginTop: 6 }}>ⓘ Digital copy only — the official original is the paper script.</div>
        </div>
      </div>
    </div>
  );
}

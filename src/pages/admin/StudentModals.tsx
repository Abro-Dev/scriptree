import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { isEmail, isMatric, isStudentCode } from '../../lib/validate';
import { parseCsv, toStudents, downloadStudentTemplate, type StudentRow } from '../../lib/csv';

export interface AddResult { created: number; existing: number; updated: number; skipped: { matric_no: string; reason: string }[]; ids: string[] }

async function addStudents(rows: StudentRow[]): Promise<AddResult> {
  const { data, error } = await supabase.rpc('add_students', { p_rows: rows }).single<AddResult>();
  if (error) throw error;
  return data!;
}

const LEVELS = ['100L', '200L', '300L', '400L', '500L', '600L', 'PG'];

/** One student. On success, optionally hands the new student's id back so the caller can issue a one-time password. */
export function AddStudentModal({ onClose, onDone }: { onClose: () => void; onDone: (issueFor: string | null) => void }) {
  const [f, setF] = useState({ matric_no: '', full_name: '', student_code: '', email: '', department: '', level: '100L' });
  const [issueNow, setIssueNow] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isMatric(f.matric_no)) return setErr('Matric number should look like BU/24C/IT/10778 (school / year + intake A–D / department / number).');
    if (f.full_name.trim().length < 2) return setErr('Enter the full name.');
    if (!isStudentCode(f.student_code)) return setErr('Student ID should be ST followed by 4–10 digits, e.g. ST210001.');
    if (!isEmail(f.email)) return setErr('Enter the student’s email. Their sign-in details are sent there.');
    if (!f.department.trim()) return setErr('Enter the department.');
    setBusy(true); setErr('');
    try {
      const r = await addStudents([f]);
      if (r.skipped.length) return setErr(r.skipped[0].reason);
      if (r.existing) return setErr(`${f.matric_no.toUpperCase()} is already on record${r.updated ? ' (their email has now been saved)' : ''}. To send them a new password, use “Reset a student's password”.`);
      onDone(issueNow ? r.ids[0] : null);
    } catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose}>
      <h3>Add a student</h3>
      <p className="small muted">Adds the student to the roster. They sign in with their matric number or student ID.</p>
      <form onSubmit={submit} noValidate>
        <div className="grid g2" style={{ margin: '14px 0' }}>
          <input className="input mono" placeholder="Matric number, e.g. BU/24C/IT/10778" maxLength={24} value={f.matric_no} onChange={(e) => set('matric_no', e.target.value)} aria-label="Matric number" autoFocus />
          <input className="input mono" placeholder="Student ID, e.g. ST210001" maxLength={12} value={f.student_code} onChange={(e) => set('student_code', e.target.value)} aria-label="Student ID" />
          <input className="input" placeholder="Full name" maxLength={120} value={f.full_name} onChange={(e) => set('full_name', e.target.value)} aria-label="Full name" />
          <input className="input" type="email" placeholder="Email, e.g. name@example.com" maxLength={120} value={f.email} onChange={(e) => set('email', e.target.value)} aria-label="Email" />
          <input className="input" placeholder="Department, e.g. Computer Science" maxLength={80} value={f.department} onChange={(e) => set('department', e.target.value)} aria-label="Department" />
          <select className="input" value={f.level} onChange={(e) => set('level', e.target.value)} aria-label="Level">
            {LEVELS.map((l) => <option key={l}>{l}</option>)}
          </select>
        </div>
        <label className="row small" style={{ gap: 8, marginBottom: 6 }}>
          <input type="checkbox" checked={issueNow} onChange={(e) => setIssueNow(e.target.checked)} />
          Give them sign-in access now (emails a one-time password; a printable slip is shown too)
        </label>
        <div className="err" role="alert">{err}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={busy}>{busy ? 'Adding…' : 'Add student'}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Many students from a CSV. Optionally creates sign-in accounts for everyone who doesn't have one yet. */
export function ImportStudentsModal({ onClose, onDone }: { onClose: () => void; onDone: (issueAccounts: boolean) => void }) {
  const [rows, setRows] = useState<StudentRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [issueNow, setIssueNow] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddResult | null>(null);

  async function pick(file?: File) {
    setErr(''); setRows(null); setResult(null); setFileName('');
    if (!file) return;
    if (file.size > 2 * 1048576) return setErr('CSV must be under 2 MB.');
    const parsed = toStudents(parseCsv(await file.text()));
    if (parsed.error) return setErr(parsed.error);
    if (!parsed.rows.length) return setErr('No student rows under the header.');
    if (parsed.rows.length > 5000) return setErr('At most 5000 students per import.');
    setFileName(file.name); setRows(parsed.rows);
  }

  const seen = new Set<string>();
  const dupes = (rows ?? []).filter((r) => { const m = (r.matric_no ?? '').toUpperCase(); if (seen.has(m)) return true; seen.add(m); return false; }).length;
  const bad = (rows ?? []).filter((r) => !isMatric(r.matric_no ?? '') || !isStudentCode(r.student_code ?? '') || !isEmail(r.email ?? '')
    || !(r.full_name ?? '').trim() || !(r.department ?? '').trim() || !(r.level ?? '').trim());

  async function run() {
    if (!rows) return;
    const unique = [...new Map(rows.map((r) => [(r.matric_no ?? '').toUpperCase(), r])).values()];
    setBusy(true); setErr('');
    try { setResult(await addStudents(unique)); } catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  }

  return (
    <Modal onClose={onClose}>
      <h3>Import students (CSV)</h3>
      <p className="small muted">
        One row per student, with the columns <span className="mono">matric_no, full_name, student_code, email, department, level</span>.
        Students already on record (same matric number) are left unchanged, except that a missing email is filled in.
      </p>
      <button type="button" className="btn sm" style={{ margin: '4px 0 10px' }} onClick={downloadStudentTemplate}>⬇ Download template</button>
      {!result && <label className="drop" style={{ margin: '4px 0 10px' }}>
        <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
        {fileName ? <><b>{fileName}</b> · {rows?.length ?? 0} rows</> : <>Drop CSV here or <b>browse</b></>}
      </label>}
      {rows && !result && <div className="small" style={{ marginBottom: 10 }}>
        <div>{rows.length - bad.length - dupes} rows look ready.</div>
        {bad.length > 0 && <div style={{ color: 'var(--crit)' }}>{bad.length} with a missing or invalid value (e.g. “{bad[0].matric_no || 'blank matric'}”). New students in those rows will be skipped; the import tells you why.</div>}
        {dupes > 0 && <div style={{ color: 'var(--med)' }}>{dupes} duplicate matric numbers in the file — each imported once.</div>}
        <label className="row" style={{ gap: 8, marginTop: 8 }}>
          <input type="checkbox" checked={issueNow} onChange={(e) => setIssueNow(e.target.checked)} />
          Then give sign-in access to every student without an account (one-time passwords are emailed)
        </label>
      </div>}
      {result && <div className="banner ok" style={{ marginBottom: 10 }}>
        <b>{result.created} students added</b>{result.existing ? `, ${result.existing} already on record` : ''}{result.updated ? ` (${result.updated} emails filled in)` : ''}.
        {result.skipped.length > 0 && <div style={{ marginTop: 6, maxHeight: 160, overflow: 'auto' }}>
          <b>{result.skipped.length} skipped:</b>
          {result.skipped.map((x, i) => <div key={i} className="small"><span className="mono">{x.matric_no || '(blank)'}</span> — {x.reason}</div>)}
        </div>}
      </div>}
      <div className="err" role="alert">{err}</div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        {!result && <button className="btn" onClick={onClose}>Cancel</button>}
        {!result && <button className="btn pri" disabled={!rows || busy} onClick={run}>{busy ? 'Importing…' : 'Import'}</button>}
        {result && <button className="btn pri" onClick={() => onDone(issueNow)}>{issueNow ? 'Send sign-in details' : 'Done'}</button>}
      </div>
    </Modal>
  );
}

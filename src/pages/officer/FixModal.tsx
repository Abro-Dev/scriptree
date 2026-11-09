import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pill, useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase, errText, invokeFn } from '../../lib/supabase';
import { buildPdf, imageToJpeg, isPdf, mb, readBytes } from '../../lib/pdf';
import { fmtStamp } from '../../lib/officer';
import type { ReconRow } from '../../lib/hall';

const ISSUE = ['crit', 'high', 'med'];

const WHY: Record<string, string> = {
  'Unregistered candidate': 'A script or scan exists for someone who is not on this session’s candidate list.',
  'Absent but script exists': 'Attendance says absent, yet a script or scan was recorded for this candidate.',
  'Attendance not marked': 'The candidate was registered after the session closed, so there is no attendance mark.',
  'Integrity failure': 'The archived scan no longer matches its SHA-256 fingerprint — the file was altered or corrupted.',
  'Missing script and scan': 'Marked present, but no physical script was checked in and nothing was scanned.',
  'Missing physical script': 'A scan exists but the physical booklet was never checked in.',
  'Duplicate scan': 'More than one active scan is on record for this candidate.',
  'Missing scan': 'The physical script was received but never scanned.',
};

interface Scan { file_id: string; file_no: number; version: number; original_name: string; uploaded_at: string; uploaded_by_name: string; ok: boolean | null }
interface Limits { max_file_mb: number; allow_pdf_upload: boolean; allow_photo_snaps: boolean }

/**
 * Resolving = correcting the record. Each step below changes the real data (attendance, script check-in,
 * scans, registration) through an audited server function; once the record reconciles clean the
 * resolution is logged automatically. Closing without a fix needs an explanation.
 */
export function FixModal({ sid, code, live, row: initial, onClose, onDone }: {
  sid: string; code: string; live: boolean; row: ReconRow; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const { session: auth } = useAuth();
  const [row, setRow] = useState(initial);
  const [scans, setScans] = useState<Scan[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [note, setNote] = useState('');
  const [loc, setLoc] = useState('Exams office');
  const [done, setDone] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [explain, setExplain] = useState(false);
  const [exAct, setExAct] = useState('Escalated to department');

  const loadScans = async () => {
    const { data } = await supabase.rpc('candidate_scans', { p_session: sid, p_student: initial.student_id });
    setScans((data ?? []) as Scan[]);
  };
  useEffect(() => {
    loadScans();
    supabase.from('settings').select('max_file_mb, allow_pdf_upload, allow_photo_snaps').single().then(({ data }) => setLimits(data as Limits | null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- load once for this candidate

  const needNote = () => {
    if (note.trim().length < 5) { setErr('First say why the record is being corrected (at least 5 characters).'); return false; }
    return true;
  };

  /** Run one correction, then re-read the record. Clean → log the resolution and close. */
  async function step(label: string, run: () => PromiseLike<{ error: unknown }> | Promise<void>) {
    if (!needNote()) return;
    setBusy(true); setErr('');
    try {
      const res = await run();
      if (res && (res as { error: unknown }).error) throw (res as { error: unknown }).error;
      const steps = [...done, label];
      setDone(steps);
      const { data, error } = await supabase.rpc('reconcile_session', { p_session: sid });
      if (error) throw error;
      const next = (data as ReconRow[]).find((x) => x.student_id === initial.student_id);
      await loadScans();
      if (next && ISSUE.includes(next.severity)) { setRow(next); toast(`${label} — ${next.outcome} still to fix`); return; }
      const r = await supabase.rpc('resolve_discrepancy', {
        p_session: sid, p_student: initial.student_id, p_outcome: initial.outcome,
        p_action: 'Corrected: ' + steps.join('; '), p_note: note.trim(),
      });
      if (r.error) throw r.error;
      toast(`Fixed — record now ${next?.outcome ?? 'clear'}. Resolution logged.`);
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const fix = {
    register: () => step('registered for the session', () => supabase.rpc('fix_register_candidate', { p_session: sid, p_student: row.student_id, p_note: note.trim() })),
    attend: (present: boolean) => step(present ? 'attendance marked present' : 'attendance marked absent',
      () => supabase.rpc('fix_attendance', { p_session: sid, p_student: row.student_id, p_present: present, p_note: note.trim() })),
    checkIn: () => {
      if (loc.trim().length < 2) { setErr('Say where the script is now.'); return; }
      return step(`script located at ${loc.trim()} and checked in`,
        () => supabase.rpc('fix_check_in_script', { p_session: sid, p_student: row.student_id, p_location: loc.trim(), p_note: note.trim() }));
    },
    withdraw: (s: Scan) => step(`duplicate scan F${String(s.file_no).padStart(4, '0')} withdrawn`,
      () => supabase.rpc('withdraw_scan', { p_file: s.file_id, p_note: note.trim() })),
    upload: (files: FileList | null, rescan: boolean) => {
      const list = [...(files ?? [])];
      if (!list.length || !auth) return;
      return step(rescan ? 'rescanned — new version uploaded' : 'scan uploaded', async () => {
        const maxBytes = (limits?.max_file_mb ?? 20) * 1048576;
        let bytes: Uint8Array, method: 'pdf' | 'snap', pages: number | null = null;
        if (list.length === 1 && !list[0].type.startsWith('image/')) {
          bytes = await readBytes(list[0]);
          if (!isPdf(bytes)) throw new Error(`“${list[0].name}” is not a PDF`);
          method = 'pdf';
        } else {
          const imgs = list.filter((f) => f.type.startsWith('image/'));
          if (!imgs.length) throw new Error('Choose a PDF or photos of the pages');
          const jp = [];
          for (const f of imgs) jp.push(await imageToJpeg(f));
          bytes = buildPdf(jp); method = 'snap'; pages = jp.length;
        }
        if (bytes.length > maxBytes) throw new Error(`The file is ${mb(bytes.length)} — the limit is ${limits?.max_file_mb ?? 20} MB`);
        const path = `incoming/${auth.user.id}/${crypto.randomUUID()}.pdf`;
        const up = await supabase.storage.from('scans').upload(path, new Blob([bytes as BlobPart], { type: 'application/pdf' }), { contentType: 'application/pdf' });
        if (up.error) throw up.error;
        await invokeFn('register-file', {
          kind: 'script', path, name: `${code.replace(' ', '')}_${row.matric_no.replace(/\//g, '-')}.pdf`,
          session_id: sid, student_id: row.student_id, method, pages, rescan,
        });
      });
    },
  };

  async function closeWithExplanation() {
    if (note.trim().length < 10) { setErr('Explain why this is being closed without a fix (at least 10 characters).'); return; }
    setBusy(true); setErr('');
    const { error } = await supabase.rpc('resolve_discrepancy', { p_session: sid, p_student: row.student_id, p_outcome: row.outcome, p_action: exAct, p_note: note.trim() });
    setBusy(false);
    if (error) { setErr(errText(error)); return; }
    toast(exAct === 'Escalated to department' ? 'Escalated and logged — the record is unchanged' : 'Closed with explanation and logged');
    onDone();
  }

  const canUpload = limits ? (limits.allow_pdf_upload || limits.allow_photo_snaps) : true;
  const uploader = (label: string, rescan: boolean) => !canUpload
    ? <div className="banner warn small">Both capture methods are turned off in system settings.</div>
    : <label className="btn sm" style={{ cursor: busy ? 'default' : 'pointer' }}>
        <input type="file" accept="application/pdf,.pdf,image/*" multiple style={{ display: 'none' }} disabled={busy}
          onChange={(e) => { fix.upload(e.target.files, rescan); e.target.value = ''; }} />
        {label}
      </label>;

  // the steps this record still needs, worked out from its current state (order matters: the server
  // only accepts a scan for someone present or with a script checked in)
  const steps: { title: string; body?: ReactNode; actions: ReactNode }[] = [];
  if (!row.is_registered) steps.push({
    title: 'Register the candidate for this session',
    body: 'Do this if they genuinely sat this paper (e.g. left off the import). If the script belongs to another paper, escalate instead.',
    actions: <button className="btn sm pri" disabled={busy} onClick={fix.register}>Register</button>,
  });
  else if (row.present !== true && (row.has_physical || row.n_scans > 0)) steps.push({
    title: 'Correct attendance',
    body: 'A script exists, so they were most likely in the hall. Check the attendance sheet before changing it.',
    actions: <button className="btn sm pri" disabled={busy} onClick={() => fix.attend(true)}>Mark present</button>,
  });
  else if (row.present == null) steps.push({
    title: 'Mark attendance',
    actions: <><button className="btn sm pri" disabled={busy} onClick={() => fix.attend(true)}>Mark present</button>{' '}
      <button className="btn sm" disabled={busy} onClick={() => fix.attend(false)}>Mark absent</button></>,
  });
  else if (row.present === true) {
    if (!row.has_physical) steps.push({
      title: 'Check in the physical script',
      body: <>Once the booklet is located, record where it is now.
        {row.n_scans === 0 && <> If the candidate actually did not sit the paper, <button className="link" disabled={busy} onClick={() => fix.attend(false)}>mark them absent</button> instead.</>}</>,
      actions: <span className="row" style={{ gap: 6 }}>
        <input className="input" style={{ width: 170 }} value={loc} maxLength={80} onChange={(e) => setLoc(e.target.value)} aria-label="Where the script is now" />
        <button className="btn sm pri" disabled={busy} onClick={fix.checkIn}>Check in</button>
      </span>,
    });
    if (row.integrity_bad) steps.push({
      title: 'Rescan the script',
      body: 'Scan the physical booklet again. The failed version is kept in the archive as an older, inactive version.',
      actions: uploader('Upload rescan', true),
    });
    else if (row.n_scans === 0) steps.push({
      title: 'Upload the scan',
      body: 'A PDF from the scanner, or photos of every page in order (merged into one PDF).',
      actions: uploader('Upload scan', false),
    });
    else if (row.n_scans > 1) steps.push({
      title: 'Withdraw the extra scan',
      body: 'Keep the correct one. Withdrawn scans stay in the archive as inactive — nothing is deleted.',
      actions: null,
    });
  }

  return (
    <Modal onClose={onClose}>
      <h3>Fix: <Pill sev={row.severity}>{row.outcome}</Pill></h3>
      <p className="muted small">{row.matric_no} · {row.full_name} · {code}{!live && ' · session closed'}</p>
      {WHY[row.outcome] && <p className="small" style={{ marginTop: 6 }}>{WHY[row.outcome]}</p>}

      <textarea className="input" rows={2} style={{ width: '100%', marginTop: 10 }} maxLength={500}
        placeholder="Reason for the correction (e.g. found in Hall B box; confirmed on attendance sheet)" value={note}
        onChange={(e) => { setNote(e.target.value); setErr(''); }} aria-label="Reason for the correction" />

      {done.length > 0 && <div className="small" style={{ margin: '10px 0' }}>
        {done.map((d) => <div key={d}><span className="tick">✓</span> {d}</div>)}
      </div>}

      {steps.length > 0 && <div style={{ marginTop: 10 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>{done.length ? 'Still to do' : 'To fix this record'}</div>
        {steps.map((s, i) => (
          <div key={s.title} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
            <div className="row between" style={{ gap: 10, flexWrap: 'wrap' }}>
              <b className="small">{i + 1}. {s.title}</b>
              {s.actions}
            </div>
            {s.body && <div className="small muted" style={{ marginTop: 6 }}>{s.body}</div>}
          </div>
        ))}
      </div>}

      {(row.n_scans > 1 || row.integrity_bad) && scans.length > 0 && <div style={{ marginTop: 6 }}>
        <div className="small muted" style={{ marginBottom: 4 }}>Active scans</div>
        {scans.map((s) => (
          <div key={s.file_id} className="row between small" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)', gap: 8 }}>
            <span><span className="mono">F{String(s.file_no).padStart(4, '0')}</span> v{s.version} · {fmtStamp(s.uploaded_at)} · {s.uploaded_by_name}
              {s.ok === false && <> · <span className="cross">fingerprint fail</span></>}</span>
            {row.n_scans > 1 && <button className="btn sm" disabled={busy} onClick={() => fix.withdraw(s)}>Withdraw</button>}
          </div>
        ))}
      </div>}

      {busy && <div className="small muted" style={{ marginTop: 8 }}>Working…</div>}
      <div className="err" role="alert">{err}</div>

      <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        {!explain
          ? <button className="link small" onClick={() => setExplain(true)}>Can’t be fixed? Escalate or close with an explanation</button>
          : <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="input" value={exAct} onChange={(e) => setExAct(e.target.value)} aria-label="Why it is closed without a fix">
                <option>Escalated to department</option>
                <option>Accepted — explained in note</option>
              </select>
              <button className="btn" disabled={busy} onClick={closeWithExplanation}>Close without fixing</button>
              <div className="small muted" style={{ flexBasis: '100%' }}>The record stays as it is; the reason above is kept on the record and in the audit log.</div>
            </div>}
      </div>

      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={done.length ? onDone : onClose}>{done.length ? 'Done for now' : 'Cancel'}</button>
      </div>
    </Modal>
  );
}

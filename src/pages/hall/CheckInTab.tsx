import { useRef, useState, type FormEvent } from 'react';
import { useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { fmtTime, matchRow } from '../../lib/hall';
import { QrScanner, type ScanResult } from '../../components/QrScanner';
import type { TabProps } from './Hall';

export function CheckInTab({ d, live, reload }: TabProps) {
  const s = d.session, auto = s.attendance_mode === 'submission';
  const toast = useToast();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(false);
  const [scanned, setScanned] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // present but no script yet; in submission mode also anyone registered who hasn't handed in
  const waiting = d.rows.filter((r) => r.is_registered && !r.has_physical && (r.present === true || (auto && r.present !== false)));
  const shown = waiting.filter((r) => matchRow({ ...r, script_code: r.script_code ?? d.labels[r.student_id] ?? null }, q));
  const nameOf = (code: string) => d.rows.find((r) => r.student_id && (d.labels[r.student_id] === code.toUpperCase() || r.script_code === code.toUpperCase()));

  function submit() {
    // a single live match means the invigilator has narrowed it to one person — check them in;
    // otherwise send what was typed (a full student ID, a script ID, or someone not in the list)
    checkIn(q.trim() && shown.length === 1 ? shown[0].matric_no : q);
  }

  async function checkIn(raw: string, fromCamera = false): Promise<ScanResult | undefined> {
    const v = raw.trim();
    if (!v) return;
    if (v.length > 60) { const m = 'That code is too long to be a script ID'; if (!fromCamera) toast(m); return { ok: false, text: m }; }
    setBusy(true);
    const { data, error } = await supabase.rpc('check_in_script', { p_session: s.id, p_identifier: v })
      .single<{ script_code: string; registered: boolean }>();
    setBusy(false);
    if (error) {
      if (!fromCamera) { toast(errText(error)); input.current?.select(); }
      return { ok: false, text: `${v}: ${errText(error)}` };
    }
    const who = nameOf(data!.script_code)?.full_name;
    const msg = data!.registered ? `✓ ${data!.script_code}${who ? ` · ${who}` : ''} — submitted` : `${data!.script_code}: not registered for ${s.course_code} — checked in and flagged`;
    if (!fromCamera) { toast(msg); setQ(''); input.current?.focus(); } else setScanned((n) => n + 1);
    reload();
    return { ok: data!.registered, text: msg };
  }

  return (
    <div className="grid g2">
      <div className="card">
        <div className="row between"><h3 style={{ margin: 0 }}>Check in a script</h3>
          <button className="btn pri" disabled={!live} onClick={() => { setScanned(0); setCamera(true); }}>Scan QR labels</button>
        </div>
        <div className="small muted" style={{ marginBottom: 10 }}>
          <div style={{ margin: '6px 0' }}>After the paper, <b>scan the QR label on each booklet</b> — that confirms the script is submitted.
          If a label won't scan, type the ID instead.</div>
          Type the student ID (e.g. BU/24C/IT/10778) or script ID (student ID + course code, e.g. BU/24C/IT/10778-CSC409). The script ID is created here, when the booklet is handed in.
          {auto && <b> Checking in also marks the student present.</b>}
        </div>
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); submit(); }}>
          <input ref={input} className="input" type="search" style={{ flex: 1 }} placeholder="Student ID, script ID or name" value={q} maxLength={40}
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQ(''); }}
            disabled={!live || busy} aria-label="Student ID, script ID or name" autoFocus autoComplete="off" />
          <button className="btn pri" disabled={!live || busy}>{q.trim() && shown.length === 1 ? `Check in ${shown[0].full_name.split(' ')[0]}` : 'Check in'}</button>
        </form>
        <h3 style={{ marginTop: 18 }}>Still to hand in <span className="muted small">· {q.trim() ? `${shown.length} of ${waiting.length}` : waiting.length}</span></h3>
        {shown.map((r) => (
          <div key={r.student_id} className="row between" style={{ padding: '7px 0', borderBottom: '1px solid #eef1f4' }}>
            <span><span className="mono">{r.matric_no}</span> · {r.full_name}</span>
            {live && <button className="btn sm" disabled={busy} onClick={() => checkIn(r.matric_no)}>Check in</button>}
          </div>
        ))}
        {!waiting.length && <div className="muted small">Everyone present has handed in.</div>}
        {waiting.length > 0 && !shown.length && <div className="muted small">Nobody waiting matches “{q.trim()}”. Press Check in to look it up anyway (e.g. a script ID).</div>}
      </div>
      {camera && <QrScanner title={`Scan booklets · ${s.course_code}`} onClose={() => setCamera(false)}
        hint={<>Hold each booklet's QR label inside the frame. Each one is checked in as soon as it is read. {scanned > 0 && <b>{scanned} checked in this round · {waiting.length} still to hand in.</b>}</>}
        onCode={(code) => checkIn(code, true)} />}
      <div className="card">
        <h3>Recently checked in</h3>
        {d.recent.map((x) => (
          <div key={x.script_code} style={{ padding: '7px 0', borderBottom: '1px solid #eef1f4' }}>
            <b className="small">{x.students?.full_name}</b> <span className="mono muted">{x.script_code}</span>
            <div className="small muted">{fmtTime(x.created_at)}</div>
          </div>
        ))}
        {!d.recent.length && <div className="muted small">No scripts checked in yet.</div>}
      </div>
    </div>
  );
}

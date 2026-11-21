import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useParams } from 'react-router';
import { PageTop } from '../../components/Shell';
import { useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { useAuth } from '../../lib/auth';
import { fmtDate, matchRow, type ExamSession } from '../../lib/hall';
import { qrSvg } from '../../lib/qr';

interface LabelRow { student_id: string; matric_no: string; full_name: string; script_code: string; checked_in: boolean }

const PER_PAGE = 24;

/**
 * QR labels for every registered candidate, printed before the exam and pasted on each booklet.
 * The QR holds the script ID (student ID + course code). Opening this page creates any missing codes;
 * every print is written to the audit log.
 */
export function Labels() {
  const { id } = useParams();
  const toast = useToast();
  const { profile } = useAuth();
  const [session, setSession] = useState<ExamSession | null>(null);
  const [rows, setRows] = useState<LabelRow[] | null>(null);
  const [svgs, setSvgs] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    (async () => {
      const [s, l] = await Promise.all([
        supabase.from('exam_sessions').select('*').eq('id', id).single<ExamSession>(),
        supabase.rpc('script_labels', { p_session: id }),
      ]);
      if (s.error) { setErr(errText(s.error)); return; }
      if (l.error) { setErr(errText(l.error)); setSession(s.data); return; }
      const list = (l.data ?? []) as LabelRow[];
      setSession(s.data); setRows(list);
      setPicked(new Set(list.filter((r) => !r.checked_in).map((r) => r.student_id)));
      const pairs = await Promise.all(list.map(async (r) => [r.student_id, await qrSvg(r.script_code)] as const));
      setSvgs(Object.fromEntries(pairs));
    })().catch((e) => setErr(errText(e)));
  }, [id]);

  const chosen = useMemo(() => (rows ?? []).filter((r) => picked.has(r.student_id)), [rows, picked]);
  const pages = useMemo(() => {
    const out: LabelRow[][] = [];
    for (let i = 0; i < chosen.length; i += PER_PAGE) out.push(chosen.slice(i, i + PER_PAGE));
    return out;
  }, [chosen]);
  const shown = (rows ?? []).filter((r) => matchRow(r, q));
  const back = profile?.role === 'officer' ? `/sessions/${id}` : '/hall';

  function toggle(sid: string) {
    setPicked((p) => { const n = new Set(p); if (n.has(sid)) n.delete(sid); else n.add(sid); return n; });
  }

  async function print() {
    if (!chosen.length || !id) return;
    setBusy(true);
    const { error } = await supabase.rpc('record_label_print', { p_session: id, p_students: chosen.map((r) => r.student_id) });
    setBusy(false);
    if (error) { toast(errText(error)); return; }
    window.print();
  }

  if (err) return <><PageTop title="QR labels" /><div className="content"><div className="banner crit">{err}</div><p><Link to={back}>Back</Link></p></div></>;
  if (!session || !rows) return <><PageTop title="QR labels" /><div className="content muted">Loading…</div></>;

  const sheet = (list: LabelRow[], key: number) => (
    <div className="label-sheet" key={key}>
      {list.map((r) => (
        <div className="label" key={r.student_id}>
          <div className="qr" dangerouslySetInnerHTML={{ __html: svgs[r.student_id] ?? '' }} />
          <div className="txt">
            <div className="course">{session.course_code}</div>
            <div className="sid">{r.matric_no}</div>
            <div className="name">{r.full_name}</div>
            <div className="meta">{fmtDate(session.exam_date)} · {session.venue}</div>
            <div className="code">{r.script_code}</div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <PageTop title="QR labels" sub={`${session.course_code} ${session.course_title} · ${session.venue} · ${fmtDate(session.exam_date)}`}
        actions={<>
          <Link className="btn" to={session.status === 'scheduled' ? back : `/hall/${session.id}`}>{session.status === 'scheduled' ? 'Back' : 'Back to hall'}</Link>
          <button className="btn pri" disabled={busy || !chosen.length || Object.keys(svgs).length < rows.length} onClick={print}>
            Print {chosen.length} label{chosen.length === 1 ? '' : 's'}
          </button>
        </>} />
      <div className="content">
        <div className="banner info" style={{ marginBottom: 16 }}>
          Print on A4 sticker sheets (3 × 8 labels, 70 × 37 mm) at <b>100% scale, no margins</b>. Paste each label on the
          candidate's booklet before the paper starts. After the exam, scan each booklet's QR in <b>Script check-in</b>.
          Every print is recorded in the audit log.
        </div>
        {!rows.length && <div className="banner warn">No candidates are registered for this session yet. The exams office registers candidates.</div>}
        {rows.length > 0 && <div className="grid g21">
          <div className="card">
            <h3>Preview <span className="muted small">· {pages.length} page{pages.length === 1 ? '' : 's'}</span></h3>
            <div className="sheet-wrap">{pages.length ? pages.map(sheet) : <div className="small muted">Choose the labels to print.</div>}</div>
          </div>
          <div className="card">
            <h3>Candidates <span className="muted small">· {chosen.length} of {rows.length} chosen</span></h3>
            <div className="row" style={{ marginBottom: 10, gap: 6 }}>
              <input className="input" type="search" style={{ flex: 1 }} placeholder="Find a student" value={q} maxLength={40}
                onChange={(e) => setQ(e.target.value)} aria-label="Find a student" />
              <button className="btn sm" onClick={() => setPicked(new Set(rows.map((r) => r.student_id)))}>All</button>
              <button className="btn sm" onClick={() => setPicked(new Set())}>None</button>
            </div>
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {shown.map((r) => (
                <label key={r.student_id} className="row small" style={{ padding: '6px 0', borderBottom: '1px solid #eef1f4', gap: 8 }}>
                  <input type="checkbox" checked={picked.has(r.student_id)} onChange={() => toggle(r.student_id)} />
                  <span style={{ flex: 1 }}><span className="mono">{r.matric_no}</span> · {r.full_name}</span>
                  {r.checked_in && <span className="pill p-ok">checked in</span>}
                </label>
              ))}
              {!shown.length && <div className="small muted">Nobody matches “{q.trim()}”.</div>}
            </div>
            <div className="legend" style={{ marginTop: 8 }}>Candidates whose script is already checked in start unticked. Tick one to reprint a damaged label.</div>
          </div>
        </div>}
      </div>
      {createPortal(<div className="print-only">{pages.map(sheet)}</div>, document.body)}
    </>
  );
}

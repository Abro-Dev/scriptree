import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { PageTop } from '../../components/Shell';
import { Modal, useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { fmtDate, type ExamSession } from '../../lib/hall';

const STATUS: Record<ExamSession['status'], [string, string]> = {
  scheduled: ['Scheduled', 'p-pend'], live: ['Live', 'p-live'], closed: ['Closed', 'p-ok'],
};

/** The invigilator's assigned sessions. Opens straight into the hall when exactly one is live. */
export function HallList() {
  const [list, setList] = useState<ExamSession[] | null>(null);
  const [err, setErr] = useState('');
  const [opening, setOpening] = useState<ExamSession | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const toast = useToast();

  useEffect(() => {
    supabase.from('exam_sessions').select('*').order('exam_date', { ascending: false }).order('start_time').returns<ExamSession[]>()
      .then(({ data, error }) => (error ? setErr(error.message) : setList(data ?? [])));
  }, []);

  // first visit this browser session with exactly one live session → straight into the hall
  const live = list?.filter((s) => s.status === 'live') ?? [];
  const autoOpen = live.length === 1 && !sessionStorage.getItem('hall-auto-opened');
  useEffect(() => { if (autoOpen) sessionStorage.setItem('hall-auto-opened', '1'); }, [autoOpen]);
  if (autoOpen) return <Navigate to={`/hall/${live[0].id}`} replace />;

  async function open(s: ExamSession) {
    setBusy(true);
    const { error } = await supabase.rpc('start_session', { p_session: s.id });
    setBusy(false);
    if (error) { toast(errText(error)); return; }
    toast(`${s.course_code} is live`);
    nav(`/hall/${s.id}`);
  }

  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <PageTop title="Exam hall" sub="Sessions assigned to you" />
      <div className="content">
        {err && <div className="banner crit">{err}</div>}
        {!list && !err && <div className="muted">Loading…</div>}
        {list && !list.length && <div className="banner info">No exam sessions are assigned to you yet. The exams office assigns invigilators when it creates a session.</div>}
        {list && list.length > 0 && <div className="card table-scroll"><table>
          <thead><tr><th>Course</th><th>Date</th><th>Time</th><th>Venue</th><th>Status</th><th /></tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s.id} className={s.status === 'scheduled' ? '' : 'click'} onClick={() => s.status !== 'scheduled' && nav(`/hall/${s.id}`)}>
              <td><b>{s.course_code}</b> <span className="muted">{s.course_title}</span></td>
              <td>{fmtDate(s.exam_date)}{s.exam_date === today && <span className="pill p-med" style={{ marginLeft: 8 }}>Today</span>}</td>
              <td>{s.start_time.slice(0, 5)}</td>
              <td>{s.venue}</td>
              <td><span className={`pill ${STATUS[s.status][1]}`}>{STATUS[s.status][0]}</span></td>
              <td className="num">{s.status === 'scheduled'
                ? <button className="btn sm pri" onClick={(e) => { e.stopPropagation(); setOpening(s); }}>Open session</button>
                : <button className="btn sm">{s.status === 'live' ? 'Go to hall' : 'View'}</button>}</td>
            </tr>))}
          </tbody></table></div>}
      </div>
      {opening && <Modal onClose={() => setOpening(null)}>
        <h3>Open {opening.course_code}?</h3>
        <p className="small muted">{opening.course_title} · {opening.venue} · {fmtDate(opening.exam_date)} {opening.start_time.slice(0, 5)}. Opening the session lets you take attendance, check in scripts and scan them. The exams office sees counts live.</p>
        {opening.exam_date !== today && <div className="banner warn" style={{ marginTop: 10 }}>This session is not scheduled for today.</div>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={() => setOpening(null)}>Cancel</button>
          <button className="btn pri" disabled={busy} onClick={() => open(opening)}>{busy ? 'Opening…' : 'Open session'}</button>
        </div>
      </Modal>}
    </>
  );
}

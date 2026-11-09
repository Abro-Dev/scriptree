import { PageTop } from '../../components/Shell';
import { Pill } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { studentStatus, type MyDoc, type MyExam } from '../../lib/student';
import { fetchDocTypes } from '../../lib/queries';

const Yes = ({ v }: { v: boolean | null }) => v === true ? <span className="tick">✓</span> : v === false ? <span className="cross">✕</span> : <span className="dash">—</span>;

function Booklet() {
  return (
    <svg width="150" height="120" viewBox="0 0 150 120" aria-hidden="true" style={{ position: 'relative' }}>
      <circle cx="96" cy="58" r="56" fill="#1a2f7d" />
      <g transform="translate(26 14) rotate(-8 45 50)">
        <rect width="84" height="100" rx="10" fill="#fff" /><rect width="16" height="100" rx="8" fill="#ffc83d" /><rect x="8" width="8" height="100" fill="#ffc83d" />
        <rect x="26" y="12" width="48" height="18" rx="5" fill="#e8edff" />
        <g stroke="#dfe5f7" strokeWidth="2"><line x1="26" y1="44" x2="74" y2="44" /><line x1="26" y1="56" x2="74" y2="56" /><line x1="26" y1="68" x2="74" y2="68" /><line x1="26" y1="80" x2="60" y2="80" /></g>
      </g>
      <circle cx="118" cy="92" r="17" fill="#21a67a" /><path d="M110 92 l6 6 l10 -11" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MyExams() {
  const { student } = useAuth();
  const { data, error } = useLoad(async () => {
    const [exams, docs, types] = await Promise.all([
      supabase.rpc('my_exams').then((r) => must(r) as MyExam[]),
      supabase.rpc('my_documents').then((r) => must(r) as MyDoc[]),
      fetchDocTypes(),
    ]);
    return { exams, docs, types };
  }, []);

  const sub = student ? `${student.full_name} · ${student.matric_no} · Student ID ${student.student_code} · ${student.department} · ${student.level}` : '';
  if (error) return <><PageTop title="My exams" sub={sub} /><div className="content"><div className="banner crit">{error}</div></div></>;
  if (!data) return <><PageTop title="My exams" sub={sub} /><div className="content muted">Loading…</div></>;

  const sat = data.exams.filter((e) => e.status !== 'scheduled' && e.present !== false);
  const okN = data.exams.filter((e) => e.severity === 'ok').length;
  const revN = data.exams.filter((e) => ['crit', 'high', 'med'].includes(e.severity) && !e.resolved).length;
  const req = data.types.filter((t) => t.required);
  const dv = req.filter((t) => data.docs.some((d) => d.doc_type === t.id && d.status === 'verified')).length;

  return (
    <>
      <PageTop title="My exams" sub={sub} />
      <div className="content">
        <div className="card" style={{ background: 'var(--cobalt)', color: '#fff', display: 'grid', gridTemplateColumns: '1fr auto', gap: 20, alignItems: 'center', marginBottom: 18, overflow: 'hidden', position: 'relative' }}>
          <div style={{ position: 'relative' }}>
            <div style={{ fontFamily: 'var(--display)', fontSize: 24, fontWeight: 700 }}>Hi {student?.full_name.split(' ')[0]}</div>
            <div style={{ color: '#c9d4ff', margin: '4px 0 16px' }}>Here's where your exam scripts and documents stand this semester.</div>
            <div className="row" style={{ gap: 10 }}>
              <span className="pill" style={{ background: '#fff', color: 'var(--cobalt)' }}>{sat.length} exam{sat.length === 1 ? '' : 's'} sat</span>
              <span className="pill" style={{ background: 'var(--mint-l)', color: '#147455' }}>{okN} records complete</span>
              {revN > 0 && <span className="pill" style={{ background: 'var(--sun)', color: '#18203a' }}>{revN} under review</span>}
              <span className="pill" style={{ background: 'var(--coral-l)', color: '#c4321d' }}>{dv} of {req.length} documents verified</span>
            </div>
          </div>
          <Booklet />
        </div>

        <div className="card" style={{ overflowX: 'auto' }}>
          <h3>My exams this semester</h3>
          <table>
            <thead><tr><th>Course</th><th>Date</th><th>Attendance</th><th>Script handed in</th><th>Scanned</th><th>Record status</th></tr></thead>
            <tbody>
              {data.exams.map((e) => {
                const [sev, label] = studentStatus(e);
                return (
                  <tr key={e.session_id}>
                    <td><b>{e.course_code}</b> <span className="muted">{e.course_title}</span></td>
                    <td>{e.exam_date}<div className="small muted">{e.venue}</div></td>
                    <td><Yes v={e.status === 'scheduled' ? null : e.present} /></td>
                    <td><Yes v={e.status === 'scheduled' ? null : e.has_physical} />{e.has_physical && e.script_code && <> <span className="mono muted">{e.script_code}</span></>}</td>
                    <td>{e.n_scans ? <span className="tick">✓</span> : <span className="dash">—</span>}</td>
                    <td><Pill sev={sev}>{label}</Pill></td>
                  </tr>
                );
              })}
              {!data.exams.length && <tr><td colSpan={6} className="muted">You're not registered for any exams yet. Your department sends the registration list to the exams office.</td></tr>}
            </tbody>
          </table>
          <div className="legend" style={{ marginTop: 10 }}>If a record is under review, the exams office has been alerted and will resolve it. You don't need to do anything unless contacted.</div>
        </div>
      </div>
    </>
  );
}

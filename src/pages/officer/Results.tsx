import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { PageTop } from '../../components/Shell';
import { Pill } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fetchGradeBands } from '../../lib/queries';
import { fmtStamp } from '../../lib/officer';
import { fmtPct, fmtScore, letter, pct, type GradeBand, type ResultsSession, type ScoreboardRow } from '../../lib/grading';
import type { Student } from '../../lib/types';

type Filter = 'all' | 'grading' | 'ready' | 'published';

function stage(r: ResultsSession): [Filter, string, string] {
  if (r.results_status === 'published') return ['published', 'Published', 'p-ok'];
  if (r.eligible > 0 && r.ungraded === 0) return ['ready', 'Ready to publish', 'p-live'];
  return ['grading', r.eligible ? `${r.graded} of ${r.eligible} graded` : 'Nothing gradeable yet', 'p-pend'];
}

/** Grading progress for every closed session, and any student's scoreboard. Officers grade; admins can look. */
export function Results() {
  const [params, setParams] = useSearchParams();
  const view = params.get('student') != null ? 'student' : 'sessions';
  return (
    <>
      <PageTop title="Results" sub="Grade scripts, release results and look up any student's scores" />
      <div className="content">
        <div className="seg" role="tablist" style={{ marginBottom: 16 }}>
          <button role="tab" aria-selected={view === 'sessions'} className={view === 'sessions' ? 'on' : ''} onClick={() => setParams({})}>Sessions</button>
          <button role="tab" aria-selected={view === 'student'} className={view === 'student' ? 'on' : ''} onClick={() => setParams({ student: params.get('student') ?? '' })}>Student scoreboard</button>
        </div>
        {view === 'sessions' ? <SessionsView /> : <StudentView q={params.get('student') ?? ''} onSearch={(v) => setParams({ student: v })} />}
      </div>
    </>
  );
}

function SessionsView() {
  const nav = useNavigate();
  const { profile } = useAuth();
  const [filter, setFilter] = useState<Filter>('all');
  const { data, error } = useLoad(async () => must(await supabase.rpc('results_overview')) as ResultsSession[], []);
  if (error) return <div className="banner crit">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const count = (f: Filter) => data.filter((r) => stage(r)[0] === f).length;
  const shown = filter === 'all' ? data : data.filter((r) => stage(r)[0] === filter);
  const open = (id: string) => nav(`/sessions/${id}?tab=grading`);
  const canOpen = profile?.role === 'officer';

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All closed ({data.length})</button>
        <button className={`chip ${filter === 'grading' ? 'on' : ''}`} onClick={() => setFilter('grading')}>Grading ({count('grading')})</button>
        <button className={`chip ${filter === 'ready' ? 'on' : ''}`} onClick={() => setFilter('ready')}>Ready to publish ({count('ready')})</button>
        <button className={`chip ${filter === 'published' ? 'on' : ''}`} onClick={() => setFilter('published')}>Published ({count('published')})</button>
      </div>
      <table>
        <thead><tr><th>Course</th><th>Exam</th><th className="num">Out of</th><th>Graded</th><th className="num">On hold</th><th className="num">Average</th><th>Status</th></tr></thead>
        <tbody>
          {shown.map((r) => {
            const [, label, cls] = stage(r);
            const p = r.eligible ? Math.round((r.graded / r.eligible) * 100) : 0;
            return (
              <tr key={r.id} style={canOpen ? { cursor: 'pointer' } : undefined} tabIndex={canOpen ? 0 : undefined}
                onClick={canOpen ? () => open(r.id) : undefined} onKeyDown={canOpen ? (e) => e.key === 'Enter' && open(r.id) : undefined}>
                <td><b>{r.course_code}</b> <span className="muted">{r.course_title}</span></td>
                <td>{r.exam_date}<div className="small muted">{r.venue}</div></td>
                <td className="num">{fmtScore(r.max_score)}</td>
                <td style={{ minWidth: 140 }}><div className="small">{r.graded} / {r.eligible}</div><div className="bar"><i style={{ width: `${p}%`, background: 'var(--ok)' }} /></div></td>
                <td className="num">{r.withheld || <span className="dash">—</span>}</td>
                <td className="num">{r.avg_pct == null ? <span className="dash">—</span> : `${r.avg_pct}%`}</td>
                <td><span className={`pill ${cls}`}>{label}</span>{r.results_published_at && <div className="small muted">{fmtStamp(r.results_published_at)}</div>}</td>
              </tr>
            );
          })}
          {!shown.length && <tr><td colSpan={7} className="muted">{data.length ? 'No sessions match this filter.' : 'No closed sessions yet. A session can be graded once the invigilator closes it.'}</td></tr>}
        </tbody>
      </table>
      <div className="legend" style={{ marginTop: 10 }}>On hold: scripts received whose record isn't clean yet (an open or escalated discrepancy). They can't be graded, and their results stay withheld.</div>
    </div>
  );
}

interface Board { student: Student; rows: ScoreboardRow[]; bands: GradeBand[] }

function StudentView({ q, onSearch }: { q: string; onSearch: (v: string) => void }) {
  const [input, setInput] = useState(q);
  const { data, error } = useLoad(async (): Promise<Board | 'none' | 'idle'> => {
    if (!q) return 'idle';
    const id = must(await supabase.rpc('resolve_identifier', { p_q: q, p_session: null })) as string | null;
    if (!id) return 'none';
    const [st, rows, bands] = await Promise.all([
      supabase.from('students').select('id, matric_no, full_name, department, level').eq('id', id).single().then((r) => must(r) as Student),
      supabase.rpc('student_scoreboard', { p_student: id }).then((r) => must(r) as ScoreboardRow[]),
      fetchGradeBands(),
    ]);
    return { student: st, rows, bands };
  }, [q]);

  function go(e: FormEvent) { e.preventDefault(); onSearch(input.trim().slice(0, 40)); }

  return (
    <>
      <form className="card row" style={{ gap: 8, marginBottom: 16 }} onSubmit={go}>
        <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Student ID (BU/24C/IT/10778) or script code" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Student ID or script code" />
        <button className="btn pri">Look up</button>
      </form>
      {error && <div className="banner crit">{error}</div>}
      {data === 'none' && <div className="banner warn">No student or script matches “{q}”.</div>}
      {q && data === null && !error && <div className="muted">Loading…</div>}
      {data && typeof data === 'object' && <Scoreboard b={data} />}
    </>
  );
}

function Scoreboard({ b }: { b: Board }) {
  const nav = useNavigate();
  const { profile } = useAuth();
  const courses = new Map<string, ScoreboardRow[]>();
  for (const r of b.rows) courses.set(r.course_code, [...(courses.get(r.course_code) ?? []), r]);
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0 }}>{b.student.full_name}</h3>
        <div className="small muted">Student ID <span className="mono">{b.student.matric_no}</span> · {b.student.department} · {b.student.level}</div>
      </div>
      {!b.rows.length && <div className="card muted">Not registered for any exams yet.</div>}
      {[...courses.entries()].map(([code, rs]) => {
        const counted = rs.filter((r) => r.eligible && r.score != null);
        const tot = counted.reduce((a, r) => a + Number(r.score), 0), max = counted.reduce((a, r) => a + Number(r.max_score), 0);
        const p = max ? pct(tot, max) : null;
        return (
          <div key={code} className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
            <div className="row between" style={{ marginBottom: 8 }}>
              <div><b>{code}</b> <span className="muted">{rs[0].course_title}</span></div>
              {p != null && <div><b>{fmtScore(Math.round(tot * 100) / 100)} / {fmtScore(max)}</b> · {fmtPct(p)} · <span className="pill p-live">{letter(p, b.bands)}</span></div>}
            </div>
            <table>
              <thead><tr><th>Exam</th><th>Script</th><th>Record</th><th className="num">Score</th><th>Release</th><th>Graded</th></tr></thead>
              <tbody>
                {rs.map((r) => (
                  <tr key={r.session_id}>
                    <td>{r.exam_date}<div className="small muted">{r.venue}</div></td>
                    <td className="mono">{r.script_code ?? <span className="dash">—</span>}</td>
                    <td>{r.session_status !== 'closed' ? <Pill sev="pend">Session {r.session_status}</Pill>
                      : r.eligible ? <Pill sev="ok">Clean</Pill> : <Pill sev={r.severity === 'info' ? 'info' : r.severity}>{r.hold_reason ?? r.outcome}</Pill>}</td>
                    <td className="num">{r.score == null ? <span className="dash">—</span>
                      : <span style={r.eligible ? undefined : { textDecoration: 'line-through' }}>{fmtScore(r.score)} / {fmtScore(r.max_score)}</span>}</td>
                    <td>{r.results_status === 'published' ? <span className="pill p-ok">Published</span> : <span className="pill p-pend">Draft</span>}</td>
                    <td className="small muted">{r.graded_at ? <>{r.graded_by_name} · {fmtStamp(r.graded_at)}</> : ''}
                      {profile?.role === 'officer' && r.session_status === 'closed' && <> <button className="btn sm" onClick={() => nav(`/sessions/${r.session_id}?tab=grading`)}>Open</button></>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {b.rows.length > 0 && <div className="legend">Course totals add up every clean, graded paper for the course, published or not. Students see only published results.</div>}
    </>
  );
}

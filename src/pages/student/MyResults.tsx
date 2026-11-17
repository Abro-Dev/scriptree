import { PageTop } from '../../components/Shell';
import { Pill } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fetchGradeBands } from '../../lib/queries';
import { courseTotals, fmtPct, fmtScore, letter, pct, STATE_LABEL, type MyResult } from '../../lib/grading';

/** The student's scoreboard: every exam they sat, one card per course, with a score per script once released. */
export function MyResults() {
  const { student } = useAuth();
  const { data, error } = useLoad(async () => {
    const [rows, bands] = await Promise.all([
      supabase.rpc('my_results').then((r) => must(r) as MyResult[]),
      fetchGradeBands(),
    ]);
    return { rows, bands };
  }, []);

  const sub = student ? `${student.full_name} · Student ID ${student.matric_no}` : '';
  if (error) return <><PageTop title="My results" sub={sub} /><div className="content"><div className="banner crit">{error}</div></div></>;
  if (!data) return <><PageTop title="My results" sub={sub} /><div className="content muted">Loading…</div></>;

  const courses = courseTotals(data.rows);
  const released = data.rows.filter((r) => r.state === 'graded').length;
  const waiting = data.rows.filter((r) => r.state === 'not_released' || r.state === 'awaiting').length;
  const all = courses.filter((c) => c.max > 0);
  const overall = all.length ? pct(all.reduce((a, c) => a + c.score, 0), all.reduce((a, c) => a + c.max, 0)) : null;

  return (
    <>
      <PageTop title="My results" sub={sub} />
      <div className="content">
        <div className="band">
          <div className="kpi"><div className="lab">Results released</div><div className="val">{released}</div><div className="note">across {all.length} course{all.length === 1 ? '' : 's'}</div></div>
          <div className="kpi"><div className="lab">Waiting for release</div><div className="val">{waiting}</div><div className="note">the exams office publishes each paper when grading is done</div></div>
          <div className="kpi"><div className="lab">Average so far</div><div className="val">{overall == null ? '—' : fmtPct(overall)}</div>
            <div className="note">{overall == null ? 'no results yet' : `grade ${letter(overall, data.bands)} on released papers`}</div></div>
        </div>

        {courses.map((c) => {
          const p = c.max ? pct(c.score, c.max) : null;
          return (
            <div key={c.course_code} className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
              <div className="row between" style={{ marginBottom: 8, gap: 10 }}>
                <div><h3 style={{ margin: 0 }}>{c.course_code}</h3><div className="small muted">{c.course_title}</div></div>
                {p != null
                  ? <div style={{ textAlign: 'right' }}>
                      <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>{fmtPct(p)} <span className="pill p-live" style={{ fontSize: 14 }}>{letter(p, data.bands)}</span></div>
                      <div className="small muted">{fmtScore(Math.round(c.score * 100) / 100)} of {fmtScore(c.max)} marks{c.counted < c.papers.length ? ` · ${c.counted} of ${c.papers.length} papers` : ''}</div>
                    </div>
                  : <Pill sev="pend">No result yet</Pill>}
              </div>
              <table>
                <thead><tr><th>Exam</th><th>Script</th><th className="num">Score</th><th className="num">%</th><th>Grade</th></tr></thead>
                <tbody>
                  {c.papers.map((r) => {
                    const scored = r.state === 'graded' && r.score != null;
                    const pp = scored ? pct(r.score!, r.max_score) : 0;
                    const [sev, label] = scored ? ['ok', ''] as const : STATE_LABEL[r.state as Exclude<typeof r.state, 'graded'>];
                    return (
                      <tr key={r.session_id}>
                        <td>{r.exam_date}</td>
                        <td className="mono">{r.script_code ?? <span className="dash">—</span>}</td>
                        {scored
                          ? <><td className="num"><b>{fmtScore(r.score)}</b> / {fmtScore(r.max_score)}</td><td className="num">{fmtPct(pp)}</td><td>{letter(pp, data.bands)}</td></>
                          : <td colSpan={3}><Pill sev={sev}>{label}</Pill></td>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}
        {!courses.length && <div className="card muted">No results yet. Once an exam you sat is closed and graded, the exams office publishes it and your score appears here.</div>}
        {courses.length > 0 && <div className="legend">
          Course totals add up the marks of every released paper for the course. Grades: {[...data.bands].sort((a, b) => b.min - a.min).map((b) => `${b.grade} ${b.min}%+`).join(' · ')}.
          A withheld result is being checked by the exams office; it appears here once the check is finished.
        </div>}
      </div>
    </>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { Modal, Pill, useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp } from '../../lib/officer';
import { downloadCsvFile, parseCsv, toScores, type ScoreRow } from '../../lib/csv';
import { fmtScore, parseScore, type SheetRow } from '../../lib/grading';

export interface GradingSession {
  id: string; course_code: string; course_title: string; exam_date: string; venue: string;
  max_score: number; results_status: 'draft' | 'published'; results_published_at: string | null;
}

type Filter = 'todo' | 'graded' | 'hold' | 'all';
type CellState = { saving?: boolean; err?: string; ok?: boolean };

/**
 * Grading for one closed session. Only scripts whose record is clean can take a score; everything else shows
 * why it is on hold. Enter saves and moves to the next score; leaving a changed box saves it too.
 */
export function GradingTab({ s, onChanged }: { s: GradingSession; onChanged: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, reload } = useLoad(async () => must(await supabase.rpc('grading_sheet', { p_session: s.id })) as SheetRow[], [s.id]);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [cell, setCell] = useState<Record<string, CellState>>({});
  const [filter, setFilter] = useState<Filter>('todo');
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  // last saved score per candidate, updated synchronously so Enter-then-blur never saves (or asks for a reason) twice
  const savedRef = useRef<Record<string, number | null>>({});
  const inFlight = useRef(new Set<string>());
  const published = s.results_status === 'published';
  const max = Number(s.max_score);

  useEffect(() => {
    if (!data) return;
    setRows(data);
    savedRef.current = Object.fromEntries(data.map((r) => [r.student_id, r.score == null ? null : Number(r.score)]));
    setDraft(Object.fromEntries(data.map((r) => [r.student_id, r.score == null ? '' : fmtScore(r.score)])));
  }, [data]);

  if (error) return <div className="banner crit">{error}</div>;
  if (!data) return <div className="muted">Loading the grading sheet…</div>;

  const withScript = rows.filter((r) => r.script_id);
  const eligible = rows.filter((r) => r.eligible);
  const graded = eligible.filter((r) => r.score != null);
  const hold = withScript.filter((r) => !r.eligible);
  const noScript = rows.filter((r) => !r.script_id);
  const todo = eligible.filter((r) => r.score == null);
  const pctDone = eligible.length ? Math.round((graded.length / eligible.length) * 100) : 0;

  const needle = q.trim().toUpperCase();
  const shown = rows
    .filter((r) => filter === 'all' ? true : filter === 'todo' ? r.eligible && r.score == null
      : filter === 'graded' ? r.score != null : !!r.script_id && !r.eligible)
    .filter((r) => !needle || r.matric_no.includes(needle) || (r.script_code ?? '').toUpperCase().includes(needle) || r.full_name.toUpperCase().includes(needle));

  async function save(r: SheetRow): Promise<boolean> {
    if (inFlight.current.has(r.student_id)) return false;
    const raw = (draft[r.student_id] ?? '').trim();
    const prev = savedRef.current[r.student_id] ?? null;
    const before = prev == null ? '' : fmtScore(prev);
    if (raw === before || (raw !== '' && prev != null && Number(raw) === prev)) return true;
    let score: number | null = null;
    if (raw !== '') {
      const v = parseScore(raw, max);
      if (typeof v === 'string') { setCell((c) => ({ ...c, [r.student_id]: { err: v } })); return false; }
      score = v;
    }
    let reason: string | null = null;
    if (published && prev != null) {
      reason = prompt(`Results are published. ${r.script_code}: change ${fmtScore(prev)} → ${score == null ? 'no score' : fmtScore(score)}.\nSay why (it goes in the audit log and the student's grade history):`);
      if (reason == null) { setDraft((d) => ({ ...d, [r.student_id]: before })); return false; }
      if (reason.trim().length < 5) { setCell((c) => ({ ...c, [r.student_id]: { err: 'Give a reason (at least 5 characters)' } })); return false; }
    }
    setCell((c) => ({ ...c, [r.student_id]: { saving: true } }));
    inFlight.current.add(r.student_id);
    const { error } = await supabase.rpc('grade_script', { p_session: s.id, p_student: r.student_id, p_score: score, p_reason: reason?.trim().slice(0, 300) ?? null });
    inFlight.current.delete(r.student_id);
    if (error) { setCell((c) => ({ ...c, [r.student_id]: { err: errText(error) } })); return false; }
    savedRef.current[r.student_id] = score;
    setRows((rs) => rs.map((x) => x.student_id === r.student_id ? { ...x, score, graded_at: new Date().toISOString(), graded_by_name: 'You' } : x));
    setCell((c) => ({ ...c, [r.student_id]: { ok: true } }));
    return true;
  }

  function next(e: KeyboardEvent<HTMLInputElement>, r: SheetRow) {
    if (e.key === 'Escape') { const p = savedRef.current[r.student_id]; setDraft((d) => ({ ...d, [r.student_id]: p == null ? '' : fmtScore(p) })); return; }
    if (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const inputs = [...(tableRef.current?.querySelectorAll<HTMLInputElement>('input[data-score]') ?? [])];
    const i = inputs.indexOf(e.currentTarget);
    const go = () => inputs[e.key === 'ArrowUp' ? i - 1 : i + 1]?.focus();
    if (e.key === 'Enter') void save(r).then((ok) => ok && go()); else go();
  }

  function downloadSheet() {
    downloadCsvFile(`${s.course_code.replace(' ', '')}-${s.exam_date}-scores.csv`, [
      ['script_code', 'student_id', 'full_name', `score (out of ${fmtScore(max)})`],
      ...eligible.map((r) => [r.script_code ?? '', r.matric_no, r.full_name, r.score == null ? '' : fmtScore(r.score)]),
    ]);
  }

  async function changeMax() {
    const v = prompt(`Mark ${s.course_code} out of how many marks?`, fmtScore(max));
    if (v == null) return;
    const n = Number(v.trim());
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(v.trim()) || n < 1) { toast('Enter a number from 1 to 999'); return; }
    const { error } = await supabase.rpc('set_max_score', { p_session: s.id, p_max: n });
    if (error) { toast(errText(error)); return; }
    toast(`${s.course_code} is now marked out of ${fmtScore(n)}`);
    onChanged();
  }

  async function publish() {
    const msg = `Publish ${s.course_code} results for ${s.venue}?\n\n${graded.length} student${graded.length === 1 ? '' : 's'} will see their score and get an email (the email has no mark in it).`
      + (hold.length ? `\n${hold.length} result${hold.length === 1 ? ' is' : 's are'} withheld because the record is under review. They appear once the record is cleared and graded.` : '');
    if (!confirm(msg)) return;
    setBusy(true);
    const { data: r, error } = await supabase.rpc('publish_results', { p_session: s.id }).single<{ graded: number; withheld: number; notified: number }>();
    setBusy(false);
    if (error) { toast(errText(error)); return; }
    toast(`Published: ${r!.graded} results released, ${r!.notified} students emailed`);
    onChanged(); window.dispatchEvent(new Event('alerts-changed'));
  }

  async function withdraw() {
    const why = prompt(`Withdraw ${s.course_code} results?\nStudents stop seeing their scores until you publish again. Say why (it goes in the audit log):`);
    if (why == null) return;
    if (why.trim().length < 5) { toast('Give a reason (at least 5 characters)'); return; }
    const { error } = await supabase.rpc('unpublish_results', { p_session: s.id, p_reason: why.trim().slice(0, 300) });
    if (error) { toast(errText(error)); return; }
    toast('Results withdrawn');
    onChanged();
  }

  return (
    <>
      {published
        ? <div className="banner ok" style={{ marginBottom: 16 }}><b>Results published {fmtStamp(s.results_published_at)}.</b> Students can see their scores. Changing a score now needs a reason, and the student sees the new score straight away.
            {todo.length > 0 && <> {todo.length} script{todo.length === 1 ? ' has' : 's have'} become gradeable since. Grade {todo.length === 1 ? 'it' : 'them'} and the student sees the result.</>}</div>
        : <div className="banner info" style={{ marginBottom: 16 }}><b>Grading.</b> Only scripts whose record is clean can be graded: reconciled as complete, or a discrepancy you accepted with an explanation. Fix or accept the others on the Reconciliation tab first. Students see nothing until you publish.</div>}

      <div className="funnel" style={{ marginBottom: 16 }}>
        <div><div className="lab">Gradeable scripts</div><div className="val">{eligible.length}</div><div className="gap muted">of {withScript.length} scripts received</div></div>
        <div><div className="lab">Graded</div><div className="val">{graded.length}</div>
          <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${pctDone}%`, background: 'var(--ok)' }} /></div></div>
        <div><div className="lab">On hold</div><div className="val">{hold.length}</div><div className="gap muted">record not clean yet</div></div>
        <div><div className="lab">No script</div><div className="val">{noScript.length}</div><div className="gap muted">absent or never handed in</div></div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="row between" style={{ marginBottom: 12, gap: 10 }}>
          <div className="row" style={{ gap: 6 }}>
            <button className={`chip ${filter === 'todo' ? 'on' : ''}`} onClick={() => setFilter('todo')}>To grade ({todo.length})</button>
            <button className={`chip ${filter === 'graded' ? 'on' : ''}`} onClick={() => setFilter('graded')}>Graded ({rows.filter((r) => r.score != null).length})</button>
            <button className={`chip ${filter === 'hold' ? 'on' : ''}`} onClick={() => setFilter('hold')}>On hold ({hold.length})</button>
            <button className={`chip ${filter === 'all' ? 'on' : ''}`} onClick={() => setFilter('all')}>All ({rows.length})</button>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <input className="input" style={{ width: 200 }} placeholder="Script code, ID or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a script" />
            <span className="small muted">Out of <b>{fmtScore(max)}</b></span>
            {!published && <button className="btn sm" onClick={changeMax}>Change</button>}
          </div>
        </div>
        <div className="row" style={{ gap: 6, marginBottom: 12 }}>
          <button className="btn sm" disabled={!eligible.length} onClick={downloadSheet}>⬇ Score sheet (CSV)</button>
          <button className="btn sm" disabled={!eligible.length} onClick={() => setImporting(true)}>Import scores</button>
          <span style={{ flex: 1 }} />
          {published
            ? <button className="btn sm danger" onClick={withdraw}>Withdraw results</button>
            : <button className="btn sm pri" disabled={busy || !graded.length || todo.length > 0} title={todo.length ? `${todo.length} gradeable scripts still have no score` : undefined} onClick={publish}>
                {busy ? 'Publishing…' : todo.length ? `Publish (${todo.length} to grade)` : 'Publish results'}</button>}
        </div>
        <table ref={tableRef}>
          <thead><tr><th>Script</th><th>Student ID</th><th>Candidate</th><th>Record</th><th className="num">Score</th><th>Graded</th></tr></thead>
          <tbody>
            {shown.map((r) => {
              const st = cell[r.student_id];
              return (
                <tr key={r.student_id}>
                  <td className="mono">{r.script_code ?? <span className="dash">—</span>}</td>
                  <td className="mono">{r.matric_no}</td>
                  <td>{r.full_name}</td>
                  <td>{r.eligible
                    ? <Pill sev="ok">{r.severity === 'ok' ? 'Complete' : 'Accepted'}</Pill>
                    : <Pill sev={r.severity === 'info' ? 'info' : r.severity}>{r.hold_reason ?? r.outcome}</Pill>}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {r.eligible
                      ? <input data-score className="input" inputMode="decimal" style={{ width: 82, textAlign: 'right' }}
                          aria-label={`Score for ${r.script_code}`} value={draft[r.student_id] ?? ''} disabled={st?.saving}
                          onChange={(e) => { setDraft((d) => ({ ...d, [r.student_id]: e.target.value })); setCell((c) => ({ ...c, [r.student_id]: {} })); }}
                          onKeyDown={(e) => next(e, r)} onBlur={() => void save(r)} />
                      : r.score != null ? <span title="Scored, but hidden from the student while the record is on hold" style={{ textDecoration: 'line-through' }} className="muted">{fmtScore(r.score)}</span>
                      : <span className="dash">—</span>}
                    {r.eligible && <span className="small muted"> / {fmtScore(max)}</span>}
                    {st?.saving && <div className="small muted">Saving…</div>}
                    {st?.ok && <div className="small" style={{ color: 'var(--ok)' }}>Saved</div>}
                    {st?.err && <div className="small" style={{ color: 'var(--crit)', whiteSpace: 'normal', maxWidth: 220 }}>{st.err}</div>}
                  </td>
                  <td className="small muted">{r.graded_at ? <>{r.graded_by_name}<br />{fmtStamp(r.graded_at)}</> : ''}
                    {!r.eligible && r.script_id && <button className="btn sm" onClick={() => nav(`/tracker?q=${encodeURIComponent(r.matric_no)}&session=${s.id}`)}>Trace</button>}</td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={6} className="muted">{filter === 'todo' && eligible.length ? 'Every gradeable script has a score.' : 'No scripts match.'}</td></tr>}
          </tbody>
        </table>
        <div className="legend" style={{ marginTop: 10 }}>Enter saves and moves to the next script, ↑/↓ move without saving, and Esc undoes your typing. Clear a box to remove a score.</div>
      </div>
      {importing && <ImportScoresModal s={s} onClose={() => { setImporting(false); reload(); }} />}
    </>
  );
}

interface ImportResult { saved: number; changed: number; unchanged: number; skipped: { ref: string; reason: string }[] }

function ImportScoresModal({ s, onClose }: { s: GradingSession; onClose: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<ScoreRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const published = s.results_status === 'published';

  async function pick(file?: File) {
    setErr(''); setRows(null); setResult(null);
    if (!file) return;
    if (file.size > 2 * 1048576) return setErr('CSV must be under 2 MB.');
    const parsed = toScores(parseCsv(await file.text()));
    if (parsed.error) return setErr(parsed.error);
    if (parsed.rows.length > 5000) return setErr('At most 5000 rows per import.');
    setFileName(file.name); setRows(parsed.rows);
  }

  const withScore = (rows ?? []).filter((r) => r.score);
  async function run() {
    if (!rows) return;
    if (published && reason.trim().length < 5) return setErr('Results are published: say why scores are changing.');
    setBusy(true); setErr('');
    const { data, error } = await supabase.rpc('import_grades', { p_session: s.id, p_rows: withScore, p_reason: published ? reason.trim().slice(0, 300) : null }).single<ImportResult>();
    setBusy(false);
    if (error) return setErr(errText(error));
    setResult(data);
    toast(`${data!.saved + data!.changed} scores saved`);
  }

  return (
    <Modal onClose={onClose}>
      <h3>Import scores for {s.course_code}</h3>
      <p className="muted small">
        Download the score sheet, fill in the <span className="mono">score</span> column (0 to {fmtScore(s.max_score)}) and upload it here. Rows are matched by
        <span className="mono"> script_code</span> or <span className="mono">student_id</span>. Empty scores are skipped (a file never removes a score), and scripts that are on hold are refused.
      </p>
      {!result && <label className="drop" style={{ margin: '4px 0 10px' }}>
        <input type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
        {fileName ? <><b>{fileName}</b> · {rows?.length ?? 0} rows, {withScore.length} with a score</> : <>Drop CSV here or <b>browse</b></>}
      </label>}
      {published && !result && <input className="input" style={{ width: '100%', marginBottom: 10 }} maxLength={300} placeholder="Why are published scores changing? (goes in the audit log)"
        value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for changing published scores" />}
      {result && <div className="banner ok" style={{ marginBottom: 10 }}>
        <b>{result.saved} graded</b>{result.changed ? `, ${result.changed} changed` : ''}{result.unchanged ? `, ${result.unchanged} unchanged` : ''}.
        {result.skipped.length > 0 && <div style={{ marginTop: 6, maxHeight: 180, overflow: 'auto' }}>
          <b>{result.skipped.length} skipped:</b>
          {result.skipped.map((x, i) => <div key={i} className="small"><span className="mono">{x.ref || '(blank)'}</span>: {x.reason}</div>)}
        </div>}
      </div>}
      <div className="err" role="alert">{err}</div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onClose}>{result ? 'Done' : 'Cancel'}</button>
        {!result && <button className="btn pri" disabled={!withScore.length || busy} onClick={run}>{busy ? 'Importing…' : `Import ${withScore.length} scores`}</button>}
      </div>
    </Modal>
  );
}

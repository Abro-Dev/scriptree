import { useEffect, useState } from 'react';
import { useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { ATT_MODES, fmtTime, type AttMode } from '../../lib/hall';
import type { TabProps } from './Hall';

export function AttendanceTab({ d, live, reload }: TabProps) {
  const s = d.session, mode = s.attendance_mode;
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const [hc, setHc] = useState(d.counts.headcount?.toString() ?? '');
  useEffect(() => { setHc(d.counts.headcount?.toString() ?? ''); }, [d.counts.headcount]);

  const regs = d.rows.filter((r) => r.is_registered);

  async function call(fn: string, args: Record<string, unknown>, key: string) {
    setSaving(key);
    const { error } = await supabase.rpc(fn, args);
    setSaving(null);
    if (error) toast(errText(error));
    await reload();
  }

  function saveHeadcount() {
    const v = hc.trim();
    if (v === (d.counts.headcount?.toString() ?? '')) return;
    if (!/^\d{1,4}$/.test(v)) { toast('Headcount must be a whole number'); setHc(d.counts.headcount?.toString() ?? ''); return; }
    call('set_headcount', { p_session: s.id, p_count: Number(v) }, 'hc').then(() => toast('Headcount recorded'));
  }

  return (
    <div className="card">
      <div className="row between" style={{ marginBottom: 12 }}>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>When is attendance taken for this session?</div>
          <div className="seg">
            {(Object.keys(ATT_MODES) as AttMode[]).map((k) => (
              <button key={k} className={mode === k ? 'on' : ''} disabled={!live || saving !== null}
                onClick={() => mode !== k && call('set_attendance_mode', { p_session: s.id, p_mode: k }, 'mode')}>{ATT_MODES[k]}</button>
            ))}
          </div>
        </div>
        <div className="row">
          <label className="small" htmlFor="hc">Headcount</label>
          <input id="hc" className="input" type="number" min={0} max={9999} style={{ width: 90 }} value={hc} disabled={!live}
            onChange={(e) => setHc(e.target.value)} onBlur={saveHeadcount} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </div>
      </div>
      <div className="banner info" style={{ marginBottom: 12 }}>
        {mode === 'submission'
          ? <><b>At script submission:</b> a student is ticked present automatically when their script is checked in (tab 2). You can still tick manually here, e.g. if a student hands in a blank booklet.</>
          : <><b>{ATT_MODES[mode]}:</b> tick each student present from the paper sheet{mode === 'start' ? ' once everyone is seated' : ' as they leave the hall'}. The headcount is kept as a cross-check.</>}
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr><th>#</th><th>Student ID</th><th>Candidate</th><th>Present</th><th>Ticked</th><th>Script ID</th></tr></thead>
          <tbody>
            {regs.map((r, i) => {
              const m = d.marks[r.student_id];
              return (
                <tr key={r.student_id}>
                  <td className="muted">{i + 1}</td>
                  <td className="mono">{r.matric_no}</td>
                  <td>{r.full_name}</td>
                  <td><input type="checkbox" aria-label={`${r.full_name} present`} checked={r.present === true}
                    disabled={!live || saving === r.student_id}
                    onChange={(e) => call('mark_attendance', { p_session: s.id, p_student: r.student_id, p_present: e.target.checked }, r.student_id)} /></td>
                  <td className="small muted">{m ? (m.present ? `${ATT_MODES[m.mode].replace('At ', 'at ')} · ${fmtTime(m.marked_at)}` : 'marked absent') : ''}</td>
                  <td className="mono muted">{r.script_code}</td>
                </tr>
              );
            })}
            {!regs.length && <tr><td colSpan={7} className="muted">No candidates registered. The exams office imports the list.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

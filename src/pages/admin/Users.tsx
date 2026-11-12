import { useState, type FormEvent } from 'react';
import { PageTop } from '../../components/Shell';
import { Modal, Pill, useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase, errText, invokeFn } from '../../lib/supabase';
import { useLoad } from '../../lib/useLoad';
import { fmtStamp } from '../../lib/officer';
import { isEmail } from '../../lib/validate';
import type { Role } from '../../lib/types';
import { downloadStudentTemplate } from '../../lib/csv';
import { AddStudentModal, ImportStudentsModal } from './StudentModals';
import { SITE_URL } from '../../lib/site';

interface StaffRow { id: string; role: Role; full_name: string; email: string; title: string | null; status: 'active' | 'suspended'; last_sign_in_at: string | null; mfa: boolean; invited_pending: boolean }
interface ListResult { staff: StaffRow[]; students: { total: number; with_account: number } }
interface Slip { matric_no: string; full_name: string; password: string; email?: string | null; emailed?: boolean }
interface IssueResult { slips: Slip[]; failed: { matric_no: string; reason: string }[]; more: boolean; remaining?: number; email_problem?: string | null }

const ROLE_PILL: Record<string, [string, string]> = { admin: ['Admin', 'p-info'], officer: ['Exams Officer', 'p-live'], invigilator: ['Invigilator', 'p-pend'] };
const PERMS: [string, number, number, number, number][] = [
  ['Manage user accounts and roles', 1, 0, 0, 0], ['System settings', 1, 0, 0, 0], ['View full audit log', 1, 1, 0, 0],
  ['Add students to the roster', 1, 1, 0, 0], ['Give students sign-in access', 1, 0, 0, 0],
  ['Create sessions, import candidates', 0, 1, 0, 0], ['Run reconciliation, resolve discrepancies', 0, 1, 0, 0],
  ['Verify student documents', 0, 1, 0, 0], ['Tick attendance, check in scripts', 0, 0, 1, 0], ['Upload PDF / photo snaps', 0, 0, 1, 0],
  ['View own exams and script status', 0, 0, 0, 1], ['Upload own documents', 0, 0, 0, 1],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Print one cut-out slip per student in a new window. Nothing is stored — the passwords exist only on paper. */
function printSlips(slips: Slip[]) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return false;
  const origin = esc(SITE_URL);
  w.document.write(`<!doctype html><html><head><title>ScripTree sign-in slips</title><style>
    body{font-family:system-ui,sans-serif;margin:16px;color:#18203a} .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .slip{border:1.5px dashed #8189a3;border-radius:10px;padding:12px 14px;break-inside:avoid}
    .slip b{font-size:15px} .pw{font-family:ui-monospace,monospace;font-size:18px;letter-spacing:1px;margin:6px 0}
    .s{font-size:12px;color:#4a5372} @media print{body{margin:0}}</style></head><body>
    <div class="grid">${slips.map((x) => `<div class="slip"><b>${esc(x.full_name)}</b><div class="s">Student ID ${esc(x.matric_no)}</div>
    <div class="s" style="margin-top:8px">One-time password</div><div class="pw">${esc(x.password)}</div>
    <div class="s">Sign in at ${origin} → Student, with your student ID. You'll choose your own password straight away.</div></div>`).join('')}
    </div><script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
  return true;
}

function downloadCsv(slips: Slip[]) {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const csv = ['student_id,full_name,email,emailed,one_time_password',
    ...slips.map((s) => [s.matric_no, s.full_name, s.email ?? '', s.emailed ? 'yes' : 'no', s.password].map(q).join(','))].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `scriptree-student-passwords-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function Users() {
  const toast = useToast();
  const { profile } = useAuth();
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<IssueResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lookup, setLookup] = useState('');
  const [studentModal, setStudentModal] = useState<'add' | 'import' | null>(null);
  const { data, error, reload } = useLoad(() => invokeFn<ListResult>('admin-users', { action: 'list' }), []);

  async function act(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try { await fn(); toast(ok); await reload(); } catch (e) { toast(errText(e)); } finally { setBusy(null); }
  }
  const rpc = async (name: string, args: Record<string, unknown>) => { const { error } = await supabase.rpc(name, args); if (error) throw error; };

  async function issue(ids?: string[]) {
    setBusy('issue');
    try {
      const r = await invokeFn<IssueResult>('admin-users', { action: 'issue_student_passwords', ...(ids ? { student_ids: ids } : {}) });
      if (!r.slips.length && !r.failed.length) toast('Every student already has a sign-in account');
      else setIssued(r);
      reload();
    } catch (e) { toast(errText(e)); } finally { setBusy(null); }
  }

  async function resetOne(e: FormEvent) {
    e.preventDefault();
    const v = lookup.trim().toUpperCase();
    if (!v) return;
    const { data: st, error } = await supabase.from('students').select('id').eq('matric_no', v.toUpperCase()).maybeSingle();
    if (error) { toast(errText(error)); return; }
    if (!st) { toast('No student with that student ID'); return; }
    await issue([st.id]); setLookup('');
  }

  const staff = data?.staff ?? [];
  const count = (r: Role) => staff.filter((u) => u.role === r).length;
  const without = data ? data.students.total - data.students.with_account : 0;

  return (
    <>
      <PageTop title="Users & roles" sub="Every role signs in separately" />
      <div className="content">
        {error && <div className="banner crit" style={{ marginBottom: 16 }}>{error}</div>}
        <div className="band">
          {([['Admin', count('admin'), 'staff email + 2FA'], ['Exams officers', count('officer'), 'staff email + 2FA'], ['Invigilators', count('invigilator'), 'staff email'],
            ['Students', data?.students.total ?? '…', `by student ID · ${data?.students.with_account ?? '…'} with accounts`]] as [string, number | string, string][]).map(([l, n, w]) =>
            <div key={l} className="kpi"><div className="lab">{l}</div><div className="val">{n}</div><div className="note">Sign in: {w}</div></div>)}
        </div>

        <div className="card" style={{ marginBottom: 16, overflowX: 'auto' }}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Staff accounts</h3>
            <button className="btn pri sm" onClick={() => setAdding(true)}>+ Add staff account</button>
          </div>
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
            <tbody>
              {staff.map((u) => {
                const self = u.id === profile?.id;
                return (
                  <tr key={u.id}>
                    <td><b>{u.full_name}</b>{u.title && <div className="small muted">{u.title}</div>}</td>
                    <td className="small">{u.email}</td>
                    <td>{self ? <span className={`pill ${ROLE_PILL[u.role][1]}`}>{ROLE_PILL[u.role][0]}</span>
                      : <select className="input" style={{ padding: '3px 8px' }} value={u.role} disabled={busy !== null} aria-label={`Role for ${u.full_name}`}
                          onChange={(e) => act(u.id, () => rpc('set_staff_role', { p_user: u.id, p_role: e.target.value }), 'Role changed')}>
                          <option value="invigilator">Invigilator</option><option value="officer">Exams Officer</option><option value="admin">Admin</option>
                        </select>}</td>
                    <td>{u.mfa ? <span className="tick">✓</span> : <span className="dash">—</span>}</td>
                    <td className="small muted">{u.invited_pending ? 'Invite not accepted yet' : fmtStamp(u.last_sign_in_at)}</td>
                    <td>{u.status === 'active' ? <Pill sev="ok">Active</Pill> : <Pill sev="crit">Suspended</Pill>}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      {!self && u.mfa && <><button className="btn sm" disabled={busy !== null} title="For a lost phone — they set up two-factor again at next sign-in"
                        onClick={() => confirm(`Remove ${u.full_name}'s two-factor? They'll set it up again at next sign-in.`) && act(u.id, () => invokeFn('admin-users', { action: 'reset_mfa', user_id: u.id }), 'Two-factor reset')}>Reset 2FA</button>{' '}</>}
                      {!self && <button className={`btn sm ${u.status === 'active' ? 'danger' : ''}`} disabled={busy !== null}
                        onClick={() => act(u.id, () => rpc('set_account_status', { p_user: u.id, p_status: u.status === 'active' ? 'suspended' : 'active' }), u.status === 'active' ? 'Account suspended' : 'Account reactivated')}>
                        {u.status === 'active' ? 'Suspend' : 'Reactivate'}</button>}
                    </td>
                  </tr>
                );
              })}
              {!data && !error && <tr><td colSpan={7} className="muted">Loading…</td></tr>}
            </tbody>
          </table>
          <div className="legend" style={{ marginTop: 10 }}>A suspended account keeps its history but the database grants it nothing until reactivated.</div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row between" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
            <h3 style={{ margin: 0 }}>Students</h3>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={downloadStudentTemplate}>⬇ CSV template</button>
              <button className="btn sm" onClick={() => setStudentModal('import')}>Import students (CSV)</button>
              <button className="btn pri sm" onClick={() => setStudentModal('add')}>+ Add student</button>
            </div>
          </div>
          <div className="small" style={{ color: 'var(--ink2)', marginBottom: 12 }}>
            Add students one at a time or from a CSV. The exams office's candidate import also adds new students.
            Giving a student access emails them a one-time password at the address on record. Anyone without an email gets a printable slip instead.
            They choose their own password at first sign-in. Passwords aren't stored anywhere you can see them again.
          </div>
          {data && (without > 0
            ? <button className="btn pri" disabled={busy !== null} onClick={() => issue()}>{busy === 'issue' ? 'Creating…' : `Create accounts for ${Math.min(without, 500)} student${without === 1 ? '' : 's'} without one`}</button>
            : <div className="banner ok">Every student on record has a sign-in account.</div>)}
        </div>

        <div className="grid g2" style={{ marginBottom: 16 }}>
          <div className="card">
            <h3>Reset a student's password</h3>
            <div className="small muted" style={{ marginBottom: 10 }}>For a forgotten password. Emails them a new one-time password (or gives you a slip) and asks them to choose a new one.</div>
            <form className="row" onSubmit={resetOne}>
              <input className="input" style={{ flex: 1 }} placeholder="Student ID, e.g. BU/24C/IT/10778" maxLength={40} value={lookup} onChange={(e) => setLookup(e.target.value)} aria-label="Student ID" />
              <button className="btn" disabled={busy !== null}>Issue new password</button>
            </form>
          </div>
        </div>

        <div className="card" style={{ overflowX: 'auto' }}>
          <h3>What each role can do</h3>
          <table>
            <thead><tr><th>Permission</th><th>Admin</th><th>Exams officer</th><th>Invigilator</th><th>Student</th></tr></thead>
            <tbody>{PERMS.map(([p, ...v]) => <tr key={p}><td>{p}</td>{v.map((x, i) => <td key={i}>{x ? <span className="tick">✓</span> : <span className="dash">—</span>}</td>)}</tr>)}</tbody>
          </table>
          <div className="legend" style={{ marginTop: 10 }}>Enforced by the database, not just hidden in the app.</div>
        </div>
      </div>

      {adding && <AddStaffModal onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {studentModal === 'add' && <AddStudentModal onClose={() => setStudentModal(null)}
        onDone={(id) => { setStudentModal(null); if (id) issue([id]); else { toast('Student added'); reload(); } }} />}
      {studentModal === 'import' && <ImportStudentsModal onClose={() => { setStudentModal(null); reload(); }}
        onDone={(accounts) => { setStudentModal(null); if (accounts) issue(); else reload(); }} />}
      {issued && <Modal onClose={() => setIssued(null)}>
        {(() => {
          const sent = issued.slips.filter((s) => s.emailed).length;
          const unsent = issued.slips.filter((s) => !s.emailed);
          return <>
            <h3>{issued.slips.length} student{issued.slips.length === 1 ? '' : 's'} given sign-in access</h3>
            <p className="small muted">
              {sent > 0 && <><b>{sent} emailed</b> their sign-in details. </>}
              {unsent.length > 0 ? <><b>{unsent.length} not emailed</b>: print their slips or download the list now. Once you close this, the passwords can't be shown again (you'd issue new ones).</>
                : 'Nothing else to do.'}
            </p>
            {issued.email_problem && <div className="banner warn" style={{ marginBottom: 10 }}>{issued.email_problem}</div>}
            {issued.failed.length > 0 && <div className="banner crit" style={{ marginBottom: 10 }}>{issued.failed.length} failed: {issued.failed.slice(0, 3).map((f) => `${f.matric_no} (${f.reason})`).join('; ')}</div>}
            {issued.more && <div className="banner warn" style={{ marginBottom: 10 }}>This batch stopped before everyone was reached{issued.remaining ? ` (${issued.remaining} left)` : ''} — run it again for the rest.</div>}
            <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 10 }}>
              <table><tbody>{issued.slips.map((s) => <tr key={s.matric_no}>
                <td className="mono">{s.matric_no}</td><td className="small">{s.full_name}</td>
                <td className="small">{s.emailed ? <span className="tick">✓ emailed</span> : s.email ? <span style={{ color: 'var(--med)' }}>not sent</span> : <span className="muted">no email on record</span>}</td>
                <td className="mono">{s.password}</td></tr>)}</tbody></table>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => downloadCsv(issued.slips)} disabled={!issued.slips.length}>Download CSV</button>
              <button className="btn" onClick={() => printSlips(unsent.length ? unsent : issued.slips) || toast('Allow pop-ups to print slips')} disabled={!issued.slips.length}>
                {unsent.length && sent ? `Print ${unsent.length} unsent slip${unsent.length === 1 ? '' : 's'}` : 'Print slips'}</button>
            </div>
          </>;
        })()}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn pri" onClick={() => (issued.slips.every((s) => s.emailed) || confirm('Close? Passwords that weren’t emailed will not be shown again.')) && setIssued(null)}>Done</button>
        </div>
      </Modal>}
    </>
  );
}

function AddStaffModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', email: '', role: 'invigilator', title: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (f.name.trim().length < 2) return setErr('Enter the full name.');
    if (!isEmail(f.email)) return setErr('Enter a valid staff email.');
    setBusy(true); setErr('');
    try {
      await invokeFn('admin-users', { action: 'invite_staff', full_name: f.name.trim(), email: f.email.trim(), role: f.role, title: f.title.trim() });
      toast('Account created — invite sent'); onDone();
    } catch (ex) { setErr(errText(ex)); } finally { setBusy(false); }
  }
  return (
    <Modal onClose={onClose}>
      <h3>Add staff account</h3>
      <p className="small muted">The person receives an email to set their password. Admins and exams officers set up two-factor on first sign-in.</p>
      <form onSubmit={submit} noValidate>
        <div className="grid g2" style={{ margin: '14px 0' }}>
          <input className="input" placeholder="Full name" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Full name" />
          <input className="input" placeholder="Staff email" maxLength={120} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} aria-label="Staff email" />
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} aria-label="Role">
            <option value="invigilator">Invigilator</option><option value="officer">Exams Officer</option><option value="admin">Admin</option>
          </select>
          <input className="input" placeholder="Title (optional), e.g. Invigilator · Hall D" maxLength={80} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="Title" />
        </div>
        <div className="err" role="alert">{err}</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        </div>
      </form>
    </Modal>
  );
}

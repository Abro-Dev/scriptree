import { useState } from 'react';
import { PageTop } from '../../components/Shell';
import { Modal, Pill, useToast } from '../../components/ui';
import { supabase, errText } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fmtStamp } from '../../lib/officer';
import { fetchStats } from '../../lib/queries';
import { shortHash } from '../../lib/pdf';

type Status = 'pending' | 'verified' | 'rejected';
interface DocRow {
  id: string; status: Status; reason: string | null; created_at: string;
  students: { full_name: string; matric_no: string }; doc_types: { name: string };
  files: { sha256: string; storage_path: string };
}
const PAGE = 40;
const REASONS = ['Scan unreadable — please re-upload', 'Name does not match record', 'Wrong document uploaded'];

export function Documents() {
  const toast = useToast();
  const [f, setF] = useState<Status | 'all'>('pending');
  const [rejecting, setRejecting] = useState<DocRow | null>(null);
  const { data, error, reload } = useLoad(async () => {
    let q = supabase.from('student_documents')
      .select('id, status, reason, created_at, students(full_name, matric_no), doc_types(name), files(sha256, storage_path)', { count: 'exact' })
      .order('created_at', { ascending: f === 'pending' }).limit(PAGE);
    if (f !== 'all') q = q.eq('status', f);
    const [r, stats] = await Promise.all([q, fetchStats()]);
    return { docs: must(r) as unknown as DocRow[], total: r.count ?? 0, stats };
  }, [f]);

  async function verify(d: DocRow) {
    const { error } = await supabase.rpc('decide_document', { p_doc: d.id, p_status: 'verified' });
    if (error) toast(errText(error)); else toast('Document verified');
    reload(); window.dispatchEvent(new Event('alerts-changed'));
  }
  async function withdraw(d: DocRow) {
    const why = prompt(`Withdraw the verification of ${d.doc_types.name} for ${d.students.full_name}?\nThe student sees this reason and is asked to upload again.`);
    if (why == null) return;
    if (why.trim().length < 5) { toast('Give a reason (at least 5 characters)'); return; }
    const { error } = await supabase.rpc('revoke_document_verification', { p_doc: d.id, p_reason: why.trim().slice(0, 180) });
    toast(error ? errText(error) : 'Verification withdrawn — the student can upload again');
    reload(); window.dispatchEvent(new Event('alerts-changed'));
  }
  async function open(d: DocRow) {
    const { data: u, error } = await supabase.storage.from('documents').createSignedUrl(d.files.storage_path, 120);
    if (error) toast(errText(error)); else window.open(u.signedUrl, '_blank', 'noopener');
  }

  const st = data?.stats, cnt = (s: Status) => st?.docs_by_status[s] ?? 0;
  const pct = st && st.students_total ? Math.round((st.students_complete / st.students_total) * 100) : 0;

  return (
    <>
      <PageTop title="Student documents" sub="Verification queue and completeness" />
      <div className="content">
        <div className="band">
          <div className="kpi"><div className="lab">Students with complete files</div><div className="val">{pct}%</div><div className="note">{st?.students_complete ?? '…'} of {st?.students_total ?? '…'}</div></div>
          <div className="kpi"><div className="lab">Awaiting verification</div><div className="val">{cnt('pending')}</div><div className="note">uploaded by students</div></div>
          <div className="kpi"><div className="lab">Verified documents</div><div className="val">{cnt('verified')}</div><div className="note">hashed and preserved</div></div>
          <div className="kpi"><div className="lab">Rejected</div><div className="val">{cnt('rejected')}</div><div className="note">student asked to re-upload</div></div>
        </div>
        {error && <div className="banner crit">{error}</div>}
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="row" style={{ marginBottom: 12 }}>
            {([['pending', 'Awaiting verification'], ['verified', 'Verified'], ['rejected', 'Rejected'], ['all', 'All']] as [Status | 'all', string][]).map(([k, l]) =>
              <button key={k} className={`chip ${f === k ? 'on' : ''}`} onClick={() => setF(k)}>{l}</button>)}
          </div>
          <table>
            <thead><tr><th>Student</th><th>Document</th><th>Uploaded</th><th>SHA-256</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(data?.docs ?? []).map((d) => (
                <tr key={d.id}>
                  <td><b>{d.students.full_name}</b><div className="small muted mono">{d.students.matric_no}</div></td>
                  <td>{d.doc_types.name}</td>
                  <td className="small muted">{fmtStamp(d.created_at)}</td>
                  <td><span className="hash">{shortHash(d.files.sha256)}</span></td>
                  <td>{d.status === 'verified' ? <Pill sev="ok">Verified</Pill> : d.status === 'pending' ? <Pill sev="pend">Pending</Pill> : <Pill sev="crit">Rejected</Pill>}
                    {d.reason && <div className="small muted">{d.reason}</div>}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => open(d)}>Open</button>{' '}
                    {d.status === 'verified' && <button className="btn sm danger" title="Verified by mistake? This sends it back to the student with a reason." onClick={() => withdraw(d)}>Withdraw</button>}
                    {d.status === 'pending' && <><button className="btn sm" onClick={() => verify(d)}>Verify</button> <button className="btn sm danger" onClick={() => setRejecting(d)}>Reject</button></>}
                  </td>
                </tr>
              ))}
              {data && !data.docs.length && <tr><td colSpan={6} className="muted">Nothing in this list. Students upload documents from their portal.</td></tr>}
            </tbody>
          </table>
          {data && data.total > PAGE && <div className="legend" style={{ marginTop: 8 }}>Showing {PAGE} of {data.total}{f === 'pending' ? ', oldest first' : ''}</div>}
        </div>
      </div>
      {rejecting && <RejectModal d={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); reload(); window.dispatchEvent(new Event('alerts-changed')); }} />}
    </>
  );
}

function RejectModal({ d, onClose, onDone }: { d: DocRow; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState(REASONS[0]);
  const [other, setOther] = useState('');
  const [err, setErr] = useState('');
  async function save() {
    const r = reason === 'Other' ? other.trim() : reason;
    if (r.length < 3) return setErr('Give the student a reason.');
    const { error } = await supabase.rpc('decide_document', { p_doc: d.id, p_status: 'rejected', p_reason: r.slice(0, 200) });
    if (error) return setErr(errText(error));
    toast('Document rejected — the student sees the reason');
    onDone();
  }
  return (
    <Modal onClose={onClose}>
      <h3>Reject {d.doc_types.name}?</h3>
      <p className="small muted">{d.students.full_name} · {d.students.matric_no}. The student sees this reason and is asked to re-upload.</p>
      <select className="input" style={{ width: '100%', margin: '12px 0 8px' }} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
        {[...REASONS, 'Other'].map((r) => <option key={r}>{r}</option>)}
      </select>
      {reason === 'Other' && <input className="input" style={{ width: '100%' }} maxLength={200} placeholder="Reason" value={other} onChange={(e) => setOther(e.target.value)} aria-label="Other reason" />}
      <div className="err" role="alert">{err}</div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn pri" onClick={save}>Reject</button>
      </div>
    </Modal>
  );
}

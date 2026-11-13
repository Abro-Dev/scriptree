import { useState } from 'react';
import { PageTop } from '../../components/Shell';
import { Modal, Pill, useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase, errText, invokeFn } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fileId, fmtStamp, type DocType } from '../../lib/officer';
import { fetchDocTypes } from '../../lib/queries';
import { mb, readBytes, sha256Hex, shortHash } from '../../lib/pdf';
import type { MyDoc } from '../../lib/student';

const TYPES: Record<string, [string, string]> = { pdf: ['application/pdf', 'pdf'], jpg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'] };
function sniff(b: Uint8Array): keyof typeof TYPES | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  return null;
}

interface Pending { type: DocType; name?: string; bytes?: Uint8Array; kind?: keyof typeof TYPES; hash?: string; err?: string }

export function MyDocuments() {
  const toast = useToast();
  const { session } = useAuth();
  const [pd, setPd] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [receipt, setReceipt] = useState<{ d: MyDoc; t: DocType } | null>(null);
  const { data, error, reload } = useLoad(async () => {
    const [docs, types, settings] = await Promise.all([
      supabase.rpc('my_documents').then((r) => must(r) as MyDoc[]),
      fetchDocTypes(),
      supabase.rpc('upload_limit_mb').then((r) => (r.error ? 20 : (r.data as number))),
    ]);
    return { docs, types, maxMb: settings };
  }, []);

  async function view(d: MyDoc) {
    const { data: u, error } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, 120);
    if (error) toast(errText(error)); else window.open(u.signedUrl, '_blank', 'noopener');
  }

  async function stage(file?: File) {
    if (!file || !pd) return;
    const maxMb = data?.maxMb ?? 20;
    if (file.size > maxMb * 1048576) { setPd({ type: pd.type, err: `“${file.name}” is ${mb(file.size)} — the limit is ${maxMb} MB.` }); return; }
    const bytes = await readBytes(file);
    const kind = sniff(bytes);
    if (!kind) { setPd({ type: pd.type, err: `“${file.name}” isn't a PDF, JPEG or PNG.` }); return; }
    setPd({ type: pd.type, name: file.name, bytes, kind, hash: await sha256Hex(bytes) });
  }

  async function submit() {
    if (!pd?.bytes || !pd.kind || !session) return;
    setSaving(true);
    const [mime, ext] = TYPES[pd.kind];
    const path = `incoming/${session.user.id}/${crypto.randomUUID()}.${ext}`;
    try {
      const up = await supabase.storage.from('documents').upload(path, new Blob([pd.bytes as BlobPart], { type: mime }), { contentType: mime });
      if (up.error) throw up.error;
      const r = await invokeFn<{ file_no: number; sha256: string }>('register-file', { kind: 'doc', path, name: pd.name, doc_type: pd.type.id });
      toast(r.sha256 === pd.hash ? 'Submitted — the exams office will verify it' : 'Submitted, but the server fingerprint differs — please upload again');
      setPd(null);
      reload();
    } catch (e) {
      toast(errText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageTop title="My documents" sub="Upload once — the school keeps a verified copy" />
      <div className="content">
        {error && <div className="banner crit">{error}</div>}
        <div className="grid g21">
          <div className="card" style={{ overflowX: 'auto' }}>
            <h3>Required documents</h3>
            <table>
              <thead><tr><th>Document</th><th>Status</th><th>Uploaded</th><th>Fingerprint</th><th /></tr></thead>
              <tbody>
                {(data?.types ?? []).map((t) => {
                  const d = data!.docs.find((x) => x.doc_type === t.id);
                  return (
                    <tr key={t.id}>
                      <td><b>{t.name}</b>{!t.required && <span className="small muted"> (optional)</span>}
                        {d?.status === 'rejected' && d.reason && <div className="small" style={{ color: 'var(--crit)' }}>{d.reason}</div>}</td>
                      <td>{!d ? (t.required ? <Pill sev="high">Not submitted</Pill> : <span className="small muted">Optional</span>)
                        : d.status === 'verified' ? <Pill sev="ok">Verified</Pill> : d.status === 'pending' ? <Pill sev="pend">Awaiting verification</Pill> : <Pill sev="crit">Rejected</Pill>}</td>
                      <td className="small muted">{d ? fmtStamp(d.uploaded_at) : '—'}</td>
                      <td>{d && <span className="hash" title={d.sha256}>{shortHash(d.sha256)}</span>}</td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {d && <><button className="btn sm" onClick={() => view(d)}>View</button>{' '}</>}
                        {(!d || d.status === 'rejected') && <button className="btn sm pri" onClick={() => setPd({ type: t })}>{d ? 'Re-upload' : 'Upload'}</button>}
                        {d?.status === 'verified' && <button className="btn sm" onClick={() => setReceipt({ d, t })}>View receipt</button>}
                      </td>
                    </tr>
                  );
                })}
                {!data && !error && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>{pd ? `Upload: ${pd.type.name}` : 'Why this matters'}</h3>
            {pd ? <>
              <label className="drop">
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" style={{ display: 'none' }}
                  onChange={(e) => { stage(e.target.files?.[0]); e.target.value = ''; }} />
                {pd.name ? <><b>{pd.name}</b><div className="small muted">{mb(pd.bytes!.length)}</div></> : 'Choose a PDF or photo'}
              </label>
              {pd.err && <div className="banner crit" style={{ marginTop: 10 }}>{pd.err}</div>}
              {pd.hash && <>
                <div className="small muted" style={{ margin: '10px 0 4px' }}>SHA-256 fingerprint (the server recomputes it and the two must match)</div>
                <div className="hash" style={{ whiteSpace: 'normal', wordBreak: 'break-all', display: 'block', padding: 8 }}>{pd.hash}</div>
              </>}
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn" onClick={() => setPd(null)} disabled={saving}>Cancel</button>
                <button className="btn pri" disabled={!pd.hash || saving} onClick={submit}>{saving ? 'Submitting…' : 'Submit for verification'}</button>
              </div>
            </> : <div className="small" style={{ color: 'var(--ink2)' }}>Upload each document once. The exams office verifies it and keeps a fingerprinted copy, so you won't be asked to resubmit it every session. You can view the receipt of any verified document at any time.</div>}
          </div>
        </div>
      </div>
      {receipt && <Modal onClose={() => setReceipt(null)}>
        <h3>Preservation receipt</h3>
        <p className="small muted">{receipt.t.name}</p>
        <table><tbody>
          <tr><td className="small muted">File ID</td><td className="mono">{fileId(receipt.d.file_no)}</td></tr>
          <tr><td className="small muted">File</td><td className="small">{receipt.d.original_name} · {mb(receipt.d.size_bytes)}</td></tr>
          <tr><td className="small muted">Uploaded</td><td>{fmtStamp(receipt.d.uploaded_at)}</td></tr>
          <tr><td className="small muted">Verified by</td><td>{receipt.d.verified_by_name} · {fmtStamp(receipt.d.verified_at)}</td></tr>
          <tr><td className="small muted">SHA-256</td><td><span className="hash" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>{receipt.d.sha256}</span></td></tr>
        </tbody></table>
        <div className="legend" style={{ marginTop: 10 }}>Keep this fingerprint. Anyone at the exams office can check a copy against it to prove it hasn't been altered.</div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={() => window.print()}>Print</button>
          <button className="btn pri" onClick={() => setReceipt(null)}>Close</button>
        </div>
      </Modal>}
    </>
  );
}

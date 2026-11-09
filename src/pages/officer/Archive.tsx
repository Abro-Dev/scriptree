import { useState, type DragEvent } from 'react';
import { PageTop } from '../../components/Shell';
import { Pill, useToast } from '../../components/ui';
import { supabase, errText, invokeFn } from '../../lib/supabase';
import { must, useLoad } from '../../lib/useLoad';
import { fileId, fmtStamp } from '../../lib/officer';
import { mb, readBytes, sha256Hex, shortHash } from '../../lib/pdf';

interface FileRow {
  id: string; file_no: number; kind: 'script' | 'doc'; version: number; active: boolean; original_name: string; size_bytes: number;
  sha256: string; uploaded_at: string; storage_path: string;
  students: { matric_no: string } | null; exam_sessions: { course_code: string } | null; doc_types: { name: string } | null;
}
type Kind = 'all' | 'script' | 'doc';
const PAGE = 60;

export function Archive() {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('all');
  const [failedOnly, setFailedOnly] = useState(false);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<{ checked: number; failed: number } | null>(null);
  const [vr, setVr] = useState<{ name: string; hash: string; match: FileRow | null } | null>(null);
  const [over, setOver] = useState(false);

  const { data, error, reload } = useLoad(async () => {
    const sel = 'id, file_no, kind, version, active, original_name, size_bytes, sha256, uploaded_at, storage_path, students(matric_no), exam_sessions(course_code), doc_types(name)';
    const failed = must(await supabase.from('file_integrity').select('file_id, ok, checked_at').eq('ok', false)) as { file_id: string }[];
    const failedIds = new Set(failed.map((f) => f.file_id));
    let q = supabase.from('files').select(sel, { count: 'exact' }).order('file_no', { ascending: false }).limit(PAGE);
    if (kind !== 'all') q = q.eq('kind', kind);
    if (failedOnly) q = q.in('id', failed.length ? [...failedIds] : ['00000000-0000-0000-0000-000000000000']);
    const r = await q;
    const files = must(r) as unknown as FileRow[];
    const integ = files.length ? must(await supabase.from('file_integrity').select('file_id, ok, checked_at').in('file_id', files.map((f) => f.id))) as { file_id: string; ok: boolean | null; checked_at: string | null }[] : [];
    const counts = await Promise.all((['all', 'script', 'doc'] as Kind[]).map(async (k) => {
      let c = supabase.from('files').select('id', { count: 'exact', head: true });
      if (k !== 'all') c = c.eq('kind', k);
      return (await c).count ?? 0;
    }));
    return { files, total: r.count ?? 0, integ: Object.fromEntries(integ.map((i) => [i.file_id, i])), failedN: failedIds.size, counts };
  }, [kind, failedOnly]);

  async function verifyAll() {
    setRunning(true);
    try {
      const r = await invokeFn<{ checked: number; failed: number }>('integrity-check', {});
      setLastRun(r);
      toast(r.failed ? `${r.failed} file${r.failed > 1 ? 's' : ''} failed verification` : `All ${r.checked} files verified`);
      reload();
      window.dispatchEvent(new Event('alerts-changed'));
    } catch (e) {
      toast(errText(e));
    } finally {
      setRunning(false);
    }
  }

  async function verifyCopy(file?: File) {
    if (!file) return;
    if (file.size > 200 * 1048576) { toast('File too large to check here'); return; }
    const hash = await sha256Hex(await readBytes(file));
    const r = await supabase.from('files').select('id, file_no, kind, version, active, original_name, size_bytes, sha256, uploaded_at, storage_path, students(matric_no), exam_sessions(course_code), doc_types(name)').eq('sha256', hash).limit(1);
    if (r.error) { toast(errText(r.error)); return; }
    setVr({ name: file.name, hash, match: ((r.data ?? [])[0] as unknown as FileRow) ?? null });
  }

  async function open(f: FileRow) {
    const { data: u, error } = await supabase.storage.from(f.kind === 'script' ? 'scans' : 'documents').createSignedUrl(f.storage_path, 120);
    if (error) toast(errText(error)); else window.open(u.signedUrl, '_blank', 'noopener');
  }

  const owner = (f: FileRow) => f.kind === 'script' ? `${f.exam_sessions?.course_code} · ${f.students?.matric_no}` : `${f.doc_types?.name} · ${f.students?.matric_no}`;

  return (
    <>
      <PageTop title="Digital archive" sub="Preserved copies with SHA-256 fingerprints"
        actions={<button className="btn pri" disabled={running} onClick={verifyAll}>{running ? 'Re-hashing…' : 'Verify all files'}</button>} />
      <div className="content">
        <div className="grid g21" style={{ marginBottom: 16 }}>
          <div className="card">
            <h3>How preservation works</h3>
            <div className="small" style={{ color: 'var(--ink2)' }}>When a PDF is uploaded the server computes its <b>SHA-256</b> fingerprint and stores it beside the file. Re-computing the hash later and comparing proves the file hasn't changed by even one byte. Files are never overwritten — a rescan becomes a new version, and the old one keeps its own hash.</div>
            <div className="row" style={{ marginTop: 14 }}>
              {data && data.failedN > 0
                ? <div className="banner crit" style={{ flex: 1 }}><b>{data.failedN} file{data.failedN > 1 ? 's' : ''} failed verification.</b> The stored copy no longer matches the hash recorded at upload. A critical alert has been raised. <a href="#" onClick={(e) => { e.preventDefault(); setFailedOnly(true); }}>Show them</a></div>
                : lastRun ? <div className="banner ok" style={{ flex: 1 }}>All {lastRun.checked} files verified.</div>
                : <div className="banner info" style={{ flex: 1 }}>Run <b>Verify all files</b> to re-hash every stored copy on the server (the nightly check does the same).</div>}
            </div>
          </div>
          <div className="card">
            <h3>Verify a copy</h3>
            <div className="small muted" style={{ marginBottom: 10 }}>Got a PDF from somewhere? Drop it here to check whether it is an unaltered copy of an archived file. It is fingerprinted in your browser and not uploaded.</div>
            <label className={`drop${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); verifyCopy(e.dataTransfer.files[0]); }}>
              <input type="file" style={{ display: 'none' }} onChange={(e) => { verifyCopy(e.target.files?.[0]); e.target.value = ''; }} />Drop a file or <b>browse</b>
            </label>
            {vr && <div className={`banner ${vr.match ? 'ok' : 'crit'}`} style={{ marginTop: 10 }}>
              <b>{vr.match ? 'Match — unaltered copy' : 'No match'}</b>
              <div className="small">{vr.name} · <span className="mono">{shortHash(vr.hash)}</span></div>
              <div className="small">{vr.match ? `Identical to ${fileId(vr.match.file_no)} (${owner(vr.match)}).` : 'This file is not byte-identical to anything in the archive.'}</div>
            </div>}
          </div>
        </div>
        {error && <div className="banner crit">{error}</div>}
        <div className="card" style={{ overflowX: 'auto' }}>
          <div className="row between" style={{ marginBottom: 10 }}>
            <div className="row">
              {([['all', 'All files'], ['script', 'Exam scripts'], ['doc', 'Student documents']] as [Kind, string][]).map(([k, l], i) => (
                <button key={k} className={`chip ${kind === k && !failedOnly ? 'on' : ''}`} onClick={() => { setKind(k); setFailedOnly(false); }}>{l} ({data?.counts[i] ?? '…'})</button>))}
              {(data?.failedN ?? 0) > 0 && <button className={`chip ${failedOnly ? 'on' : ''}`} onClick={() => setFailedOnly(!failedOnly)}>Failed ({data!.failedN})</button>}
            </div>
            <span className="small muted">{data && data.total > PAGE ? `Showing newest ${PAGE} of ${data.total}` : ''}</span>
          </div>
          <table>
            <thead><tr><th>File</th><th>Belongs to</th><th>Ver.</th><th className="num">Size</th><th>SHA-256 (at upload)</th><th>Uploaded</th><th>Integrity</th><th /></tr></thead>
            <tbody>
              {(data?.files ?? []).map((f) => {
                const c = data!.integ[f.id];
                return (
                  <tr key={f.id}>
                    <td className="mono">{fileId(f.file_no)}<div className="small muted" style={{ fontFamily: 'inherit' }}>{f.original_name}</div></td>
                    <td className="small">{owner(f)}</td>
                    <td>v{f.version}</td>
                    <td className="num small">{mb(f.size_bytes)}</td>
                    <td><span className="hash" title={f.sha256}>{shortHash(f.sha256)}</span></td>
                    <td className="small muted">{fmtStamp(f.uploaded_at)}</td>
                    <td>{!f.active ? <Pill sev="pend">Superseded</Pill> : c?.ok === false ? <Pill sev="crit">Mismatch</Pill> : c?.ok ? <Pill sev="ok">Verified {fmtStamp(c.checked_at)}</Pill> : <span className="small muted">Not yet checked</span>}</td>
                    <td><button className="btn sm" onClick={() => open(f)}>Open</button></td>
                  </tr>
                );
              })}
              {data && !data.files.length && <tr><td colSpan={8} className="muted">No files yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

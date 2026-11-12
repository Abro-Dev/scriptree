import { useEffect, useState, type DragEvent, type FormEvent } from 'react';
import { useToast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { supabase, errText, invokeFn } from '../../lib/supabase';
import { buildPdf, imageToJpeg, isPdf, mb, readBytes, sha256Hex } from '../../lib/pdf';
import { matchRow } from '../../lib/hall';
import type { TabProps } from './Hall';

type Capture = 'pdf' | 'snap';
interface Staged {
  studentId: string;
  name: string;
  bytes: Uint8Array;
  hash: string; // browser preview; the server recomputes and we compare
  method: Capture;
  pages?: number;
  thumbs?: string[];
}

export function ScanTab({ d, live, reload }: TabProps) {
  const s = d.session;
  const toast = useToast();
  const { session: auth } = useAuth();
  const cands = d.rows.filter((r) => r.present === true || r.has_physical);
  const firstUnscanned = cands.find((r) => r.n_scans === 0) ?? cands[0];
  const [scanFor, setScanFor] = useState<string>(firstUnscanned?.student_id ?? '');
  const [lookup, setLookup] = useState('');
  const allowed: Capture[] = [...(d.settings.allow_pdf_upload ? ['pdf' as const] : []), ...(d.settings.allow_photo_snaps ? ['snap' as const] : [])];
  const [cap, setCap] = useState<Capture>(allowed[0] ?? 'pdf');
  const [staged, setStaged] = useState<Staged | null>(null);
  const [stageErr, setStageErr] = useState('');
  const [building, setBuilding] = useState(false);
  const [rescan, setRescan] = useState(false);
  const [saving, setSaving] = useState(false);
  const [over, setOver] = useState(false);

  // keep a valid selection as rows refresh
  useEffect(() => {
    if (!cands.some((r) => r.student_id === scanFor) && firstUnscanned) setScanFor(firstUnscanned.student_id);
  }, [cands, scanFor, firstUnscanned]);

  const cur = cands.find((r) => r.student_id === scanFor);
  const maxBytes = d.settings.max_file_mb * 1048576;
  const fileStem = (matric: string) => `${s.course_code.replace(' ', '')}_${matric.replace(/\//g, '-')}`;

  function reset() { setStaged(null); setStageErr(''); setRescan(false); }

  async function find(e: FormEvent) {
    e.preventDefault();
    const v = lookup.trim();
    if (!v) return;
    const hits = cands.filter((r) => matchRow(r, v));
    if (hits.length === 1) { setScanFor(hits[0].student_id); reset(); setLookup(''); return; }
    const { data, error } = await supabase.rpc('resolve_identifier', { p_q: v, p_session: s.id });
    if (error) { toast(errText(error)); return; }
    const row = cands.find((r) => r.student_id === data);
    if (!data) toast('No student matches that ID');
    else if (!row) toast('That student is not marked present and has no script checked in');
    else { setScanFor(row.student_id); reset(); setLookup(''); }
  }

  async function stagePdf(file?: File) {
    reset();
    if (!file || !cur) return;
    if (file.size > maxBytes) { setStageErr(`“${file.name}” is ${mb(file.size)} — the limit is ${d.settings.max_file_mb} MB.`); return; }
    const b = await readBytes(file);
    if (!isPdf(b)) { setStageErr(`“${file.name}” is not a PDF (file signature check failed). Use “Photo snaps” for images.`); return; }
    setStaged({ studentId: cur.student_id, name: file.name, bytes: b, hash: await sha256Hex(b), method: 'pdf' });
  }

  async function stageSnaps(list: FileList | null) {
    reset();
    if (!cur) return;
    const files = [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) { setStageErr('Choose one or more photos of the script pages.'); return; }
    if (files.length > 100) { setStageErr('At most 100 pages per script.'); return; }
    setBuilding(true);
    try {
      const pages = [];
      for (const f of files) pages.push(await imageToJpeg(f));
      const pdf = buildPdf(pages);
      if (pdf.length > maxBytes) throw new Error(`the merged PDF is ${mb(pdf.length)}, over the ${d.settings.max_file_mb} MB limit`);
      setStaged({ studentId: cur.student_id, name: `${fileStem(cur.matric_no)}.pdf`, bytes: pdf, hash: await sha256Hex(pdf), method: 'snap', pages: pages.length, thumbs: pages.map((p) => p.thumb) });
    } catch (e) {
      setStageErr('Could not use those photos: ' + errText(e));
    } finally {
      setBuilding(false);
    }
  }

  async function save() {
    if (!staged || !auth) return;
    const row = cands.find((r) => r.student_id === staged.studentId);
    setSaving(true);
    const path = `incoming/${auth.user.id}/${crypto.randomUUID()}.pdf`;
    try {
      const up = await supabase.storage.from('scans').upload(path, new Blob([staged.bytes as BlobPart], { type: 'application/pdf' }), { contentType: 'application/pdf' });
      if (up.error) throw up.error;
      const r = await invokeFn<{ file_no: number; version: number; duplicate: boolean; sha256: string }>('register-file', {
        kind: 'script', path, name: staged.name, session_id: s.id, student_id: staged.studentId, method: staged.method, pages: staged.pages ?? null, rescan,
      });
      const id = 'F' + String(r.file_no).padStart(4, '0');
      if (r.sha256 !== staged.hash) toast(`Saved ${id}, but the server fingerprint differs from this browser's — rescan this script`);
      else toast(r.duplicate ? `Saved ${id} — flagged as a duplicate scan` : `Saved ${id} v${r.version} · fingerprint confirmed by server`);
      reset();
      const next = cands.find((x) => x.n_scans === 0 && x.student_id !== row?.student_id);
      if (next) setScanFor(next.student_id);
      reload();
    } catch (e) {
      toast(errText(e));
    } finally {
      setSaving(false);
    }
  }

  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); stagePdf(e.dataTransfer.files[0]); };
  const disabled = !live || !cur;
  const waiting = cands.filter((r) => r.n_scans === 0);
  const shown = waiting.filter((r) => matchRow(r, lookup));

  return (
    <div className="grid g21">
      <div className="card">
        <h3>Capture a script</h3>
        <div className="small muted" style={{ marginBottom: 12 }}>Find the student, then either upload the PDF the scanner saved, or take photo snaps of each page — they are merged into one PDF.</div>
        <form className="row" style={{ marginBottom: 10 }} onSubmit={find}>
          <input className="input" type="search" style={{ flex: 1 }} placeholder="Student ID, script ID or name" value={lookup} maxLength={40}
            onChange={(e) => setLookup(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setLookup(''); }}
            disabled={!live} aria-label="Find student" autoComplete="off" />
          <button className="btn" disabled={!live}>Find</button>
        </form>
        <select className="input" style={{ width: '100%', marginBottom: 14 }} value={scanFor} disabled={!live || !cands.length}
          onChange={(e) => { setScanFor(e.target.value); reset(); }} aria-label="Student being scanned">
          {cands.map((r) => <option key={r.student_id} value={r.student_id}>
            {r.matric_no} · {r.full_name}{r.n_scans ? ' · already scanned' : r.has_physical ? '' : ' · script not checked in'}
          </option>)}
          {!cands.length && <option>No present candidates yet — take attendance first</option>}
        </select>
        {!allowed.length && <div className="banner warn">Both capture methods are turned off in system settings.</div>}
        {allowed.length > 0 && <div className="seg" style={{ marginBottom: 12 }}>
          {allowed.includes('pdf') && <button className={cap === 'pdf' ? 'on' : ''} onClick={() => { setCap('pdf'); reset(); }}>Upload PDF from scanner</button>}
          {allowed.includes('snap') && <button className={cap === 'snap' ? 'on' : ''} onClick={() => { setCap('snap'); reset(); }}>Photo snaps</button>}
        </div>}
        {allowed.includes(cap) && (cap === 'pdf'
          ? <label className={`drop${over ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
              <input type="file" accept="application/pdf,.pdf" style={{ display: 'none' }} disabled={disabled}
                onChange={(e) => { stagePdf(e.target.files?.[0]); e.target.value = ''; }} />
              Drop the scanner's PDF here or <b>browse</b>
            </label>
          : <label className="drop">
              <input type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }} disabled={disabled}
                onChange={(e) => { stageSnaps(e.target.files); e.target.value = ''; }} />
              <b>Take or choose photos</b> of each page
              <div className="small muted" style={{ marginTop: 4 }}>On a phone this opens the camera. Pick pages in order — they become one PDF.</div>
            </label>)}
        {(building || stageErr || staged) && <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14, marginTop: 14 }}>
          {building && <div className="small muted">Building PDF…</div>}
          {stageErr && <div className="banner crit">{stageErr}</div>}
          {staged && <>
            <div className="row between"><b>{staged.name}</b><span className="small muted">{staged.pages ? `${staged.pages} page${staged.pages > 1 ? 's' : ''} · ` : ''}{mb(staged.bytes.length)}</span></div>
            {staged.thumbs && <div className="thumbs">{staged.thumbs.map((t, i) => <img key={i} src={t} alt={`Page ${i + 1}`} />)}</div>}
            <div className="small muted" style={{ margin: '10px 0 4px' }}>
              For: <b style={{ color: 'var(--ink)' }}>{cands.find((r) => r.student_id === staged.studentId)?.matric_no} · {cands.find((r) => r.student_id === staged.studentId)?.full_name}</b> · {staged.method === 'snap' ? 'merged from photo snaps' : 'direct PDF upload'}
            </div>
            <div className="small muted" style={{ margin: '8px 0 4px' }}>SHA-256 fingerprint (preview — the server recomputes it on save and the two must match)</div>
            <div className="hash" style={{ whiteSpace: 'normal', wordBreak: 'break-all', display: 'block', padding: 8 }}>{staged.hash}</div>
            {(cur?.n_scans ?? 0) > 0 && <label className="row small" style={{ marginTop: 10, gap: 6 }}>
              <input type="checkbox" checked={rescan} onChange={(e) => setRescan(e.target.checked)} /> This is a rescan — replace the previous scan (kept as an older version)
            </label>}
            {(cur?.n_scans ?? 0) > 0 && !rescan && <div className="small" style={{ color: 'var(--med)', marginTop: 6 }}>This student already has a scan. Saving without “rescan” flags a duplicate.</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" onClick={reset} disabled={saving}>Discard</button>
              <button className="btn pri" onClick={save} disabled={saving || !live}>{saving ? 'Saving…' : 'Save to archive'}</button>
            </div>
          </>}
        </div>}
      </div>
      <div className="card">
        <h3>Waiting to be scanned <span className="muted small">· {lookup.trim() ? `${shown.length} of ${waiting.length}` : waiting.length}</span></h3>
        {shown.map((r) => (
          <div key={r.student_id} className="row between" style={{ padding: '7px 0', borderBottom: '1px solid #eef1f4' }}>
            <span className="small"><span className="mono">{r.matric_no}</span><br />{r.full_name}</span>
            <span className="row" style={{ gap: 6 }}>
              {!r.has_physical && <span className="pill p-pend">no script yet</span>}
              {live && <button className="btn sm" onClick={() => { setScanFor(r.student_id); reset(); }}>Select</button>}
            </span>
          </div>
        ))}
        {!waiting.length && <div className="small muted">All present candidates scanned.</div>}
        {waiting.length > 0 && !shown.length && <div className="small muted">Nobody waiting matches “{lookup.trim()}”.</div>}
      </div>
    </div>
  );
}

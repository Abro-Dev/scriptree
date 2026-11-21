import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useToast } from '../../components/ui';
import { QrScanner } from '../../components/QrScanner';
import { useAuth } from '../../lib/auth';
import { supabase, errText, invokeFn } from '../../lib/supabase';
import { buildPdf, imageToJpeg, isPdf, mb, readBytes, sha256Hex } from '../../lib/pdf';
import { matchRow, type ReconRow } from '../../lib/hall';
import { normCode, qrFromScript } from '../../lib/qr';
import type { TabProps } from './Hall';

type Capture = 'pdf' | 'snap';
/** What the QR on the staged file says about whose script it is. */
type QrState =
  | { state: 'checking' }
  | { state: 'match'; code: string }
  | { state: 'mismatch'; code: string; owner?: ReconRow }
  | { state: 'none' };
interface Staged {
  studentId: string;
  name: string;
  bytes: Uint8Array;
  hash: string; // sent with the upload; the server refuses the file if its own fingerprint differs
  method: Capture;
  pages?: number;
  thumbs?: string[];
  photos?: File[];
}

export function ScanTab({ d, live, reload }: TabProps) {
  const s = d.session;
  const toast = useToast();
  const { session: auth } = useAuth();
  const cands = d.rows.filter((r) => r.present === true || r.has_physical);
  const firstUnscanned = cands.find((r) => r.n_scans === 0 && r.has_physical) ?? cands.find((r) => r.n_scans === 0) ?? cands[0];
  const [scanFor, setScanFor] = useState<string>(firstUnscanned?.student_id ?? '');
  const [lookup, setLookup] = useState('');
  const allowed: Capture[] = [...(d.settings.allow_pdf_upload ? ['pdf' as const] : []), ...(d.settings.allow_photo_snaps ? ['snap' as const] : [])];
  const [cap, setCap] = useState<Capture>(allowed[0] ?? 'pdf');
  const [staged, setStaged] = useState<Staged | null>(null);
  const [qr, setQr] = useState<QrState>({ state: 'none' });
  const [camCode, setCamCode] = useState('');   // booklet QR read by camera when the file's QR is unreadable
  const [byEye, setByEye] = useState(false);     // ... or checked by eye
  const [camera, setCamera] = useState<null | 'pick' | 'confirm'>(null);
  const [stageErr, setStageErr] = useState('');
  const [building, setBuilding] = useState(false);
  const [rescan, setRescan] = useState(false);
  const [saving, setSaving] = useState(false);
  const [over, setOver] = useState(false);
  const [sameFile, setSameFile] = useState('');
  const token = useRef(0);

  // keep a valid selection as rows refresh
  useEffect(() => {
    if (!cands.some((r) => r.student_id === scanFor) && firstUnscanned) setScanFor(firstUnscanned.student_id);
  }, [cands, scanFor, firstUnscanned]);

  const cur = cands.find((r) => r.student_id === scanFor);
  const maxBytes = d.settings.max_file_mb * 1048576;
  const course = s.course_code.replace(' ', '');
  const fileStem = (matric: string) => `${course}_${matric.replace(/\//g, '-')}`;
  /** The script ID this student's booklet label carries. */
  const codeOf = (r: ReconRow) => normCode(r.script_code ?? d.labels[r.student_id] ?? `${r.matric_no}-${course}`);
  const ownerOf = (code: string) => d.rows.find((r) => codeOf(r) === normCode(code));

  function reset() { token.current++; setStaged(null); setStageErr(''); setRescan(false); setQr({ state: 'none' }); setCamCode(''); setByEye(false); }

  async function pick(v: string): Promise<string | null> {
    const hits = cands.filter((r) => matchRow({ ...r, script_code: codeOf(r) }, v));
    if (hits.length === 1) { setScanFor(hits[0].student_id); reset(); setLookup(''); return null; }
    const { data, error } = await supabase.rpc('resolve_identifier', { p_q: v, p_session: s.id });
    if (error) return errText(error);
    const row = cands.find((r) => r.student_id === data);
    if (!data) return 'No student matches that ID';
    if (!row) return 'That student is not marked present and has no script checked in';
    setScanFor(row.student_id); reset(); setLookup('');
    return null;
  }

  async function find(e: FormEvent) {
    e.preventDefault();
    const v = lookup.trim();
    if (!v) return;
    const m = await pick(v);
    if (m) toast(m);
  }

  /** Look for the QR label on the staged file and compare it with the selected student. */
  async function checkQr(st: Staged) {
    const t = ++token.current;
    setQr({ state: 'checking' });
    const found = await qrFromScript(st.bytes, st.photos);
    if (t !== token.current) return;
    const row = cands.find((r) => r.student_id === st.studentId);
    if (!found) setQr({ state: 'none' });
    else if (row && normCode(found) === codeOf(row)) setQr({ state: 'match', code: normCode(found) });
    else setQr({ state: 'mismatch', code: normCode(found), owner: ownerOf(found) });
  }

  function stage(st: Staged) {
    setStaged(st);
    checkQr(st);
  }

  async function stagePdf(file?: File) {
    reset();
    if (!file || !cur) return;
    if (file.size > maxBytes) { setStageErr(`“${file.name}” is ${mb(file.size)} — the limit is ${d.settings.max_file_mb} MB.`); return; }
    const b = await readBytes(file);
    if (!isPdf(b)) { setStageErr(`“${file.name}” is not a PDF (file signature check failed). Use “Photo snaps” for images.`); return; }
    stage({ studentId: cur.student_id, name: file.name, bytes: b, hash: await sha256Hex(b), method: 'pdf' });
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
      stage({ studentId: cur.student_id, name: `${fileStem(cur.matric_no)}.pdf`, bytes: pdf, hash: await sha256Hex(pdf), method: 'snap', pages: pages.length, thumbs: pages.map((p) => p.thumb), photos: files });
    } catch (e) {
      setStageErr('Could not use those photos: ' + errText(e));
    } finally {
      setBuilding(false);
    }
  }

  // how the QR was confirmed, if it was
  const proof: { source: 'file' | 'camera' | 'manual'; qr: string | null } | null =
    qr.state === 'match' ? { source: 'file', qr: qr.code }
    : qr.state === 'none' && camCode ? { source: 'camera', qr: camCode }
    : qr.state === 'none' && byEye ? { source: 'manual', qr: null }
    : null;

  async function save() {
    if (!staged || !auth || !proof) return;
    const row = cands.find((r) => r.student_id === staged.studentId);
    setSaving(true);
    const path = `incoming/${auth.user.id}/${crypto.randomUUID()}.pdf`;
    try {
      const up = await supabase.storage.from('scans').upload(path, new Blob([staged.bytes as BlobPart], { type: 'application/pdf' }), { contentType: 'application/pdf' });
      if (up.error) throw up.error;
      const r = await invokeFn<{ file_no: number; version: number; duplicate: boolean; sha256: string; same_as?: string | null }>('register-file', {
        kind: 'script', path, name: staged.name, session_id: s.id, student_id: staged.studentId, method: staged.method, pages: staged.pages ?? null, rescan,
        client_sha256: staged.hash, qr: proof.qr, qr_source: proof.source,
      });
      const id = 'F' + String(r.file_no).padStart(4, '0');
      toast(r.duplicate ? `Saved ${id} — flagged as a duplicate scan` : `Saved ${id} v${r.version} · fingerprint confirmed by server`);
      setSameFile(r.same_as ? `${id} for ${row?.matric_no ?? 'this student'} is the very same file already saved for ${r.same_as}. One of them is the wrong file — check both and rescan the wrong one.` : '');
      reset();
      const next = cands.find((x) => x.n_scans === 0 && x.has_physical && x.student_id !== row?.student_id);
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
  const shown = waiting.filter((r) => matchRow({ ...r, script_code: codeOf(r) }, lookup));
  const stagedRow = staged ? cands.find((r) => r.student_id === staged.studentId) : undefined;

  return (
    <div className="grid g21">
      <div className="card">
        <div className="row between"><h3 style={{ margin: 0 }}>Capture a script</h3>
          <button className="btn" disabled={!live} onClick={() => setCamera('pick')}>Scan booklet QR</button>
        </div>
        <div className="small muted" style={{ margin: '8px 0 12px' }}>Scan the booklet's QR label (or find the student), then upload the scanner's PDF or take photo snaps of each page.
          The QR on the cover must match the student before the file can be saved.</div>
        <form className="row" style={{ marginBottom: 10 }} onSubmit={find}>
          <input className="input" type="search" style={{ flex: 1 }} placeholder="Student ID, script ID or name" value={lookup} maxLength={60}
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
        {sameFile && <div className="banner crit" role="alert" style={{ marginBottom: 12 }}>
          <b>Same file saved twice.</b> {sameFile} <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => setSameFile('')}>OK</button>
        </div>}
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
              <div className="small muted" style={{ marginTop: 4 }}>On a phone this opens the camera. Start with the cover (with the QR label), then the pages in order — they become one PDF.</div>
            </label>)}
        {(building || stageErr || staged) && <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14, marginTop: 14 }}>
          {building && <div className="small muted">Building PDF…</div>}
          {stageErr && <div className="banner crit">{stageErr}</div>}
          {staged && <>
            <div className="row between"><b>{staged.name}</b><span className="small muted">{staged.pages ? `${staged.pages} page${staged.pages > 1 ? 's' : ''} · ` : ''}{mb(staged.bytes.length)}</span></div>
            {staged.thumbs && <div className="thumbs">{staged.thumbs.map((t, i) => <img key={i} src={t} alt={`Page ${i + 1}`} />)}</div>}
            <div className="small muted" style={{ margin: '10px 0 4px' }}>
              For: <b style={{ color: 'var(--ink)' }}>{stagedRow?.matric_no} · {stagedRow?.full_name}</b> · {staged.method === 'snap' ? 'merged from photo snaps' : 'direct PDF upload'}
            </div>

            {qr.state === 'checking' && <div className="banner info" style={{ marginTop: 8 }}>Reading the QR label on the cover…</div>}
            {qr.state === 'match' && <div className="banner ok" style={{ marginTop: 8 }}>✓ QR on the cover matches: <span className="mono">{qr.code}</span></div>}
            {qr.state === 'mismatch' && <div className="banner crit" role="alert" style={{ marginTop: 8 }}>
              <b>Wrong student.</b> The QR on this script is <span className="mono">{qr.code}</span>
              {qr.owner ? <> — that is <b>{qr.owner.full_name}</b> ({qr.owner.matric_no})</> : ' — not a candidate in this session'}, but you chose {stagedRow?.full_name}. It can't be saved for them.
              {qr.owner && cands.some((r) => r.student_id === qr.owner!.student_id) &&
                <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => {
                  const st = { ...staged, studentId: qr.owner!.student_id, name: staged.method === 'snap' ? `${fileStem(qr.owner!.matric_no)}.pdf` : staged.name };
                  setScanFor(st.studentId); setRescan(false); setStaged(st); setQr({ state: 'match', code: qr.code });
                }}>Save it for {qr.owner.full_name} instead</button></div>}
            </div>}
            {qr.state === 'none' && <div className="banner warn" style={{ marginTop: 8 }}>
              <b>No readable QR label in this file.</b> Confirm the booklet is {stagedRow?.full_name}'s before saving:
              <div className="row" style={{ marginTop: 8, gap: 8 }}>
                {camCode ? <span className="small">✓ Booklet QR matched by camera: <span className="mono">{camCode}</span></span>
                  : <button className="btn sm" onClick={() => setCamera('confirm')}>Scan the booklet's QR with the camera</button>}
              </div>
              {!camCode && <label className="row small" style={{ marginTop: 8, gap: 6 }}>
                <input type="checkbox" checked={byEye} onChange={(e) => setByEye(e.target.checked)} />
                The label is damaged — I checked the student ID on the booklet by eye (recorded in the audit log)
              </label>}
            </div>}

            <div className="small muted" style={{ margin: '10px 0 4px' }}>SHA-256 fingerprint (the server recomputes it and refuses the file if the two differ)</div>
            <div className="hash" style={{ whiteSpace: 'normal', wordBreak: 'break-all', display: 'block', padding: 8 }}>{staged.hash}</div>
            {(stagedRow?.n_scans ?? 0) > 0 && <label className="row small" style={{ marginTop: 10, gap: 6 }}>
              <input type="checkbox" checked={rescan} onChange={(e) => setRescan(e.target.checked)} /> This is a rescan — replace the previous scan (kept as an older version)
            </label>}
            {(stagedRow?.n_scans ?? 0) > 0 && !rescan && <div className="small" style={{ color: 'var(--med)', marginTop: 6 }}>This student already has a scan. Saving without “rescan” flags a duplicate.</div>}
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn" onClick={reset} disabled={saving}>Discard</button>
              <button className="btn pri" onClick={save} disabled={saving || !live || !proof}>{saving ? 'Saving…' : 'Save to archive'}</button>
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
      {camera === 'pick' && <QrScanner once title="Scan the booklet's QR label" hint="The student it belongs to is selected for scanning."
        onClose={() => setCamera(null)}
        onCode={async (code) => {
          const m = await pick(code);
          if (m) { toast(m); return { ok: false, text: m }; }
          setCamera(null);
        }} />}
      {camera === 'confirm' && stagedRow && <QrScanner once title={`Confirm: ${stagedRow.full_name}`} hint="Hold the booklet's QR label inside the frame."
        onClose={() => setCamera(null)}
        onCode={(code) => {
          setCamera(null);
          if (normCode(code) === codeOf(stagedRow)) { setCamCode(normCode(code)); return; }
          const o = ownerOf(code);
          toast(`That label is ${normCode(code)}${o ? ` (${o.full_name})` : ''} — not ${stagedRow.full_name}'s`);
        }} />}
    </div>
  );
}

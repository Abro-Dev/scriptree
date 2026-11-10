// register-file — the only way a file enters the ScripTree archive (exam scans and student documents).
//
// 1. The browser uploads to <bucket>/incoming/<uid>/<anything> (storage policy allows only that).
// 2. It calls this function with the path and what the file belongs to.
// 3. We download the bytes, check the signature and size, compute SHA-256 HERE,
//    move the object into archive/, and record it via a service-role-only SQL function
//    that re-checks the caller's role and writes the audit entry.
//
// Deploy:  npx supabase functions deploy register-file
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jwtClaims(token: string): Record<string, unknown> {
  // signature already verified by auth.getUser(); we only read the aal claim
  const part = token.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(atob(b64));
}

async function sha256Hex(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface ScriptBody {
  kind: 'script';
  path: string;
  name: string;
  session_id: string;
  student_id: string;
  method: 'pdf' | 'snap';
  pages?: number | null;
  rescan?: boolean;
}
interface DocBody { kind: 'doc'; path: string; name: string; doc_type: string }

/** File type from its first bytes — never trust the extension or the browser's MIME type. */
function sniff(b: Uint8Array): 'pdf' | 'jpg' | 'png' | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d) return 'pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  return null;
}

/** Size of the uploaded object from storage metadata, so an oversized upload is refused without downloading it. */
async function uploadSize(admin: ReturnType<typeof createClient>, bucket: string, path: string): Promise<number | null> {
  const { data } = await admin.rpc('upload_size', { p_bucket: bucket, p_path: path });
  return typeof data === 'number' ? data : data == null ? null : Number(data);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) return json(401, { error: 'Sign in again' });
  const uid = userData.user.id;
  const aal = String(jwtClaims(token).aal ?? 'aal1');

  let raw: ScriptBody | DocBody;
  try { raw = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  if (raw?.kind === 'doc') return registerDoc(admin, uid, raw);
  if (raw?.kind !== 'script') return json(400, { error: 'Unknown file kind' });
  const body = raw;

  const bucket = 'scans';
  const prefix = `incoming/${uid}/`;
  const path = String(body.path ?? '');
  if (!path.startsWith(prefix) || path.includes('..') || path.length > 300) return json(400, { error: 'Bad upload path' });
  if (!UUID.test(body.session_id ?? '') || !UUID.test(body.student_id ?? '')) return json(400, { error: 'Bad session or student' });
  if (body.method !== 'pdf' && body.method !== 'snap') return json(400, { error: 'Bad capture method' });
  const pages = body.pages == null ? null : Math.trunc(Number(body.pages));
  if (pages !== null && !(pages >= 1 && pages <= 500)) return json(400, { error: 'Bad page count' });
  const name = String(body.name ?? 'scan.pdf').replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'scan.pdf';

  const discard = () => admin.storage.from(bucket).remove([path]);

  const { data: settings } = await admin.from('settings').select('max_file_mb, allow_pdf_upload, allow_photo_snaps').single();
  const maxBytes = (settings?.max_file_mb ?? 20) * 1048576;
  const size = await uploadSize(admin, bucket, path);
  if (size == null) return json(400, { error: 'Upload not found — try again' });
  if (size === 0 || size > maxBytes) { await discard(); return json(400, { error: `File must be under ${settings?.max_file_mb ?? 20} MB` }); }

  const { data: blob, error: dlErr } = await admin.storage.from(bucket).download(path);
  if (dlErr || !blob) return json(400, { error: 'Upload not found — try again' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxBytes) { await discard(); return json(400, { error: `File must be under ${settings?.max_file_mb ?? 20} MB` }); }
  if (body.method === 'pdf' && settings && !settings.allow_pdf_upload) { await discard(); return json(400, { error: 'PDF upload is turned off in settings' }); }
  if (body.method === 'snap' && settings && !settings.allow_photo_snaps) { await discard(); return json(400, { error: 'Photo snaps are turned off in settings' }); }
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') { await discard(); return json(400, { error: 'Not a PDF (file signature check failed)' }); }

  const sha256 = await sha256Hex(bytes);
  const dest = `archive/${body.session_id}/${body.student_id}/${crypto.randomUUID()}.pdf`;
  const { error: mvErr } = await admin.storage.from(bucket).move(path, dest);
  if (mvErr) return json(500, { error: 'Could not archive the file' });

  const { data, error } = await admin.rpc('register_scan', {
    p_actor: uid, p_aal: aal, p_session: body.session_id, p_student: body.student_id,
    p_path: dest, p_name: name, p_size: bytes.length, p_sha256: sha256,
    p_method: body.method, p_pages: pages, p_rescan: Boolean(body.rescan),
  });
  if (error) {
    await admin.storage.from(bucket).remove([dest]);
    return json(error.code === '42501' ? 403 : 400, { error: error.message });
  }
  const row = Array.isArray(data) ? data[0] : data;
  return json(200, { ...row, sha256, size: bytes.length });
});

// ---------------------------------------------------------------------
// Student documents: PDF, JPEG or PNG into documents/archive/<student-user>/...
async function registerDoc(admin: ReturnType<typeof createClient>, uid: string, body: DocBody) {
  const bucket = 'documents';
  const path = String(body.path ?? '');
  if (!path.startsWith(`incoming/${uid}/`) || path.includes('..') || path.length > 300) return json(400, { error: 'Bad upload path' });
  if (!/^[a-z]{2,20}$/.test(String(body.doc_type ?? ''))) return json(400, { error: 'Bad document type' });
  const name = String(body.name ?? 'document').replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'document';
  const discard = () => admin.storage.from(bucket).remove([path]);

  const { data: settings } = await admin.from('settings').select('max_file_mb').single();
  const maxMb = (settings as { max_file_mb?: number } | null)?.max_file_mb ?? 20;
  const size = await uploadSize(admin, bucket, path);
  if (size == null) return json(400, { error: 'Upload not found — try again' });
  if (size === 0 || size > maxMb * 1048576) { await discard(); return json(400, { error: `File must be under ${maxMb} MB` }); }

  const { data: blob, error: dlErr } = await admin.storage.from(bucket).download(path);
  if (dlErr || !blob) return json(400, { error: 'Upload not found — try again' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maxMb * 1048576) { await discard(); return json(400, { error: `File must be under ${maxMb} MB` }); }
  const type = sniff(bytes);
  if (!type) { await discard(); return json(400, { error: 'Upload a PDF, JPEG or PNG' }); }

  const sha256 = await sha256Hex(bytes);
  const dest = `archive/${uid}/${crypto.randomUUID()}.${type}`;
  const { error: mvErr } = await admin.storage.from(bucket).move(path, dest);
  if (mvErr) return json(500, { error: 'Could not archive the file' });

  const { data, error } = await admin.rpc('register_document', {
    p_actor: uid, p_doc_type: body.doc_type, p_path: dest, p_name: name, p_size: bytes.length, p_sha256: sha256,
  });
  if (error) {
    await admin.storage.from(bucket).remove([dest]);
    return json(error.code === '42501' ? 403 : 400, { error: error.message });
  }
  const row = Array.isArray(data) ? data[0] : data;
  return json(200, { ...row, sha256, size: bytes.length });
}

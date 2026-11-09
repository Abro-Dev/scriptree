// integrity-check — re-hash every active archived file and compare with the SHA-256 recorded at upload.
//
// Called two ways:
//   * by an exams officer ("Verify all files") — user JWT, must be officer at AAL2
//   * by the nightly schedule (Phase 6) — x-scriptree-cron header (secret kept in Vault)
//
// Deploy:  npx supabase functions deploy integrity-check
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  try { return JSON.parse(atob(b64)); } catch { return {}; }
}
async function sha256Hex(bytes: Uint8Array) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

  let actor: string | null = null;
  const cronHeader = req.headers.get('x-scriptree-cron');
  const { data: isCron } = cronHeader ? await admin.rpc('is_cron_request', { p_token: cronHeader }) : { data: false };
  if (isCron !== true) {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) return json(401, { error: 'Sign in again' });
    const { data: p } = await admin.from('profiles').select('role, status').eq('id', data.user.id).single();
    if (!p || p.status !== 'active' || p.role !== 'officer') return json(403, { error: 'Only exams officers can run integrity checks' });
    if (jwtClaims(token).aal !== 'aal2') return json(403, { error: 'Two-factor required' });
    actor = data.user.id;
  }

  const results: { file_id: string; ok: boolean; computed: string }[] = [];
  const PAGE = 500;
  for (let from = 0; ; from += PAGE) {
    const { data: files, error } = await admin.from('files').select('id, kind, storage_path, sha256')
      .eq('active', true).order('file_no').range(from, from + PAGE - 1);
    if (error) return json(500, { error: error.message });
    // a few at a time: bounded memory, still reasonably fast
    for (let i = 0; i < files.length; i += 8) {
      await Promise.all(files.slice(i, i + 8).map(async (f) => {
        const bucket = f.kind === 'script' ? 'scans' : 'documents';
        const { data: blob, error: dlErr } = await admin.storage.from(bucket).download(f.storage_path);
        // a missing object is a failed check, not a skipped one
        const computed = dlErr || !blob ? 'missing' : await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
        results.push({ file_id: f.id, ok: computed === f.sha256, computed });
      }));
    }
    if (files.length < PAGE) break;
  }

  const { data, error } = await admin.rpc('record_integrity_run', { p_actor: actor, p_results: results });
  if (error) return json(500, { error: error.message });
  const row = Array.isArray(data) ? data[0] : data;

  // Nightly run only: delete abandoned uploads (in incoming/ for more than a day — the upload
  // happened but register-file never ran or rejected it). Archived files are never touched.
  let purged = 0;
  if (!actor) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const bucket of ['scans', 'documents']) {
      const { data: folders } = await admin.storage.from(bucket).list('incoming', { limit: 1000 });
      for (const dir of folders ?? []) {
        if (dir.id) continue; // folders have no id
        const { data: objs } = await admin.storage.from(bucket).list(`incoming/${dir.name}`, { limit: 1000 });
        const old = (objs ?? []).filter((o) => o.id && new Date(o.created_at).getTime() < cutoff).map((o) => `incoming/${dir.name}/${o.name}`);
        if (old.length) { await admin.storage.from(bucket).remove(old); purged += old.length; }
      }
    }
  }
  return json(200, { checked: row.checked, failed: row.failed, purged, failed_ids: results.filter((r) => !r.ok).map((r) => r.file_id) });
});

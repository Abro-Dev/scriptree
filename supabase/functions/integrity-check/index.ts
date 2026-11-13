// integrity-check — re-hash every archived file (current and superseded versions) and compare with the SHA-256 recorded at upload.
//
// Works in resumable batches so a large archive never outlives the edge-function time limit:
//   * each invocation claims the open run (integrity_runs), checks files in file_no order from the run's
//     cursor, records every page as it goes (integrity_run_batch), and stops after TIME_BUDGET_MS;
//   * the next invocation continues from the cursor; the last one closes the run (audit entry + email).
//
// Called by:
//   * an exams officer ("Verify all files") — user JWT, officer at AAL2. Body { run_id? }; the app keeps
//     calling with the returned run_id until done.
//   * pg_cron — x-scriptree-cron header (secret in Vault). Nightly: { scheduled: true } starts a run;
//     every 2 minutes while a run is open: { scheduled: true, continue: true } picks it up again.
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

const PAGE = 200;            // files per recorded batch
const PARALLEL = 8;          // downloads at a time (bounded memory)
const TIME_BUDGET_MS = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const started = Date.now();

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  let body: { run_id?: string; continue?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body */ }

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

  const runArg = body.run_id && UUID.test(body.run_id) ? body.run_id : null;
  const create = !(isCron === true && body.continue === true) && !runArg;
  const { data: claimRows, error: cErr } = await admin.rpc('integrity_run_claim', { p_actor: actor, p_run: runArg, p_create: create });
  if (cErr) return json(500, { error: cErr.message });
  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as { run_id: string; last_file_no: number; checked: number; ok: boolean } | undefined;
  if (!claim) return json(200, runArg ? { error: 'That check has already finished', done: true } : { done: true, idle: true });
  if (!claim.ok) return json(200, { done: false, busy: true, run_id: claim.run_id, checked: claim.checked });

  const runId = claim.run_id;
  let cursor = Number(claim.last_file_no);
  let checked = claim.checked;
  try {
    for (;;) {
      if (Date.now() - started > TIME_BUDGET_MS) {
        await admin.rpc('integrity_run_release', { p_run: runId });
        return json(200, { done: false, run_id: runId, checked });
      }
      const { data: files, error } = await admin.from('files').select('id, file_no, kind, storage_path, sha256')
        .gt('file_no', cursor).order('file_no').limit(PAGE);
      if (error) throw new Error(error.message);
      if (!files.length) break;

      const results: { file_id: string; ok: boolean; computed: string }[] = [];
      for (let i = 0; i < files.length; i += PARALLEL) {
        await Promise.all(files.slice(i, i + PARALLEL).map(async (f) => {
          const bucket = f.kind === 'script' ? 'scans' : 'documents';
          const { data: blob, error: dlErr } = await admin.storage.from(bucket).download(f.storage_path);
          // a missing object is a failed check, not a skipped one
          const computed = dlErr || !blob ? 'missing' : await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
          results.push({ file_id: f.id, ok: computed === f.sha256, computed });
        }));
      }
      const last = Number(files[files.length - 1].file_no);
      const { error: bErr } = await admin.rpc('integrity_run_batch', { p_run: runId, p_results: results, p_last_file_no: last });
      if (bErr) throw new Error(bErr.message);
      cursor = last;
      checked += results.length;
      if (files.length < PAGE) break;
    }
  } catch (e) {
    await admin.rpc('integrity_run_release', { p_run: runId });
    return json(500, { error: String((e as Error).message ?? e).slice(0, 300), run_id: runId });
  }

  const { data: fin, error: fErr } = await admin.rpc('integrity_run_finish', { p_run: runId });
  if (fErr) return json(500, { error: fErr.message });
  const row = (Array.isArray(fin) ? fin[0] : fin) as { checked: number; failed: number };

  // Scheduled runs only: delete abandoned uploads (in incoming/ for more than a day — the upload
  // happened but register-file never ran or rejected it). Archived files are never touched.
  let purged = 0;
  if (!actor) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const bucket of ['scans', 'documents']) {
      for (let offset = 0; ; offset += 1000) {
        const { data: folders } = await admin.storage.from(bucket).list('incoming', { limit: 1000, offset });
        for (const dir of folders ?? []) {
          if (dir.id) continue; // folders have no id
          const { data: objs } = await admin.storage.from(bucket).list(`incoming/${dir.name}`, { limit: 1000 });
          const old = (objs ?? []).filter((o) => o.id && new Date(o.created_at).getTime() < cutoff).map((o) => `incoming/${dir.name}/${o.name}`);
          if (old.length) { await admin.storage.from(bucket).remove(old); purged += old.length; }
        }
        if (!folders || folders.length < 1000) break;
      }
    }
  }
  return json(200, { done: true, run_id: runId, checked: row.checked, failed: row.failed, purged });
});

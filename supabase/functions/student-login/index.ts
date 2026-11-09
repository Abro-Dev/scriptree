// student-login — sign a student in by matric number or student ID, with rate limiting.
// Replaces the anonymous student_login_email() lookup, which revealed which matric numbers exist.
//
// Limits (failed attempts in the last 15 minutes): 5 per identifier, 30 per IP address.
// Unknown IDs and wrong passwords get the same answer.
//
// Deploy:  npx supabase functions deploy student-login
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const WINDOW_MIN = 15, PER_ID = 5, PER_IP = 30;
const GENERIC = 'Wrong matric number / student ID or password.';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  let body: { identifier?: string; password?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const identifier = String(body.identifier ?? '').trim().toUpperCase();
  const password = String(body.password ?? '');
  if (!/^([A-Z]{2,5}\/[0-9]{2}\/[0-9]{3,6}|ST[0-9]{4,10})$/.test(identifier) || password.length < 8 || password.length > 128) {
    return json(400, { error: GENERIC });
  }
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

  const since = new Date(Date.now() - WINDOW_MIN * 60000).toISOString();
  const [byId, byIp] = await Promise.all([
    admin.from('login_attempts').select('id', { count: 'exact', head: true }).eq('identifier', identifier).eq('ok', false).gte('at', since),
    ip ? admin.from('login_attempts').select('id', { count: 'exact', head: true }).eq('ip', ip).eq('ok', false).gte('at', since) : Promise.resolve({ count: 0 }),
  ]);
  if ((byId.count ?? 0) >= PER_ID || (byIp.count ?? 0) >= PER_IP) {
    return json(429, { error: `Too many attempts. Wait ${WINDOW_MIN} minutes and try again, or ask the ICT admin for a new password.` });
  }
  const record = (ok: boolean) => admin.from('login_attempts').insert({ identifier, ip, ok });

  const { data: email } = await admin.rpc('student_login_email', { p_identifier: identifier });
  if (!email) { await record(false); return json(401, { error: GENERIC }); }

  // sign in with a throwaway anon-key client; hand the tokens to the browser
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) { await record(false); return json(401, { error: GENERIC }); }
  await record(true);
  return json(200, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
});

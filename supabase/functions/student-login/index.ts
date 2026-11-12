// student-login — sign a student in by matric number or student ID, with rate limiting.
// Replaces the anonymous student_login_email() lookup, which revealed which matric numbers exist.
//
// Limits over 15 minutes, counting failures and attempts still in flight (login_attempt_begin, atomic):
//   5 per identifier from one IP · 20 per identifier from all IPs · 30 per IP.
// Unknown IDs and wrong passwords get the same answer. When the auth server itself is busy or
// rate-limited, the student is told to retry and the attempt doesn't count against them.
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

const WINDOW_MIN = 15;
const GENERIC = 'Wrong matric number / student ID or password.';
const BUSY = 'Sign-in is busy right now. Wait a few seconds and try again.';

/** Client address as seen by the platform's proxy (first hop of x-forwarded-for, unless a proxy header is set). */
function clientIp(req: Request): string | null {
  const direct = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
  if (direct) return direct.trim().slice(0, 64);
  const xff = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
  return xff ? xff.slice(0, 64) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  let body: { identifier?: string; password?: string };
  try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }
  const identifier = String(body.identifier ?? '').trim().toUpperCase();
  const password = String(body.password ?? '');
  if (!/^([A-Z]{2,5}\/[0-9]{2}[A-D]\/[A-Z]{2,5}\/[0-9]{3,6}|ST[0-9]{4,10})$/.test(identifier) || password.length < 8 || password.length > 128) {
    return json(400, { error: GENERIC });
  }
  const ip = clientIp(req);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

  // reserve an attempt atomically: parallel requests can't all slip under the limit
  const { data: attempt, error: aErr } = await admin.rpc('login_attempt_begin', { p_identifier: identifier, p_ip: ip });
  if (aErr) return json(503, { error: BUSY });
  if (attempt == null) {
    return json(429, { error: `Too many attempts. Wait ${WINDOW_MIN} minutes and try again, or ask the ICT admin for a new password.` });
  }
  const finish = (ok: boolean | null) => admin.rpc('login_attempt_end', { p_id: attempt, p_ok: ok });

  const { data: email, error: lErr } = await admin.rpc('student_login_email', { p_identifier: identifier });
  if (lErr) { await finish(null); return json(503, { error: BUSY }); }
  if (!email) { await finish(false); return json(401, { error: GENERIC }); }

  // sign in with a throwaway anon-key client; hand the tokens to the browser
  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    // only a credentials rejection is the student's fault; 429/5xx from the auth server is not
    const status = (error as { status?: number } | null)?.status ?? 0;
    const code = (error as { code?: string } | null)?.code ?? '';
    const wrong = code === 'invalid_credentials' || (status === 400 && !code);
    await finish(wrong ? false : null);
    return wrong ? json(401, { error: GENERIC }) : json(503, { error: BUSY });
  }
  await finish(true);
  return json(200, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
});

// send-alerts — delivers the notifications outbox by email. Called every 5 minutes by pg_cron
// (x-scriptree-cron header, checked against Vault by is_cron_request()). Uses Resend's HTTP API; any provider with an HTTP API can be swapped in.
//
// Secrets:  npx supabase secrets set RESEND_API_KEY=re_... ALERT_FROM="ScripTree <alerts@your-domain>"
// Deploy:   npx supabase functions deploy send-alerts
import { createClient } from 'npm:@supabase/supabase-js@2';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const MAX_ATTEMPTS = 5;

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: isCron } = await admin.rpc('is_cron_request', { p_token: req.headers.get('x-scriptree-cron') ?? '' });
  if (isCron !== true) return json(401, { error: 'Scheduled job only' });

  const { data: settings } = await admin.from('settings').select('alert_email').single();
  const to = settings?.alert_email as string | null;
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('ALERT_FROM') ?? 'ScripTree <onboarding@resend.dev>';

  const { data: queue, error } = await admin.from('notifications').select('id, subject, body, attempts')
    .is('sent_at', null).lt('attempts', MAX_ATTEMPTS).order('id').limit(20);
  if (error) return json(500, { error: error.message });

  const fail = (id: number, attempts: number, msg: string) =>
    admin.from('notifications').update({ attempts: attempts + 1, last_error: msg.slice(0, 500) }).eq('id', id);

  let sent = 0;
  for (const n of queue) {
    // configuration problems are recorded on the row (visible in Settings) without burning attempts
    if (!to) { await admin.from('notifications').update({ last_error: 'No alert email set in settings' }).eq('id', n.id); continue; }
    if (!apiKey) { await admin.from('notifications').update({ last_error: 'RESEND_API_KEY is not set on the edge function' }).eq('id', n.id); continue; }
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: n.subject, text: n.body }),
      });
      if (!r.ok) { await fail(n.id, n.attempts, `Email provider ${r.status}: ${await r.text()}`); continue; }
      await admin.from('notifications').update({ sent_at: new Date().toISOString(), sent_to: to, attempts: n.attempts + 1, last_error: null }).eq('id', n.id);
      sent++;
    } catch (e) {
      await fail(n.id, n.attempts, String(e));
    }
  }
  return json(200, { sent, queued: queue.length });
});

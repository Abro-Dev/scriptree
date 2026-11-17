// send-alerts — delivers the notifications outbox by email: office alerts to the alert email in settings,
// and student emails (e.g. results published) to the address on the row. Called every 5 minutes by pg_cron
// (x-scriptree-cron header, checked against Vault by is_cron_request()). Uses Resend's HTTP API; any provider with an HTTP API can be swapped in.
//
// Secrets:  npx supabase secrets set RESEND_API_KEY=re_... ALERT_FROM="ScripTree <alerts@scriptree.dev>"
//           (optional) SITE_URL=https://scriptree.dev, where the alert's button links (design: ../_shared/email.ts)
// Deploy:   npx supabase functions deploy send-alerts
import { createClient } from 'npm:@supabase/supabase-js@2';
import { alertEmail } from '../_shared/email.ts';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const MAX_ATTEMPTS = 5;
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://scriptree.dev').replace(/\/+$/, '');
const STUDENT_BATCH = 60;   // per 5-minute run: 720 student emails an hour
const SEND_GAP_MS = 550;    // stays under the email provider's default 2 requests a second
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: isCron } = await admin.rpc('is_cron_request', { p_token: req.headers.get('x-scriptree-cron') ?? '' });
  if (isCron !== true) return json(401, { error: 'Scheduled job only' });

  const { data: settings } = await admin.from('settings').select('alert_email').single();
  const to = settings?.alert_email as string | null;
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('ALERT_FROM') ?? 'ScripTree <alerts@scriptree.dev>';

  // office alerts first, then student emails (results published); a burst of student mail never delays an alert
  const cols = 'id, kind, subject, body, attempts, created_at, to_email';
  const [office, students] = await Promise.all([
    admin.from('notifications').select(cols).is('sent_at', null).is('to_email', null).lt('attempts', MAX_ATTEMPTS).order('id').limit(20),
    admin.from('notifications').select(cols).is('sent_at', null).not('to_email', 'is', null).lt('attempts', MAX_ATTEMPTS).order('id').limit(STUDENT_BATCH),
  ]);
  const error = office.error ?? students.error;
  if (error) return json(500, { error: error.message });
  const queue = [...office.data, ...students.data];

  const fail = (id: number, attempts: number, msg: string) =>
    admin.from('notifications').update({ attempts: attempts + 1, last_error: msg.slice(0, 500) }).eq('id', id);

  let sent = 0, tried = 0;
  for (const n of queue) {
    const dest = (n.to_email as string | null) ?? to;
    // configuration problems are recorded on the row (visible in Settings) without burning attempts
    if (!dest) { await admin.from('notifications').update({ last_error: 'No alert email set in settings' }).eq('id', n.id); continue; }
    if (!apiKey) { await admin.from('notifications').update({ last_error: 'RESEND_API_KEY is not set on the edge function' }).eq('id', n.id); continue; }
    if (tried++) await pause(SEND_GAP_MS);
    try {
      const mail = alertEmail(n, SITE_URL);
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [dest], subject: mail.subject, html: mail.html, text: mail.text }),
      });
      if (!r.ok) { await fail(n.id, n.attempts, `Email provider ${r.status}: ${await r.text()}`); continue; }
      await admin.from('notifications').update({ sent_at: new Date().toISOString(), sent_to: dest, attempts: n.attempts + 1, last_error: null }).eq('id', n.id);
      sent++;
    } catch (e) {
      await fail(n.id, n.attempts, String(e));
    }
  }
  return json(200, { sent, queued: queue.length });
});

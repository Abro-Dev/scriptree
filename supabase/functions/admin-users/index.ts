// admin-users — account management that needs the service role. Admin at AAL2 only.
//
// actions:
//   list                         staff accounts with last sign-in and two-factor status; student account counts
//   invite_staff                 { email, full_name, role, title? } → invite email to set a password
//   issue_student_passwords      { student_ids?: string[] }  (omit = every student without an account, max 500)
//                                creates accounts or resets passwords; returns one-time passwords to print,
//                                and emails each student with an email on record (Resend; send_email:false skips)
//   reset_mfa                    { user_id } → removes two-factor factors (lost phone); they enrol again
//
// Deploy:  npx supabase functions deploy admin-users
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const STUDENT_EMAIL_DOMAIN = 'students.scriptree.local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jwtClaims(token: string): Record<string, unknown> {
  const part = token.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  try { return JSON.parse(atob(b64)); } catch { return {}; }
}

/** 12 chars from an alphabet without look-alikes (0/O, 1/l/I), grouped for reading off a slip. */
function tempPassword() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint32Array(12));
  const s = Array.from(r, (n) => A[n % A.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function studentEmail(s: { full_name: string; matric_no: string; student_code: string; password: string }, site: string | null) {
  return [
    `Hello ${s.full_name},`,
    '',
    'An account has been set up for you on ScripTree, where you can follow your exam scripts and upload your documents.',
    '',
    `Sign in${site ? ` at ${site}` : ''} → Student, with:`,
    `  Matric number:      ${s.matric_no}   (or student ID ${s.student_code})`,
    `  One-time password:  ${s.password}`,
    '',
    'You will be asked to choose your own password straight away. The one-time password then stops working.',
    '',
    'If you did not expect this email, contact your exams office.',
  ].join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !u.user) return json(401, { error: 'Sign in again' });
  const { data: me } = await admin.from('profiles').select('role, status').eq('id', u.user.id).single();
  if (!me || me.role !== 'admin' || me.status !== 'active') return json(403, { error: 'Admins only' });
  if (jwtClaims(token).aal !== 'aal2') return json(403, { error: 'Two-factor required' });
  const actor = u.user.id;
  const audit = (action: string, detail: string) => admin.rpc('audit_as', { p_actor: actor, p_action: action, p_detail: detail });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'Bad request' }); }

  // ------------------------------------------------------------------
  if (body.action === 'list') {
    const authUsers: { id: string; last_sign_in_at?: string; factors?: { status: string }[] }[] = [];
    for (let page = 1; page < 50; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return json(500, { error: error.message });
      authUsers.push(...data.users);
      if (data.users.length < 1000) break;
    }
    const byId = new Map(authUsers.map((x) => [x.id, x]));
    const { data: staff, error } = await admin.from('profiles').select('id, role, full_name, email, title, status, last_sign_in_at, created_at')
      .neq('role', 'student').order('role').order('full_name');
    if (error) return json(500, { error: error.message });
    const { count: total } = await admin.from('students').select('id', { count: 'exact', head: true });
    const { count: withAccount } = await admin.from('students').select('id', { count: 'exact', head: true }).not('user_id', 'is', null);
    return json(200, {
      staff: staff.map((p) => {
        const a = byId.get(p.id);
        return { ...p, mfa: (a?.factors ?? []).some((f) => f.status === 'verified'), last_sign_in_at: a?.last_sign_in_at ?? p.last_sign_in_at, invited_pending: !a?.last_sign_in_at };
      }),
      students: { total: total ?? 0, with_account: withAccount ?? 0 },
    });
  }

  // ------------------------------------------------------------------
  if (body.action === 'invite_staff') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const full_name = String(body.full_name ?? '').trim().slice(0, 120);
    const role = String(body.role ?? '');
    const title = String(body.title ?? '').trim().slice(0, 80) || null;
    if (!EMAIL.test(email)) return json(400, { error: 'Enter a valid staff email' });
    if (email.endsWith('@' + STUDENT_EMAIL_DOMAIN)) return json(400, { error: 'That address is reserved for student accounts' });
    if (full_name.length < 2) return json(400, { error: 'Enter the full name' });
    if (!['admin', 'officer', 'invigilator'].includes(role)) return json(400, { error: 'Choose a role' });
    const redirectTo = String(body.redirect_to ?? '') || undefined;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
    if (error) return json(400, { error: error.message.includes('already') ? 'An account with that email already exists' : error.message });
    const { error: pErr } = await admin.from('profiles').insert({ id: data.user.id, role, full_name, email, title });
    if (pErr) { await admin.auth.admin.deleteUser(data.user.id); return json(400, { error: pErr.message }); }
    await audit('Create account', `${full_name} — ${role} (invite sent to ${email})`);
    return json(200, { id: data.user.id });
  }

  // ------------------------------------------------------------------
  if (body.action === 'issue_student_passwords') {
    const ids = Array.isArray(body.student_ids) ? (body.student_ids as unknown[]).map(String).filter((x) => UUID.test(x)) : null;
    let q = admin.from('students').select('id, user_id, matric_no, student_code, full_name, email').order('matric_no').limit(500);
    q = ids ? q.in('id', ids.slice(0, 500)) : q.is('user_id', null);
    const { data: list, error } = await q;
    if (error) return json(500, { error: error.message });

    const slips: { matric_no: string; student_code: string; full_name: string; email: string | null; password: string; new_account: boolean }[] = [];
    const failed: { matric_no: string; reason: string }[] = [];
    for (const s of list) {
      const password = tempPassword();
      if (s.user_id) {
        const { error: e } = await admin.auth.admin.updateUserById(s.user_id, { password });
        if (e) { failed.push({ matric_no: s.matric_no, reason: e.message }); continue; }
        await admin.from('profiles').update({ must_change_password: true, status: 'active' }).eq('id', s.user_id);
        slips.push({ ...s, password, new_account: false });
      } else {
        const email = `${s.student_code.toLowerCase()}@${STUDENT_EMAIL_DOMAIN}`;
        const { data: cu, error: e } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
        if (e) { failed.push({ matric_no: s.matric_no, reason: e.message }); continue; }
        const { error: pe } = await admin.from('profiles').insert({ id: cu.user.id, role: 'student', full_name: s.full_name, email, must_change_password: true });
        const { error: le } = pe ? { error: pe } : await admin.from('students').update({ user_id: cu.user.id }).eq('id', s.id);
        if (pe || le) { await admin.auth.admin.deleteUser(cu.user.id); failed.push({ matric_no: s.matric_no, reason: (pe ?? le)!.message }); continue; }
        slips.push({ ...s, password, new_account: true });
      }
    }
    const created = slips.filter((x) => x.new_account).length, reset = slips.length - created;

    // Email each student their details. The password only travels in the email; nothing is stored.
    const emailed = new Set<string>();
    let emailProblem: string | null = null;
    const toSend = body.send_email === false ? [] : slips.filter((s) => s.email);
    const apiKey = Deno.env.get('RESEND_API_KEY');
    if (toSend.length && !apiKey) emailProblem = 'Email isn’t set up (RESEND_API_KEY missing), so nothing was emailed. Print the slips instead.';
    else if (toSend.length) {
      const from = Deno.env.get('STUDENT_FROM') ?? Deno.env.get('ALERT_FROM') ?? 'ScripTree <onboarding@resend.dev>';
      const site = /^https?:\/\/[^\s/]+$/.test(String(body.login_url ?? '')) ? String(body.login_url) : null;
      for (let i = 0; i < toSend.length; i += 100) {   // Resend batch limit
        const batch = toSend.slice(i, i + 100);
        try {
          const r = await fetch('https://api.resend.com/emails/batch', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(batch.map((s) => ({ from, to: [s.email], subject: 'Your ScripTree sign-in details', text: studentEmail(s, site) }))),
          });
          if (r.ok) batch.forEach((s) => emailed.add(s.matric_no));
          else emailProblem = `Email provider ${r.status}: ${(await r.text()).slice(0, 200)}`;
        } catch (e) { emailProblem = `Email failed: ${String(e).slice(0, 200)}`; }
      }
    }

    if (slips.length) await audit('Issue student passwords', `${created} accounts created, ${reset} passwords reset, ${emailed.size} emailed${failed.length ? `, ${failed.length} failed` : ''}`);
    return json(200, {
      slips: slips.map(({ matric_no, student_code, full_name, email, password }) => ({ matric_no, student_code, full_name, email, password, emailed: emailed.has(matric_no) })),
      failed, more: !ids && list.length === 500, email_problem: emailProblem,
    });
  }

  // ------------------------------------------------------------------
  if (body.action === 'reset_mfa') {
    const id = String(body.user_id ?? '');
    if (!UUID.test(id)) return json(400, { error: 'Bad user' });
    if (id === actor) return json(400, { error: 'Ask another admin to reset your own two-factor' });
    const { data: p } = await admin.from('profiles').select('full_name, role').eq('id', id).single();
    if (!p || p.role === 'student') return json(400, { error: 'No such staff account' });
    const { data: f, error } = await admin.auth.admin.mfa.listFactors({ userId: id });
    if (error) return json(500, { error: error.message });
    for (const x of f.factors) await admin.auth.admin.mfa.deleteFactor({ userId: id, id: x.id });
    await audit('Reset two-factor', `${p.full_name} — ${p.role}`);
    return json(200, { removed: f.factors.length });
  }

  return json(400, { error: 'Unknown action' });
});

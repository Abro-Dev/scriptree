// ScripTree email design. One layout for every message, written for email clients: tables, inline
// styles, a hosted PNG logo (Gmail and Outlook drop SVG) and a plain-text twin for every HTML body.
//
// Used by the edge functions (student sign-in details, alerts) and by scripts/build-email-templates.mjs,
// which renders the Supabase Auth templates in supabase/templates/. Pure TypeScript: no Deno or Node APIs.

export const BRAND = {
  ink: '#18203a', ink2: '#4a5372', ink3: '#8189a3', line: '#e4e8f4', bg: '#eef1fb', card: '#ffffff',
  cobalt: '#2340a8', cobaltL: '#e8edff', sun: '#ffc83d', sunL: '#fff5d6',
  coral: '#e0452f', coralL: '#ffe9e5', mint: '#21a67a', mintL: '#e0f6ee', grape: '#7b5cd6', grapeL: '#efeafe',
};
const FONT = `'Nunito Sans','Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const DISPLAY = `'Rubik','Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `'IBM Plex Mono',ui-monospace,Consolas,'Courier New',monospace`;

export type Tone = 'brand' | 'critical' | 'warning' | 'ok' | 'info';
const TONES: Record<Tone, { fg: string; bg: string; bar: string }> = {
  brand: { fg: BRAND.cobalt, bg: BRAND.cobaltL, bar: BRAND.cobalt },
  critical: { fg: BRAND.coral, bg: BRAND.coralL, bar: BRAND.coral },
  warning: { fg: '#9a6b00', bg: BRAND.sunL, bar: BRAND.sun },
  ok: { fg: BRAND.mint, bg: BRAND.mintL, bar: BRAND.mint },
  info: { fg: BRAND.grape, bg: BRAND.grapeL, bar: BRAND.grape },
};

/** Escape text for HTML. Values that are already markup (or Go template tags) are passed through raw(). */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// ---------------------------------------------------------------------------------------------- blocks
export const p = (html: string) =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:${BRAND.ink2}">${html}</p>`;

export const small = (html: string) =>
  `<p style="margin:0 0 12px;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.ink3}">${html}</p>`;

/** The one call to action. Bulletproof: a padded link inside a coloured cell, so it renders without images. */
export function button(label: string, href: string, tone: Tone = 'brand') {
  const bg = tone === 'critical' ? BRAND.coral : BRAND.cobalt;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr>
  <td align="center" bgcolor="${bg}" style="border-radius:12px;background:${bg}">
    <a href="${href}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${DISPLAY};font-style:normal;font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:12px">${label}&nbsp;&rarr;</a>
  </td></tr></table>`;
}

/** "Button not working?" with the raw link, for clients that block buttons. */
export const fallbackLink = (href: string) =>
  small(`Button not working? Copy this link into your browser:<br><a href="${href}" style="color:${BRAND.cobalt};word-break:break-all">${href}</a>`);

/** Label/value rows in a soft panel, e.g. role, student ID, course. Values are HTML. */
export function details(rows: [string, string][], tone: Tone = 'brand') {
  const t = TONES[tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;background:${t.bg};border-radius:12px">
  ${rows.map(([k, v], i) => `<tr>
    <td style="padding:${i ? 6 : 14}px 0 ${i === rows.length - 1 ? 14 : 6}px 18px;font-family:${FONT};font-size:13px;color:${BRAND.ink3};white-space:nowrap;vertical-align:top;width:1%">${esc(k)}</td>
    <td style="padding:${i ? 6 : 14}px 18px ${i === rows.length - 1 ? 14 : 6}px 16px;font-family:${FONT};font-size:14px;font-weight:700;color:${BRAND.ink}">${v}</td></tr>`).join('')}
  </table>`;
}

/** A code to type or read off: one-time passwords, reauthentication codes. */
export const codeBox = (code: string, caption: string) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px"><tr>
  <td align="center" style="padding:18px 16px;border:2px dashed ${BRAND.ink3};border-radius:14px;background:#fbfcff">
    <div style="font-family:${FONT};font-size:12px;letter-spacing:1px;text-transform:uppercase;color:${BRAND.ink3};margin-bottom:6px">${esc(caption)}</div>
    <div style="font-family:${MONO};font-size:26px;letter-spacing:3px;font-weight:600;color:${BRAND.ink}">${code}</div>
  </td></tr></table>`;

/** Numbered steps. Items are HTML. */
export function steps(items: string[]) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px">
  ${items.map((it, i) => `<tr>
    <td style="width:28px;padding:0 12px 12px 0;vertical-align:top"><div style="width:26px;height:26px;line-height:26px;border-radius:13px;background:${BRAND.sun};text-align:center;font-family:${DISPLAY};font-style:normal;font-size:13px;font-weight:700;color:${BRAND.ink}">${i + 1}</div></td>
    <td style="padding:3px 0 12px;font-family:${FONT};font-size:15px;line-height:22px;color:${BRAND.ink2};vertical-align:top">${it}</td></tr>`).join('')}
  </table>`;
}

/** A tinted note, e.g. "didn't ask for this?" or what to do next. */
export function note(html: string, tone: Tone = 'warning') {
  const t = TONES[tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px"><tr>
  <td style="padding:14px 16px;background:${t.bg};border-left:4px solid ${t.bar};border-radius:8px;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.ink2}">${html}</td>
  </tr></table>`;
}

// ---------------------------------------------------------------------------------------------- layout
export interface Layout {
  site: string;            // https://scriptree.dev (or a Go template tag, for Auth templates)
  title: string;           // the <title>, and the heading unless `heading` is given (plain text)
  heading?: string;        // HTML
  eyebrow: string;         // small label above the heading, e.g. "Staff invitation"
  tone?: Tone;
  preheader: string;       // the grey preview line in the inbox
  body: string;            // HTML blocks
  reason: string;          // footer: why you got this (plain text)
}

export function layout(o: Layout) {
  const t = TONES[o.tone ?? 'brand'];
  const host = o.site.replace(/^https?:\/\//, '');
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(o.title)}</title>
<style>
  @media (max-width:620px){ .card{border-radius:0!important} .pad{padding-left:22px!important;padding-right:22px!important} .h1{font-size:22px!important;line-height:28px!important} }
  a{color:${BRAND.cobalt}}
</style>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(o.preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.bg}" style="background:${BRAND.bg}">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px">

    <!-- brand -->
    <tr><td style="padding:0 6px 18px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;padding-right:10px"><a href="${o.site}" target="_blank"><img src="${o.site}/email/logo.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:10px"></a></td>
        <td style="vertical-align:middle;font-family:${DISPLAY};font-style:normal;font-size:20px;font-weight:700;letter-spacing:-0.2px;color:${BRAND.ink}">ScripTree</td>
      </tr></table>
    </td></tr>

    <!-- card -->
    <tr><td class="card" bgcolor="${BRAND.card}" style="background:${BRAND.card};border-radius:18px;border:1px solid ${BRAND.line};overflow:hidden">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="height:5px;line-height:5px;font-size:0;background:${t.bar};border-radius:18px 18px 0 0">&nbsp;</td></tr>
        <tr><td class="pad" style="padding:34px 40px 30px">
          <div style="display:inline-block;margin:0 0 14px;padding:5px 12px;border-radius:999px;background:${t.bg};font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.6px;text-transform:uppercase;color:${t.fg}">${esc(o.eyebrow)}</div>
          <h1 class="h1" style="margin:0 0 18px;font-family:${DISPLAY};font-style:normal;font-size:25px;line-height:32px;font-weight:700;letter-spacing:-0.3px;color:${BRAND.ink}">${o.heading ?? esc(o.title)}</h1>
          ${o.body}
        </td></tr>
      </table>
    </td></tr>

    <!-- footer -->
    <tr><td align="center" style="padding:22px 24px 8px;font-family:${FONT};font-size:12px;line-height:19px;color:${BRAND.ink3}">
      <strong style="color:${BRAND.ink2}">ScripTree</strong> &middot; Every exam script, accounted for.<br>
      ${esc(o.reason)}<br>
      <a href="${o.site}" target="_blank" style="color:${BRAND.ink3};text-decoration:underline">${host}</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

// ------------------------------------------------------------------------------------ student details
export interface StudentDetails { full_name: string; matric_no: string; password: string }   // matric_no holds the student ID

export function studentDetailsEmail(s: StudentDetails, site: string) {
  const first = s.full_name.split(' ')[0];
  const html = layout({
    site, title: 'Your ScripTree sign-in details', eyebrow: 'Student account', tone: 'brand',
    heading: `Welcome to ScripTree, ${esc(first)}`,
    preheader: 'Your one-time password is inside. You will choose your own password when you sign in.',
    reason: 'You get this because your exams office set up a ScripTree account for you.',
    body: [
      p('Your exams office has set up a ScripTree account for you. You can follow every exam script from the hall to the records room, and upload your documents.'),
      details([['Student ID', `<span style="font-family:${MONO}">${esc(s.matric_no)}</span>`]]),
      codeBox(esc(s.password), 'One-time password'),
      steps([
        `Go to <a href="${site}" style="color:${BRAND.cobalt};font-weight:700">${esc(site.replace(/^https?:\/\//, ''))}</a> and choose <strong style="color:${BRAND.ink}">Student</strong>.`,
        'Enter your student ID and the one-time password above.',
        'Choose your own password. The one-time password stops working once you do.',
      ]),
      button('Sign in to ScripTree', site),
      note('<strong>Keep this to yourself.</strong> Nobody from ScripTree or your exams office will ask for your password. If you did not expect this email, contact your exams office.'),
    ].join(''),
  });
  const text = [
    `Hello ${s.full_name},`, '',
    'Your exams office has set up a ScripTree account for you, where you can follow your exam scripts and upload your documents.', '',
    `Sign in at ${site} → Student, with:`,
    `  Student ID:         ${s.matric_no}`,
    `  One-time password:  ${s.password}`, '',
    'You will be asked to choose your own password straight away. The one-time password then stops working.', '',
    'Nobody from ScripTree will ask for your password. If you did not expect this email, contact your exams office.',
  ].join('\n');
  return { subject: 'Your ScripTree sign-in details', html, text };
}

// ---------------------------------------------------------------------------------------------- alerts
const ALERT_KINDS: Record<string, { eyebrow: string; tone: Tone; cta: string; path: string; reason?: string }> = {
  session_closed: { eyebrow: 'Session closed · needs attention', tone: 'warning', cta: 'Review the session', path: '/alerts' },
  integrity_failure: { eyebrow: 'Integrity check failed', tone: 'critical', cta: 'Open the archive', path: '/archive' },
  audit_chain: { eyebrow: 'Audit log tampering', tone: 'critical', cta: 'Open the audit log', path: '/audit' },
  test: { eyebrow: 'Test alert', tone: 'ok', cta: 'Open settings', path: '/settings' },
};

/** Plain alert text (as written by the database) → HTML: paragraphs, and "  • " lines as a list. */
export function alertBodyHtml(body: string) {
  const out: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (!list.length) return;
    out.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px;border:1px solid ${BRAND.line};border-radius:12px">
      ${list.map((li, i) => `<tr><td style="padding:10px 16px;${i ? `border-top:1px solid ${BRAND.line};` : ''}font-family:${FONT};font-size:14px;line-height:20px;color:${BRAND.ink}">${li}</td></tr>`).join('')}</table>`);
    list = [];
  };
  for (const block of body.split(/\n{2,}/)) {
    const para: string[] = [];
    for (const line of block.split('\n')) {
      const m = /^\s*[•\-*]\s+(.*)$/.exec(line);
      if (m) {
        if (para.length) { out.push(p(para.join('<br>'))); para.length = 0; }
        // "BU/24C/IT/10778 Ada Obi — Missing script": emphasise what comes before the dash
        const [who, ...what] = m[1].split(' — ');
        list.push(what.length ? `<strong>${esc(who)}</strong> <span style="color:${BRAND.ink2}">— ${esc(what.join(' — '))}</span>` : esc(m[1]));
      } else if (line.trim()) {
        flush();
        para.push(/:\s*$/.test(line) ? `<strong style="color:${BRAND.ink}">${esc(line.trim())}</strong>` : esc(line.trim()));
      }
    }
    if (para.length) out.push(p(para.join('<br>')));
    flush();
  }
  return out.join('');
}

export function alertEmail(n: { kind: string; subject: string; body: string; created_at?: string }, site: string) {
  const k = ALERT_KINDS[n.kind] ?? { eyebrow: 'Alert', tone: 'warning' as Tone, cta: 'Open ScripTree', path: '' };
  const bare = n.subject.replace(/^ScripTree:\s*/, '');
  const title = bare.charAt(0).toUpperCase() + bare.slice(1);
  const when = n.created_at ? new Date(n.created_at).toUTCString().replace(' GMT', ' UTC') : null;
  const url = site + k.path;
  const html = layout({
    site, title: n.subject, heading: esc(title), eyebrow: k.eyebrow, tone: k.tone,
    preheader: n.body.split('\n').find((l) => l.trim())?.slice(0, 140) ?? title,
    reason: 'You get these because this address is the alert email in ScripTree → System settings.',
    body: alertBodyHtml(n.body) + button(k.cta, url, k.tone === 'critical' ? 'critical' : 'brand')
      + (when ? small(`Raised ${esc(when)}.`) : ''),
  });
  const text = `${n.body}\n\n—\n${k.cta}: ${url}\nYou get these because this address is the alert email in ScripTree → System settings.`;
  return { subject: n.subject, html, text };
}

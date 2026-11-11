// Renders the Supabase Auth email templates (invite, password reset, …) into supabase/templates/
// from the same design as the app's own emails (supabase/functions/_shared/email.ts).
//
//   npm run email:templates            then paste each file into Supabase → Authentication → Emails
//   SITE=https://staging.example npm run email:templates     (another domain)
//
// {{ .ConfirmationURL }}, {{ .Token }}, {{ .Data.* }} etc. are Supabase's Go template tags, filled in when sent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { button, codeBox, details, esc, fallbackLink, layout, note, p, small, steps } from '../supabase/functions/_shared/email.ts';

const SITE = (process.env.SITE || 'https://scriptree.dev').replace(/\/+$/, '');
const OUT = new URL('../supabase/templates/', import.meta.url);
const URL_TAG = '{{ .ConfirmationURL }}';
const ignore = (what) => note(`<strong>Didn’t expect this?</strong> ${what}`);

const T = {
  invite: {
    subject: 'You’re invited to ScripTree',
    title: 'You’re invited to ScripTree', eyebrow: 'Staff invitation', tone: 'brand',
    heading: '{{ if .Data.full_name }}Welcome aboard, {{ .Data.full_name }}{{ else }}You’re invited to ScripTree{{ end }}',
    preheader: 'Accept your invitation and choose a password to start using ScripTree.',
    reason: 'You get this because an administrator created a ScripTree staff account for this address.',
    body: [
      p('An administrator has created a ScripTree account for you. ScripTree follows every exam script from the hall to the records room, so nothing goes missing.'),
      '{{ if .Data.role_label }}' + details([['Your role', '{{ .Data.role_label }}'], ['Sign-in email', '{{ .Email }}']]) + '{{ end }}',
      steps([
        'Accept the invitation with the button below.',
        'Choose a password of at least 10 characters.',
        // printf: comparing a missing value directly is a template error (invites sent from the dashboard have no data)
        '{{ if eq (printf "%v" .Data.role_label) "Invigilator" }}You’re in. Your exam halls are waiting on your dashboard.{{ else }}Set up two-step sign-in with an authenticator app (Google Authenticator, Microsoft Authenticator or similar).{{ end }}',
      ]),
      button('Accept invitation', URL_TAG),
      fallbackLink(URL_TAG),
      ignore('If you weren’t expecting a ScripTree account, you can ignore this email and no account will be activated.'),
    ],
  },
  recovery: {
    subject: 'Reset your ScripTree password',
    title: 'Reset your password', eyebrow: 'Password reset', tone: 'brand',
    preheader: 'Use this link to choose a new ScripTree password.',
    reason: 'You get this because someone asked to reset the password for this ScripTree account.',
    body: [
      p('We received a request to reset the password for <strong style="color:#18203a">{{ .Email }}</strong>. Choose a new one with the button below.'),
      button('Choose a new password', URL_TAG),
      small('For your security, this link works once and expires soon. If it has expired, choose “Forgot password?” on the sign-in page again.'),
      fallbackLink(URL_TAG),
      ignore('If you didn’t ask for this, ignore this email. Your password stays the same. If it keeps happening, tell your administrator.'),
    ],
  },
  magic_link: {
    subject: 'Your ScripTree sign-in link',
    title: 'Your sign-in link', eyebrow: 'Sign in', tone: 'brand',
    preheader: 'One click to sign in to ScripTree.',
    reason: 'You get this because a sign-in link was requested for this ScripTree account.',
    body: [
      p('Use the button below to sign in to ScripTree as <strong style="color:#18203a">{{ .Email }}</strong>. The link works once and expires soon.'),
      button('Sign in to ScripTree', URL_TAG),
      fallbackLink(URL_TAG),
      ignore('If you didn’t ask to sign in, ignore this email. Nobody can sign in without this link.'),
    ],
  },
  confirmation: {
    subject: 'Confirm your ScripTree email',
    title: 'Confirm your email address', eyebrow: 'Confirm email', tone: 'brand',
    preheader: 'One step left: confirm this email address for ScripTree.',
    reason: 'You get this because this address was used for a ScripTree account.',
    body: [
      p('Confirm that <strong style="color:#18203a">{{ .Email }}</strong> is your email address to finish setting up your ScripTree account.'),
      button('Confirm email', URL_TAG),
      fallbackLink(URL_TAG),
      ignore('If you didn’t create a ScripTree account, ignore this email.'),
    ],
  },
  email_change: {
    subject: 'Confirm your new ScripTree email',
    title: 'Confirm your new email address', eyebrow: 'Email change', tone: 'info',
    preheader: 'Confirm the change to your ScripTree sign-in email.',
    reason: 'You get this because a change of sign-in email was requested for a ScripTree account.',
    body: [
      p('Your ScripTree sign-in email is being changed.'),
      details([['From', '{{ .Email }}'], ['To', '{{ .NewEmail }}']], 'info'),
      p('Confirm the change with the button below. Until you do, you keep signing in with the old address.'),
      button('Confirm new email', URL_TAG),
      fallbackLink(URL_TAG),
      ignore('If you didn’t ask for this change, don’t click the button, and tell your administrator straight away.'),
    ],
  },
  reauthentication: {
    subject: 'Your ScripTree confirmation code',
    title: 'Confirm it’s you', eyebrow: 'Security check', tone: 'info',
    preheader: 'Your ScripTree confirmation code is inside.',
    reason: 'You get this because a sensitive change was started on this ScripTree account.',
    body: [
      p('Enter this code in ScripTree to confirm the change you’re making. It expires in a few minutes.'),
      codeBox('{{ .Token }}', 'Confirmation code'),
      ignore('If you didn’t start a change, someone may know your password. Change it and tell your administrator.'),
    ],
  },

  // Security notifications (Authentication → Emails → Security): sent after the fact, no link to click
  password_changed_notification: {
    subject: 'Your ScripTree password was changed',
    title: 'Your password was changed', eyebrow: 'Security notice', tone: 'ok',
    preheader: 'The password for your ScripTree account was just changed.',
    reason: 'You get this because the password on this ScripTree account changed.',
    body: [
      p('The password for <strong style="color:#18203a">{{ .Email }}</strong> was just changed. If that was you, there’s nothing else to do.'),
      button('Open ScripTree', SITE),
      note('<strong>Wasn’t you?</strong> Reset your password from the sign-in page now, and tell your administrator.', 'critical'),
    ],
  },
  email_changed_notification: {
    subject: 'Your ScripTree sign-in email was changed',
    title: 'Your sign-in email was changed', eyebrow: 'Security notice', tone: 'info',
    preheader: 'The sign-in email for your ScripTree account was changed.',
    reason: 'You get this because the sign-in email on a ScripTree account changed.',
    body: [
      p('The email address used to sign in to your ScripTree account was just changed. From now on, sign in with the new address.'),
      note('<strong>Wasn’t you?</strong> Contact your administrator straight away so they can lock the account.', 'critical'),
    ],
  },
  mfa_factor_enrolled_notification: {
    subject: 'Two-step sign-in was turned on for ScripTree',
    title: 'Two-step sign-in is on', eyebrow: 'Security notice', tone: 'ok',
    preheader: 'An authenticator app was added to your ScripTree account.',
    reason: 'You get this because an authenticator app was added to this ScripTree account.',
    body: [
      p('An authenticator app was just added to <strong style="color:#18203a">{{ .Email }}</strong>. From now on, ScripTree will ask for a 6-digit code from it when you sign in.'),
      note('<strong>Wasn’t you?</strong> Tell your administrator straight away. They can remove the app and secure your account.', 'critical'),
    ],
  },
  mfa_factor_unenrolled_notification: {
    subject: 'Two-step sign-in was removed from ScripTree',
    title: 'An authenticator app was removed', eyebrow: 'Security notice', tone: 'warning',
    preheader: 'An authenticator app was removed from your ScripTree account.',
    reason: 'You get this because an authenticator app was removed from this ScripTree account.',
    body: [
      p('An authenticator app was removed from <strong style="color:#18203a">{{ .Email }}</strong>. This is normal if an administrator reset it after a lost phone. You’ll set up a new one next time you sign in.'),
      note('<strong>Didn’t expect this?</strong> Tell your administrator straight away.', 'critical'),
    ],
  },
};

mkdirSync(OUT, { recursive: true });
const index = [];
for (const [name, t] of Object.entries(T)) {
  const html = layout({ site: SITE, title: t.title, heading: t.heading ?? esc(t.title), eyebrow: t.eyebrow, tone: t.tone, preheader: t.preheader, reason: t.reason, body: t.body.join('') });
  writeFileSync(new URL(`${name}.html`, OUT), html);
  index.push(`| \`${name}.html\` | ${t.subject} |`);
}
writeFileSync(new URL('SUBJECTS.md', OUT), `# Auth email subjects\n\nGenerated by \`npm run email:templates\`. Paste each file's HTML into Supabase → Authentication → Emails, with this subject.\n\n| Template | Subject |\n|---|---|\n${index.join('\n')}\n`);
console.log(`Wrote ${index.length} templates to supabase/templates/ (site ${SITE})`);

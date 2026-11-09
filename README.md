# ScripTree

Every exam script, accounted for. ScripTree follows each answer booklet from the exam hall to the
records room, reconciles it against attendance and its scan, preserves a SHA-256-fingerprinted copy,
and raises an alert the moment something goes missing. **The paper script stays the official original.**

Stack: React 19 + Vite + TypeScript · Supabase (Postgres, Auth with TOTP two-factor, Storage, Edge Functions).

## Setup

1. **Supabase project.** In Authentication:
   - Providers → Email: turn off "Confirm email" and public sign-ups (accounts are created by the admin).
   - Multi-factor: TOTP enabled.
   - Policies: minimum password length 10.
   - URL Configuration: Site URL (and redirect URLs) = where the app runs, e.g. `http://localhost:5173`.
2. **Schema.** Run every file in `supabase/migrations/` in order (SQL editor), or
   `npx supabase link --project-ref <ref>` then `npx supabase db push`.
3. **Vault secret** for the scheduled jobs (SQL editor, real value):
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'scriptree_project_url');
   ```
   The jobs authenticate to the edge functions with `scriptree_cron_secret`, which a migration
   generates in Vault. No API key needs to be copied anywhere.
4. **Edge functions.** Each one checks the caller itself, so deploy with `--no-verify-jwt`
   (needed for `student-login`, which runs before sign-in, and for projects using the new API keys):
   ```sh
   for f in register-file integrity-check admin-users send-alerts student-login; do
     npx supabase functions deploy $f --no-verify-jwt
   done
   npx supabase secrets set RESEND_API_KEY=re_... ALERT_FROM="ScripTree <alerts@your-domain>"
   ```
   Alert emails use [Resend](https://resend.com) (verify your sending domain there). Without the key,
   alerts queue up and Settings shows why they haven't gone out.
5. **App.** `cp .env.example .env.local` and fill in the URL, anon key and service-role key, then
   `npm install`, `npm run seed` (demo accounts, prints the logins) and `npm run dev`.
6. **Check** in the app as admin: Settings shows "Nightly check scheduled · alert sender running";
   use **Send test email**.

## Deploy to Vercel

`.env.local` is never committed (it holds your keys), so Vercel needs the values set separately.

1. Import the GitHub repo in Vercel. `vercel.json` already sets the Vite build, `dist` output, the
   SPA rewrite (so deep links and refreshes don't 404) and asset caching.
2. Project → Settings → Environment Variables, for Production, Preview and Development:
   - `VITE_SUPABASE_URL`: from Supabase → Project Settings → API
   - `VITE_SUPABASE_ANON_KEY`: the anon / publishable key

   **Never add `SUPABASE_SERVICE_ROLE_KEY` to Vercel.** It's only for `npm run seed` on your machine,
   and any `VITE_` variable is bundled into the public JavaScript.
3. Redeploy after adding or changing variables. Vite bakes them in at build time.
4. In Supabase → Authentication → URL Configuration, set the Site URL to your Vercel domain and add
   `https://<your-domain>/**` to the redirect URLs, or invite and password-reset links will point at localhost.

| Edge function | Called by | Does |
|---|---|---|
| `register-file` | invigilator / officer / student | hashes + archives scans and documents |
| `integrity-check` | officer ("Verify all files"), nightly cron | re-hashes the archive; nightly also clears abandoned uploads |
| `admin-users` | admin | staff invites, student one-time passwords, role list, 2FA reset |
| `send-alerts` | cron, every 5 min | emails the notifications outbox, retries failures |
| `student-login` | sign-in screen | rate-limited student sign-in (5 failures / 15 min per ID, 30 per IP) |

## How security is enforced

- **Reads** go through Row Level Security. Each role sees only its own work: an invigilator sees only
  sessions assigned to them, a student only their own records.
- **Writes** never touch tables directly — API roles have no insert/update/delete grants. Every change
  goes through a `SECURITY DEFINER` function that checks the caller's role and writes an audit entry
  in the same transaction.
- **Two-factor**: `app_role()` returns nothing for an admin or exams officer below AAL2, so without the
  TOTP step the database grants them nothing — not just the UI.
- **Fingerprints are computed on the server.** Browsers can only upload into `incoming/<their-uid>/`;
  the `register-file` edge function hashes the bytes, checks the PDF signature and size limit, moves the
  file into `archive/`, and records it through `register_scan()`, which only the service role can call.
- **Student sign-in is rate-limited** server-side, and unknown IDs get the same answer as wrong passwords.
- **Alerts can't be lost**: events write to an email outbox in the same transaction; a job delivers and retries.
- **Audit log** is append-only (update/delete/truncate blocked by trigger) and hash-chained;
  `verify_audit_chain()` re-hashes it and reports the first altered entry.

## Sessions and performance

- **Inactivity sign-out**: 15 minutes without keyboard, mouse, touch or scroll in any tab signs the user out,
  with a one-minute warning first. The clock is shared across tabs and survives sleep or a browser restart.
  It ends only that browser's session (`scope: 'local'`), so a scan station elsewhere stays signed in.
  For server-side enforcement too, set Authentication → Sessions → *Inactivity timeout* to 15 min (paid plans).
- **API load**: shared reads (`current_alerts`, `session_summaries`, `dashboard_stats`, settings, document
  types) are cached for 20–60 s and deduplicated across screens, and any write clears the cache. Requests the
  API refused (429/503) back off with jitter and retry, and failed GETs retry the same way. Hall devices
  poll about every 15 s with jitter, never overlap, and pause in hidden tabs.
- **Bundle**: each screen is its own chunk, prefetched for the signed-in role. React and Supabase sit in
  separate vendor chunks, so a deploy doesn't invalidate them.
- **Database**: `20261109030000_performance.sql` adds the missing FK/filter indexes and a trigram index for
  audit search, and rewrites RLS so the caller's role is evaluated once per query, not per row.
- **Hosting**: serve `dist/` from a CDN with SPA fallback to `index.html`. Give `/assets/*` (hashed
  filenames) `Cache-Control: public, max-age=31536000, immutable` and `index.html` `no-cache`.
  Traffic to Supabase is already load-balanced by its gateway and the Supavisor connection pooler.

## Build plan

See [docs/build-plan.md](docs/build-plan.md).

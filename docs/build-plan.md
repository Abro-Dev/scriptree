# Build plan

Source of truth for scope: the ScripTree **Prototype** and **System Flow** artifacts (claude.ai).

| Phase | Scope | Status |
|---|---|---|
| 1 Foundations | Schema, RLS, audit chain, reconciliation SQL, role-checked write functions, sign-in for 4 roles, TOTP 2FA, shell, seed | ✅ Done |
| 2 Invigilator | Session list + open, exam hall: attendance (start/end/submission), headcount, script check-in, scan station (PDF upload + photo snaps → PDF), close session; `register-file` edge function for scans (pulled forward from Phase 6) | ✅ Done |
| 3 Exams officer | Dashboard, alerts + acknowledge, sessions + new session + CSV import, session reconciliation + resolve, script tracker + custody events (shared with invigilators as Script lookup), digital archive + verify-a-copy + Verify all (`integrity-check` edge function, pulled forward), document queue, audit log viewer + chain verify | ✅ Done |
| 4 Student | My exams (student-safe status labels), my documents (upload PDF/JPEG/PNG, re-upload after rejection, preservation receipt); `register-file` handles documents | ✅ Done |
| 5 Admin | Users & roles (invite staff by email, change role, suspend/reactivate, reset 2FA, permission matrix), student one-time passwords (bulk + single reset, printable slips / CSV, forced change at first sign-in), staff forgot-password, settings; `admin-users` edge function | ✅ Done |
| 6 Server jobs | Nightly integrity check via pg_cron + pg_net (service key in Vault; rescheduled when the time changes), abandoned-upload cleanup, email outbox + `send-alerts` (session closed with discrepancies, integrity failures, test email; retries), rate-limited `student-login` (anonymous lookup removed), job status + test email in Settings | ✅ Done |

## Open decisions / pending

- **Hosting**: undecided (school server vs cloud). Supabase cloud assumed for now.
- **QR labels on booklets**: check-in accepts the script ID already; scanning a QR is a later add-on.
- **Closing a session records unticked candidates as absent** (and says so in the audit entry), so no record
  stays "awaiting attendance" forever. Change if the exams office prefers to see them as a separate exception.
- **Hall counts refresh every 15 s** (polling). Supabase Realtime could replace this if the scan station and
  hall laptop need instant updates.
- **CSV import** needs a `matric_no` column. Unknown students are created only when the row also has
  `full_name, student_code, department, level`; otherwise they're listed as skipped. Student sign-in accounts
  for imported students come with Phase 5.
- **Alerts are computed live** by `current_alerts()` on each request. Fine for a department; for a whole
  university, cache results per session on close/reconcile.
- The seed only creates a scheduled session, so the dashboard starts empty until a session is run through
  the hall. A richer demo seed (closed sessions with discrepancies) can be added if wanted.
- **Students see plain statuses** (Complete / Absent / In progress / Under review by exams office), never
  internal outcome names such as "Integrity failure".
- **Students can't open their own uploaded files** yet (storage read is officer-only). The receipt shows the
  fingerprint instead. A signed-URL function could allow it later.
- **One document per type**: a new upload is allowed only when there's none yet or the last was rejected;
  older versions are kept, inactive.
- **Student passwords are admin-issued** one-time passwords on printed slips (students may not have email).
  They're shown once and never stored in readable form; a forgotten password means issuing a new slip.
- **Password rule** for chosen passwords: at least 10 characters with letters and a number. Also set the
  same minimum in Supabase → Authentication → Policies so the server enforces it too.
- **Large archives**: `integrity-check` re-hashes everything in one run. Edge functions have a wall-clock
  limit (about 150 s on the free plan, 400 s on paid). Past roughly a few thousand scans, split the run into
  batches (e.g. by file number range) or run it from a worker.
- **Email provider** is Resend; swapping in another provider means changing one `fetch` in `send-alerts`.

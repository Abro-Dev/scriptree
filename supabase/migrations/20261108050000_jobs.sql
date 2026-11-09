-- =====================================================================
-- Phase 6 — Server jobs
--   * notifications: an email outbox. Rows are added in the same transaction as the event
--     (session closed with discrepancies, integrity failure, test email); the send-alerts
--     edge function delivers them every 5 minutes and retries failures.
--   * pg_cron runs the nightly integrity check (time from settings) and the outbox sender.
--     The service-role key is read from Supabase Vault at run time — never stored here.
--   * login_attempts: for the rate-limited student-login edge function.
--
-- ONE-TIME SETUP after this migration (SQL editor, with your real values):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'scriptree_project_url');
--   select vault.create_secret('<service-role key>', 'scriptree_service_key');
-- =====================================================================

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------------
-- Outbox
-- ---------------------------------------------------------------------
create table public.notifications (
  id          bigint generated always as identity primary key,
  kind        text not null,              -- session_closed | integrity_failure | test
  subject     text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  sent_to     text,
  attempts    int not null default 0,
  last_error  text
);
create index notifications_unsent_idx on public.notifications (created_at) where sent_at is null;
alter table public.notifications enable row level security;
create policy notifications_read on public.notifications for select to authenticated using (public.app_role() in ('admin', 'officer'));
revoke insert, update, delete, truncate on public.notifications from anon, authenticated;

create or replace function public.enqueue_notification(p_kind text, p_subject text, p_body text) returns void
language sql security definer set search_path = public as $$
  insert into public.notifications (kind, subject, body) values (p_kind, left(p_subject, 200), p_body)
$$;
revoke execute on function public.enqueue_notification(text, text, text) from public, anon, authenticated;

-- Session closed → email if anything needs the exams office
create or replace function public.tg_session_closed() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_lines text; v_open int; c record;
begin
  select count(*), string_agg('  • ' || r.matric_no || ' ' || r.full_name || ' — ' || r.outcome, E'\n' order by r.severity, r.matric_no)
    into v_open, v_lines
  from public.reconcile_session(new.id) r where r.severity in ('crit', 'high', 'med') and not r.resolved;
  select * into c from public.session_counts(new.id);
  if v_open > 0 or (c.headcount is not null and c.headcount <> c.physical) then
    perform public.enqueue_notification('session_closed',
      'ScripTree: ' || new.course_code || ' closed with ' || v_open || ' discrepanc' || case when v_open = 1 then 'y' else 'ies' end,
      new.course_code || ' ' || new.course_title || ' · ' || new.exam_date || ' · ' || new.venue || E'\n\n'
      || 'Registered ' || c.registered || ', present ' || c.present || ', physical scripts ' || c.physical || ', scanned ' || c.scanned
      || coalesce(', headcount ' || c.headcount, '') || E'\n'
      || case when c.headcount is not null and c.headcount <> c.physical then E'Headcount does not match physical scripts received.\n' else '' end
      || case when v_open > 0 then E'\nNeeds attention:\n' || v_lines else '' end
      || E'\n\nOpen the session in ScripTree to resolve each one.');
  end if;
  return new;
end $$;

create trigger session_closed_notify after update of status on public.exam_sessions
for each row when (new.status = 'closed' and old.status is distinct from 'closed')
execute function public.tg_session_closed();

-- Integrity run: same as before, plus an email when anything failed
create or replace function public.record_integrity_run(p_actor uuid, p_results jsonb)
returns table (checked int, failed int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_run uuid := gen_random_uuid(); v_n int; v_bad int; v_detail text; v_list text;
begin
  insert into public.integrity_checks (file_id, ok, computed, run_id)
  select (e ->> 'file_id')::uuid, (e ->> 'ok')::boolean, e ->> 'computed', v_run
  from jsonb_array_elements(p_results) e;
  get diagnostics v_n = row_count;
  select count(*) into v_bad from jsonb_array_elements(p_results) e where not (e ->> 'ok')::boolean;
  v_detail := v_n || ' files re-hashed — ' || v_bad || ' mismatch' || case when v_bad = 1 then '' else 'es' end;
  if p_actor is null then
    insert into public.audit_log (actor_id, actor_name, action, detail) values (null, 'System', 'Nightly integrity check', v_detail);
  else
    perform public.audit_as(p_actor, 'Integrity check', v_detail);
  end if;
  if v_bad > 0 then
    select string_agg('  • F' || lpad(f.file_no::text, 4, '0') || ' ' || st.matric_no || ' — '
             || coalesce(es.course_code, dt.name, f.kind::text) || case when ic.computed = 'missing' then ' (file missing)' else ' (hash mismatch)' end, E'\n')
      into v_list
    from public.integrity_checks ic join public.files f on f.id = ic.file_id join public.students st on st.id = f.student_id
    left join public.exam_sessions es on es.id = f.session_id left join public.doc_types dt on dt.id = f.doc_type
    where ic.run_id = v_run and not ic.ok;
    perform public.enqueue_notification('integrity_failure',
      'ScripTree: ' || v_bad || ' archived file' || case when v_bad = 1 then '' else 's' end || ' failed integrity check',
      'An integrity check re-hashed ' || v_n || ' files. These no longer match the SHA-256 recorded at upload:' || E'\n\n'
      || v_list || E'\n\nThe paper script is the official original. Retrieve it, rescan, and record the resolution in ScripTree.');
  end if;
  return query select v_n, v_bad;
end $$;
revoke execute on function public.record_integrity_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_integrity_run(uuid, jsonb) to service_role;

-- Admin: test the email path end to end
create or replace function public.send_test_email() returns void
language plpgsql security definer set search_path = public as $$
declare v_to text;
begin
  perform public.require_role('admin');
  select alert_email into v_to from public.settings;
  if v_to is null then raise exception 'Set an alert email in settings first'; end if;
  perform public.enqueue_notification('test', 'ScripTree: test alert',
    'This is a test from ScripTree system settings. If you can read this, alert emails reach ' || v_to || '.');
  perform public.audit('Send test email', v_to);
end $$;

create or replace function public.notification_status()
returns table (pending int, failing int, last_sent_at timestamptz, last_error text, nightly_job boolean, sender_job boolean, secrets_ready boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_role('admin', 'officer');
  return query select
    (select count(*)::int from public.notifications where sent_at is null),
    (select count(*)::int from public.notifications where sent_at is null and attempts > 0),
    (select max(sent_at) from public.notifications),
    (select n.last_error from public.notifications n where n.sent_at is null and n.last_error is not null order by n.id desc limit 1),
    exists (select 1 from cron.job where jobname = 'scriptree-nightly-check'),
    exists (select 1 from cron.job where jobname = 'scriptree-send-alerts'),
    (select count(*) = 2 from vault.decrypted_secrets where name in ('scriptree_project_url', 'scriptree_service_key'));
end $$;

-- ---------------------------------------------------------------------
-- Scheduled calls to edge functions
-- ---------------------------------------------------------------------
create or replace function public.call_edge_function(p_name text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_url text; v_key text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'scriptree_project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'scriptree_service_key';
  if v_url is null or v_key is null then
    raise warning 'ScripTree: vault secrets scriptree_project_url / scriptree_service_key are not set; skipping %', p_name;
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
    body := '{"scheduled": true}'::jsonb,
    timeout_milliseconds := 300000);
end $$;
revoke execute on function public.call_edge_function(text) from public, anon, authenticated;

create or replace function public.schedule_jobs() returns void
language plpgsql security definer set search_path = public as $$
declare t time;
begin
  select nightly_check_at into t from public.settings;
  perform cron.schedule('scriptree-nightly-check',
    extract(minute from t)::int || ' ' || extract(hour from t)::int || ' * * *',
    $cmd$select public.call_edge_function('integrity-check')$cmd$);
  perform cron.schedule('scriptree-send-alerts', '*/5 * * * *',
    $cmd$select public.call_edge_function('send-alerts') where exists (select 1 from public.notifications where sent_at is null and attempts < 5)$cmd$);
end $$;
revoke execute on function public.schedule_jobs() from public, anon, authenticated;

-- changing the nightly time in settings moves the job
create or replace function public.tg_settings_reschedule() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.nightly_check_at is distinct from old.nightly_check_at then perform public.schedule_jobs(); end if;
  return new;
end $$;
create trigger settings_reschedule after update of nightly_check_at on public.settings
for each row execute function public.tg_settings_reschedule();

select public.schedule_jobs();

-- ---------------------------------------------------------------------
-- Student sign-in rate limiting (used by the student-login edge function)
-- ---------------------------------------------------------------------
create table public.login_attempts (
  id         bigint generated always as identity primary key,
  identifier text not null,
  ip         text,
  ok         boolean not null,
  at         timestamptz not null default now()
);
create index login_attempts_ident_idx on public.login_attempts (identifier, at desc);
create index login_attempts_ip_idx on public.login_attempts (ip, at desc);
alter table public.login_attempts enable row level security;   -- no policies: service role only
revoke all on public.login_attempts from anon, authenticated;

-- the lookup is now only reachable through the rate-limited edge function
revoke execute on function public.student_login_email(text) from anon, authenticated;
grant execute on function public.student_login_email(text) to service_role;

-- housekeeping: keep 90 days of attempts
select cron.schedule('scriptree-prune-logins', '17 3 * * *', $cmd$delete from public.login_attempts where at < now() - interval '90 days'$cmd$);

-- =====================================================================
-- Scale and hardening, from the 2026-11-10 audit and load test
-- (30,000 students, 1,360 sessions, 396k files, 4M integrity checks, 1M audit entries).
--
-- Performance
--   1. The latest integrity result lives on the file row. file_integrity was DISTINCT ON over every
--      check ever run, joined once per candidate: a hall poll took 19 s; now ~45 ms.
--   2. Reconciliation for many sessions runs as one set-based query (recon_set), and closed sessions
--      keep a saved summary (session_recon / session_issues) refreshed by pg_cron whenever their
--      data changes. session_summaries / current_alerts went from >120 s to a cache read.
--   3. The integrity check runs in resumable batches (integrity_runs), so it never outlives the
--      edge-function time limit. Old passing results are pruned after 90 days.
--   4. Audit chain: fixed a fork under concurrent writes (section 4); verify_audit_chain checks only
--      entries added since the last verified checkpoint; pg_cron re-verifies everything nightly.
--   5. Identifier lookups use the unique indexes; CSV imports build their skipped list in O(n).
-- Correctness / security
--   6. Alert keys include what the alert is about, so acknowledging one doesn't hide later,
--      different problems (e.g. every future "documents awaiting verification").
--   7. Student sign-in rate limiting is atomic (no burst past the limit) and keyed per identifier
--      + IP, so one attacker can't lock a student out from every device.
--   8. A temporary password must really be changed before must_change_password clears.
--   9. Write functions refuse unknown records instead of writing phantom audit entries;
--      record_sign_in can't be used to flood the audit log.
--  10. Invigilators see only their own candidates' student records and no staff contact details.
--  11. Upload limit capped at 50 MB (what an edge function can hold in memory); bucket limits match.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Latest integrity result on the file
-- ---------------------------------------------------------------------
alter table public.files add column if not exists last_check_ok boolean,
                         add column if not exists last_checked_at timestamptz;
update public.files f set last_check_ok = x.ok, last_checked_at = x.checked_at
from (select distinct on (file_id) file_id, ok, checked_at from public.integrity_checks order by file_id, checked_at desc) x
where x.file_id = f.id and f.last_checked_at is distinct from x.checked_at;
create index if not exists files_check_failed_idx on public.files (id) where last_check_ok = false;
create index if not exists files_active_scan_idx on public.files (session_id, student_id) where kind = 'script' and active;
create index if not exists integrity_checks_failed_run_idx on public.integrity_checks (run_id) where not ok;

-- same columns as before, so every caller (reconcile_session, candidate_scans, the archive and tracker screens) is unchanged
create or replace view public.file_integrity with (security_invoker = on) as
  select f.id as file_id, f.last_check_ok as ok, f.last_checked_at as checked_at from public.files f;

-- ---------------------------------------------------------------------
-- 3. Resumable integrity runs
-- ---------------------------------------------------------------------
create table if not exists public.integrity_runs (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references auth.users (id),
  started_at    timestamptz not null default now(),
  last_file_no  bigint not null default 0,      -- cursor: files are checked in file_no order
  checked       int not null default 0,
  failed        int not null default 0,
  claimed_until timestamptz,                     -- one worker at a time
  finished_at   timestamptz
);
alter table public.integrity_runs enable row level security;
drop policy if exists integrity_runs_read on public.integrity_runs;
create policy integrity_runs_read on public.integrity_runs for select to authenticated
  using ((select public.app_role()) in ('admin', 'officer'));
revoke insert, update, delete, truncate on public.integrity_runs from anon, authenticated;

-- Join the open run (or start one) and claim it for this worker. ok = false: another worker holds it.
create or replace function public.integrity_run_claim(p_actor uuid, p_run uuid, p_create boolean)
returns table (run_id uuid, last_file_no bigint, checked int, ok boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r public.integrity_runs;
begin
  perform pg_advisory_xact_lock(hashtext('scriptree.integrity'));
  if p_run is not null then
    select * into r from public.integrity_runs where id = p_run and finished_at is null;
  else
    select * into r from public.integrity_runs where finished_at is null and started_at > now() - interval '12 hours'
      order by started_at desc limit 1;
  end if;
  if r.id is null then
    if not p_create then return; end if;
    update public.integrity_runs set finished_at = now(), claimed_until = null where finished_at is null;  -- abandoned runs
    insert into public.integrity_runs (actor_id) values (p_actor) returning * into r;
  end if;
  if r.claimed_until > now() then
    return query select r.id, r.last_file_no, r.checked, false; return;
  end if;
  update public.integrity_runs set claimed_until = now() + interval '3 minutes' where id = r.id;
  return query select r.id, r.last_file_no, r.checked, true;
end $$;

create or replace function public.integrity_run_batch(p_run uuid, p_results jsonb, p_last_file_no bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_n int; v_bad int;
begin
  if not exists (select 1 from public.integrity_runs where id = p_run and finished_at is null) then
    raise exception 'Integrity run is not open';
  end if;
  create temp table if not exists _ic (file_id uuid, ok boolean, computed text) on commit drop;
  truncate _ic;
  insert into _ic select (e ->> 'file_id')::uuid, (e ->> 'ok')::boolean, e ->> 'computed' from jsonb_array_elements(p_results) e;
  insert into public.integrity_checks (file_id, ok, computed, run_id) select file_id, ok, computed, p_run from _ic;
  update public.files f set last_check_ok = r.ok, last_checked_at = now() from _ic r where f.id = r.file_id;
  select count(*), count(*) filter (where not ok) into v_n, v_bad from _ic;
  update public.integrity_runs set checked = checked + v_n, failed = failed + v_bad,
         last_file_no = greatest(last_file_no, p_last_file_no), claimed_until = now() + interval '3 minutes'
   where id = p_run;
end $$;

create or replace function public.integrity_run_release(p_run uuid) returns void
language sql security definer set search_path = public as $$
  update public.integrity_runs set claimed_until = null where id = p_run
$$;

-- Close the run: audit entry, and an email when anything failed.
create or replace function public.integrity_run_finish(p_run uuid) returns table (checked int, failed int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r public.integrity_runs; v_detail text; v_list text;
begin
  update public.integrity_runs set finished_at = now(), claimed_until = null
   where id = p_run and finished_at is null returning * into r;
  if r.id is null then raise exception 'Integrity run is not open'; end if;
  v_detail := r.checked || ' files re-hashed — ' || r.failed || ' mismatch' || case when r.failed = 1 then '' else 'es' end;
  if r.actor_id is null then
    insert into public.audit_log (actor_id, actor_name, action, detail) values (null, 'System', 'Nightly integrity check', v_detail);
  else
    perform public.audit_as(r.actor_id, 'Integrity check', v_detail);
  end if;
  if r.failed > 0 then
    select string_agg('  • F' || lpad(f.file_no::text, 4, '0') || ' ' || st.matric_no || ' — '
             || coalesce(es.course_code, dt.name, f.kind::text) || case when ic.computed = 'missing' then ' (file missing)' else ' (hash mismatch)' end, E'\n')
      into v_list
    from public.integrity_checks ic join public.files f on f.id = ic.file_id join public.students st on st.id = f.student_id
    left join public.exam_sessions es on es.id = f.session_id left join public.doc_types dt on dt.id = f.doc_type
    where ic.run_id = r.id and not ic.ok;
    perform public.enqueue_notification('integrity_failure',
      'ScripTree: ' || r.failed || ' archived file' || case when r.failed = 1 then '' else 's' end || ' failed integrity check',
      'An integrity check re-hashed ' || r.checked || ' files. These no longer match the SHA-256 recorded at upload:' || E'\n\n'
      || v_list || E'\n\nThe paper script is the official original. Retrieve it, rescan, and record the resolution in ScripTree.');
  end if;
  return query select r.checked, r.failed;
end $$;

-- The single-shot version (still used by an older deployed edge function) also keeps the file rows current.
create or replace function public.record_integrity_run(p_actor uuid, p_results jsonb)
returns table (checked int, failed int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_run uuid;
begin
  insert into public.integrity_runs (actor_id) values (p_actor) returning id into v_run;
  perform public.integrity_run_batch(v_run, p_results, 0);
  return query select * from public.integrity_run_finish(v_run);
end $$;

-- ---------------------------------------------------------------------
-- 2. Set-based reconciliation + saved summaries for closed sessions
-- ---------------------------------------------------------------------
-- Same outcome rules as reconcile_session, for many sessions in one pass.
create or replace function public.recon_set(p_sessions uuid[])
returns table (session_id uuid, student_id uuid, reg boolean, att boolean, phys boolean, nscan int, bad boolean,
               outcome text, severity text, resolved boolean)
language sql stable security definer set search_path = public as $$
  with cand as (
    select r.session_id, r.student_id from public.registrations r where r.session_id = any (p_sessions)
    union select sc.session_id, sc.student_id from public.scripts sc where sc.session_id = any (p_sessions)
    union select f.session_id, f.student_id from public.files f where f.kind = 'script' and f.active and f.session_id = any (p_sessions)
  ),
  scans as (
    select f.session_id, f.student_id, count(*)::int n, bool_or(f.last_check_ok = false) bad
    from public.files f where f.kind = 'script' and f.active and f.session_id = any (p_sessions) group by 1, 2
  ),
  base as (
    select c.session_id, c.student_id, r.student_id is not null reg, a.present att, sc.id is not null phys,
           coalesce(sn.n, 0) nscan, coalesce(sn.bad, false) bad, es.status in ('live', 'scheduled') live
    from cand c
    join public.exam_sessions es on es.id = c.session_id
    left join public.registrations r on r.session_id = c.session_id and r.student_id = c.student_id
    left join public.attendance a on a.session_id = c.session_id and a.student_id = c.student_id
    left join public.scripts sc on sc.session_id = c.session_id and sc.student_id = c.student_id
    left join scans sn on sn.session_id = c.session_id and sn.student_id = c.student_id
  ),
  judged as (
    select b.*, case
        when not b.reg then array['Unregistered candidate', 'high']
        when b.att is null then case when b.live then array['Awaiting attendance', 'pend'] else array['Attendance not marked', 'med'] end
        when b.att = false and (b.phys or b.nscan > 0) then array['Absent but script exists', 'high']
        when b.att = false then array['Absent', 'info']
        when b.bad then array['Integrity failure', 'crit']
        when not b.phys and b.nscan = 0 then case when b.live then array['Script + scan pending', 'pend'] else array['Missing script and scan', 'crit'] end
        when not b.phys then case when b.live then array['Script check-in pending', 'pend'] else array['Missing physical script', 'high'] end
        when b.nscan > 1 then array['Duplicate scan', 'med']
        when b.nscan = 0 then case when b.live then array['Scan pending', 'pend'] else array['Missing scan', 'med'] end
        else array['Complete', 'ok'] end o
    from base b
  )
  select j.session_id, j.student_id, j.reg, j.att, j.phys, j.nscan, j.bad, j.o[1], j.o[2], rs.student_id is not null
  from judged j
  left join public.resolutions rs on rs.session_id = j.session_id and rs.student_id = j.student_id and rs.outcome = j.o[1]
$$;

create or replace function public.counts_set(p_sessions uuid[])
returns table (session_id uuid, registered int, present int, physical int, scanned int)
language sql stable security definer set search_path = public as $$
  select s.id,
    (select count(*) from public.registrations r where r.session_id = s.id)::int,
    (select count(*) from public.attendance a join public.registrations r using (session_id, student_id) where a.session_id = s.id and a.present)::int,
    (select count(*) from public.scripts sc where sc.session_id = s.id)::int,
    (select count(distinct f.student_id) from public.files f where f.session_id = s.id and f.kind = 'script' and f.active)::int
  from unnest(p_sessions) s(id)
$$;

-- recon_dirty: the saved summary may be out of date. Set in the same transaction as any change that
-- can move an outcome; cleared by refresh_session_recon. Only clean, closed sessions are read from the cache.
alter table public.exam_sessions add column if not exists recon_dirty boolean not null default true;

create table if not exists public.session_recon (
  session_id uuid primary key references public.exam_sessions (id) on delete cascade,
  n_ok int not null, n_open int not null, n_pend int not null,
  registered int not null, present int not null, physical int not null, scanned int not null,
  refreshed_at timestamptz not null default now()
);
create table if not exists public.session_issues (     -- unresolved crit/high/med rows of closed sessions
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  student_id uuid not null,
  outcome text not null, severity text not null, nscan int not null,
  primary key (session_id, student_id)
);
alter table public.session_recon enable row level security;   -- no policies: read through the RPCs only
alter table public.session_issues enable row level security;
revoke all on public.session_recon, public.session_issues from anon, authenticated;

create or replace function public.tg_recon_dirty() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP in ('INSERT', 'UPDATE') then
    update public.exam_sessions set recon_dirty = true where id in (select distinct session_id from nt where session_id is not null);
  end if;
  if TG_OP in ('UPDATE', 'DELETE') then
    update public.exam_sessions set recon_dirty = true where id in (select distinct session_id from ot where session_id is not null);
  end if;
  return null;
end $$;

-- files: only changes that can move an outcome (re-checks that pass again don't dirty anything)
create or replace function public.tg_recon_dirty_files() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'UPDATE' then
    update public.exam_sessions set recon_dirty = true where id in (
      select n.session_id from nt n join ot o on o.id = n.id
      where n.kind = 'script' and (n.active is distinct from o.active or n.session_id is distinct from o.session_id
         or n.student_id is distinct from o.student_id or coalesce(n.last_check_ok, true) <> coalesce(o.last_check_ok, true))
      union select o.session_id from nt n join ot o on o.id = n.id where o.kind = 'script' and n.session_id is distinct from o.session_id);
  elsif TG_OP = 'INSERT' then
    update public.exam_sessions set recon_dirty = true where id in (select distinct session_id from nt where kind = 'script');
  else
    update public.exam_sessions set recon_dirty = true where id in (select distinct session_id from ot where kind = 'script');
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['registrations', 'attendance', 'scripts', 'resolutions'] loop
    execute format('drop trigger if exists recon_dirty_ins on public.%I', t);
    execute format('drop trigger if exists recon_dirty_upd on public.%I', t);
    execute format('drop trigger if exists recon_dirty_del on public.%I', t);
    execute format('create trigger recon_dirty_ins after insert on public.%I referencing new table as nt for each statement execute function public.tg_recon_dirty()', t);
    execute format('create trigger recon_dirty_upd after update on public.%I referencing old table as ot new table as nt for each statement execute function public.tg_recon_dirty()', t);
    execute format('create trigger recon_dirty_del after delete on public.%I referencing old table as ot for each statement execute function public.tg_recon_dirty()', t);
  end loop;
end $$;
drop trigger if exists recon_dirty_ins on public.files;
drop trigger if exists recon_dirty_upd on public.files;
drop trigger if exists recon_dirty_del on public.files;
create trigger recon_dirty_ins after insert on public.files referencing new table as nt for each statement execute function public.tg_recon_dirty_files();
create trigger recon_dirty_upd after update on public.files referencing old table as ot new table as nt for each statement execute function public.tg_recon_dirty_files();
create trigger recon_dirty_del after delete on public.files referencing old table as ot for each statement execute function public.tg_recon_dirty_files();

create or replace function public.tg_session_status_dirty() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then new.recon_dirty := true; end if;
  return new;
end $$;
drop trigger if exists session_status_dirty on public.exam_sessions;
create trigger session_status_dirty before update of status on public.exam_sessions
for each row execute function public.tg_session_status_dirty();

-- Recompute the saved summary of closed sessions. The session rows are locked first, so a write that
-- lands meanwhile re-marks its session dirty after this commits instead of being lost.
create or replace function public.refresh_session_recon(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_ids uuid[];
begin
  select array_agg(id) into v_ids from (
    select id from public.exam_sessions where id = any (p_ids) and status = 'closed' order by id for update) x;
  if v_ids is null then return 0; end if;
  delete from public.session_recon where session_id = any (v_ids);
  delete from public.session_issues where session_id = any (v_ids);
  create temp table if not exists _rx on commit drop as select * from public.recon_set('{}'::uuid[]) with no data;
  truncate _rx;
  insert into _rx select * from public.recon_set(v_ids);
  insert into public.session_issues (session_id, student_id, outcome, severity, nscan)
    select session_id, student_id, outcome, severity, nscan from _rx where severity in ('crit', 'high', 'med') and not resolved;
  insert into public.session_recon (session_id, n_ok, n_open, n_pend, registered, present, physical, scanned)
    select c.session_id, coalesce(a.n_ok, 0), coalesce(a.n_open, 0), coalesce(a.n_pend, 0), c.registered, c.present, c.physical, c.scanned
    from public.counts_set(v_ids) c
    left join (select session_id, count(*) filter (where severity = 'ok')::int n_ok,
                      count(*) filter (where severity in ('crit','high','med') and not resolved)::int n_open,
                      count(*) filter (where severity = 'pend')::int n_pend
               from _rx group by 1) a on a.session_id = c.session_id;
  update public.exam_sessions set recon_dirty = false where id = any (v_ids);
  return cardinality(v_ids);
end $$;

-- pg_cron, every minute
create or replace function public.refresh_dirty_recon(p_limit int default 100) returns int
language sql security definer set search_path = public as $$
  select public.refresh_session_recon(array(
    select id from public.exam_sessions where status = 'closed' and recon_dirty order by closed_at desc nulls last limit p_limit))
$$;

create or replace function public.session_summaries()
returns table (
  id uuid, course_code text, course_title text, exam_date date, start_time time, venue text,
  status public.session_status, invigilator_name text, last_reconciled_at timestamptz,
  registered int, present int, physical int, scanned int, headcount int,
  complete int, open_issues int, pending int, hc_mismatch boolean
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_live uuid[];
begin
  perform public.require_role('officer', 'admin');
  -- computed now: anything not closed, and closed sessions whose saved summary is stale
  select array_agg(es.id) into v_live from public.exam_sessions es where es.status <> 'closed' or es.recon_dirty;
  return query
  with la as (
    select x.session_id, count(*) filter (where x.severity = 'ok')::int n_ok,
           count(*) filter (where x.severity in ('crit','high','med') and not x.resolved)::int n_open,
           count(*) filter (where x.severity = 'pend')::int n_pend
    from public.recon_set(v_live) x group by 1),
  lc as (select * from public.counts_set(v_live))
  select es.id, es.course_code, es.course_title, es.exam_date, es.start_time, es.venue, es.status, p.full_name, es.last_reconciled_at,
         coalesce(lc.registered, sr.registered, 0), coalesce(lc.present, sr.present, 0),
         coalesce(lc.physical, sr.physical, 0), coalesce(lc.scanned, sr.scanned, 0), es.headcount,
         coalesce(la.n_ok, sr.n_ok, 0), coalesce(la.n_open, sr.n_open, 0), coalesce(la.n_pend, sr.n_pend, 0),
         (es.status = 'closed' and es.headcount is not null and es.headcount <> coalesce(lc.physical, sr.physical, 0))
  from public.exam_sessions es
  left join public.profiles p on p.id = es.invigilator_id
  left join lc on lc.session_id = es.id
  left join la on la.session_id = es.id
  left join public.session_recon sr on sr.session_id = es.id and es.status = 'closed' and not es.recon_dirty
  order by es.exam_date desc, es.start_time;
end $$;

-- ---------------------------------------------------------------------
-- 6. Alerts: set-based, and keyed by what each alert is about
-- ---------------------------------------------------------------------
create or replace function public.current_alerts(p_include_acked boolean default false)
returns table (
  alert_key text, severity text, kind text, title text, detail text,
  session_id uuid, student_id uuid, raised_at timestamptz, acked_by text, acked_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_now uuid[]; v_dirty uuid[];
begin
  perform public.require_role('officer', 'admin');
  select array_agg(es.id) into v_now from public.exam_sessions es where es.status = 'live' or (es.status = 'closed' and es.recon_dirty);
  select array_agg(es.id) into v_dirty from public.exam_sessions es where es.status = 'closed' and es.recon_dirty;
  return query
  with c as (
    select * from public.counts_set(v_now)
    union all
    select sr.session_id, sr.registered, sr.present, sr.physical, sr.scanned
    from public.session_recon sr join public.exam_sessions es on es.id = sr.session_id where es.status = 'closed' and not es.recon_dirty),
  issues as (
    select x.session_id, x.student_id, x.outcome, x.severity, x.nscan from public.recon_set(v_dirty) x
    where x.severity in ('crit','high','med') and not x.resolved
    union all
    select si.session_id, si.student_id, si.outcome, si.severity, si.nscan
    from public.session_issues si join public.exam_sessions es on es.id = si.session_id where es.status = 'closed' and not es.recon_dirty),
  a as (
    select es.id || '-live-scan-' || (c.present - c.scanned) || '/' || c.present k, 'high' sev, 'Count mismatch' kind,
           es.course_code || ': ' || (c.present - c.scanned) || ' of ' || c.present || ' present candidates have no scan yet' title,
           'Live session in ' || es.venue || '.' || case when c.present > c.physical then ' ' || (c.present - c.physical) || ' scripts also not yet checked in.' else '' end detail,
           es.id sid, null::uuid stid, now() raised
    from public.exam_sessions es join c on c.session_id = es.id where es.status = 'live' and c.present > c.scanned
    union all
    select es.id || '-hc-' || es.headcount || '/' || c.physical, 'high', 'Headcount mismatch',
           es.course_code || ': headcount ' || es.headcount || ' but ' || c.physical || ' physical scripts received',
           'Hall headcount does not match scripts checked in.', es.id, null, coalesce(es.closed_at, now())
    from public.exam_sessions es join c on c.session_id = es.id where es.status = 'closed' and es.headcount is not null and es.headcount <> c.physical
    union all
    select es.id || '-' || i.student_id || '-' || i.outcome, i.severity, i.outcome, es.course_code || ': ' || i.outcome || ' — ' || st.matric_no,
           st.full_name || '. ' || case i.outcome
             when 'Integrity failure' then 'Stored file hash no longer matches the hash recorded at upload.'
             when 'Duplicate scan' then i.nscan || ' active scans for one candidate.'
             when 'Unregistered candidate' then 'Not on the registered list for this course.'
             when 'Absent but script exists' then 'Marked absent on attendance, yet a script was received.'
             else 'Present at the exam, record incomplete.' end,
           es.id, i.student_id, coalesce(es.closed_at, now())
    from issues i join public.exam_sessions es on es.id = i.session_id join public.students st on st.id = i.student_id
    union all
    -- the newest upload is part of the key: a new document raises the alert again after an acknowledgement
    select 'docs-pending-' || extract(epoch from max(d.created_at))::bigint, 'med', 'Documents awaiting verification',
           count(*) || ' student documents awaiting verification',
           'Uploaded by students; verify or reject with a reason.', null, null, min(d.created_at)
    from public.student_documents d where d.status = 'pending' having count(*) > 0)
  select a.k, a.sev, a.kind, a.title, a.detail, a.sid, a.stid, a.raised, k.acked_by_name, k.acked_at
  from a left join public.alert_acks k on k.alert_key = a.k
  where p_include_acked or k.alert_key is null
  order by case a.sev when 'crit' then 0 when 'high' then 1 else 2 end, a.raised desc;
end $$;

create or replace function public.ack_alert(p_key text, p_title text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text; v_new boolean;
begin
  perform public.require_role('officer');
  if length(coalesce(p_key, '')) not between 3 and 200 then raise exception 'Unknown alert'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.alert_acks (alert_key, acked_by, acked_by_name) values (p_key, auth.uid(), v_name)
  on conflict (alert_key) do nothing;
  get diagnostics v_new = row_count;
  if v_new then perform public.audit('Acknowledge alert', left(coalesce(p_title, p_key), 300)); end if;
end $$;

-- ---------------------------------------------------------------------
-- Dashboard numbers without scanning the integrity history
-- ---------------------------------------------------------------------
create or replace function public.dashboard_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_req int;
begin
  perform public.require_role('officer', 'admin');
  select count(*) into v_req from public.doc_types where required;
  select jsonb_build_object(
    'scripts_total', (select count(*) from public.scripts),
    'scripts_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.scripts group by status) t), '{}'::jsonb),
    'scan_files', (select count(*) from public.files where kind = 'script' and active),
    'files_total', (select count(*) from public.files),
    'files_failed', (select count(*) from public.files where last_check_ok = false and active),
    'files_checked', (select count(*) from public.files where last_check_ok is not null),
    'last_check_at', (select max(last_checked_at) from public.files),
    'students_total', (select count(*) from public.students),
    'students_complete', case when v_req = 0 then (select count(*) from public.students) else (
        select count(*) from (
          select d.student_id from public.student_documents d join public.doc_types t on t.id = d.doc_type and t.required
          where d.status = 'verified' group by d.student_id having count(distinct d.doc_type) = v_req) x) end,
    'docs_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.student_documents group by status) t), '{}'::jsonb),
    'docs_verified_by_type', coalesce((select jsonb_object_agg(doc_type, n) from (
        select doc_type, count(distinct student_id) n from public.student_documents where status = 'verified' group by doc_type) t), '{}'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 4. Audit chain: a true chain order, incremental verification, full check nightly
--
-- Bug fixed here: the entry id is handed out before the chain trigger takes its lock, and the
-- trigger linked each entry to the entry with the highest id. Two writes at the same moment could
-- therefore chain in the opposite order to their ids, and the next entry then linked to the wrong
-- one, forking the chain. verify_audit_chain (which walks ids) reported tampering that never
-- happened. chain_no now records the order entries actually take the lock; new entries form one
-- strict line in chain_no order. Entries written before this migration are verified link by link
-- (each must hash correctly and point at an existing entry), so historic forks don't raise
-- false alarms, while any edit still breaks its own hash and every later link.
-- ---------------------------------------------------------------------
alter table public.audit_log add column if not exists chain_no bigint;
create unique index if not exists audit_log_chain_idx on public.audit_log (chain_no) where chain_no is not null;
create index if not exists audit_log_hash_idx on public.audit_log (hash);

-- mark the newest unlinked entry of the existing chain as chain_no 0; new entries continue from it
do $$
declare v_tip bigint;
begin
  if not exists (select 1 from public.audit_log where chain_no is not null) then
    select a.id into v_tip from public.audit_log a
     where not exists (select 1 from public.audit_log b where b.prev_hash = a.hash) order by a.id desc limit 1;
    if v_tip is not null then
      alter table public.audit_log disable trigger audit_no_update;   -- chain_no is not part of any hash
      update public.audit_log set chain_no = 0 where id = v_tip;
      alter table public.audit_log enable trigger audit_no_update;
    end if;
  end if;
end $$;

create or replace function public.tg_audit_chain() returns trigger
language plpgsql set search_path = public as $$
declare v_prev text; v_no bigint;
begin
  -- serialise writers; the chain order is the order they get this lock
  perform pg_advisory_xact_lock(hashtext('scriptree.audit_log'));
  select hash, chain_no into v_prev, v_no from public.audit_log where chain_no is not null order by chain_no desc limit 1;
  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.chain_no := coalesce(v_no, 0) + 1;
  new.at := clock_timestamp();
  new.hash := public.audit_entry_hash(new.prev_hash, new.at, new.actor_name, new.action, new.detail);
  return new;
end $$;

create table if not exists public.audit_checkpoints (
  id            bigint generated always as identity primary key,
  upto_chain_no bigint not null,
  upto_id       bigint not null,
  upto_hash     text not null,
  entries       bigint not null,
  full_check    boolean not null,
  at            timestamptz not null default now()
);
alter table public.audit_checkpoints enable row level security;
drop policy if exists audit_checkpoints_read on public.audit_checkpoints;
create policy audit_checkpoints_read on public.audit_checkpoints for select to authenticated
  using ((select public.app_role()) in ('admin', 'officer'));
revoke insert, update, delete, truncate on public.audit_checkpoints from anon, authenticated;

-- p_full = false: from the last checkpoint only (fast, for the app). p_full = true: everything (nightly).
create or replace function public.audit_chain_check(p_full boolean)
returns table (ok boolean, entries bigint, broken_at bigint)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  cp public.audit_checkpoints; e record; v_zero text := repeat('0', 64);
  v_prev text; v_from bigint; v_n bigint; v_last_no bigint; v_last_id bigint; v_bad bigint;
begin
  if not p_full then select * into cp from public.audit_checkpoints order by id desc limit 1; end if;

  if cp.id is not null then
    -- the entry the checkpoint vouches for must still be exactly what was verified
    if not exists (select 1 from public.audit_log a where a.chain_no = cp.upto_chain_no and a.hash = cp.upto_hash) then
      return query select false, cp.entries, cp.upto_id; return;
    end if;
    v_prev := cp.upto_hash; v_from := cp.upto_chain_no; v_n := cp.entries; v_last_no := cp.upto_chain_no; v_last_id := cp.upto_id;
  else
    -- entries from before chain_no (and the tip they end in): each hashes correctly and links to an existing entry
    select min(a.id) into v_bad from public.audit_log a
     where (a.chain_no is null or a.chain_no = 0)
       and (a.hash <> public.audit_entry_hash(a.prev_hash, a.at, a.actor_name, a.action, a.detail)
            or (a.prev_hash <> v_zero and not exists (select 1 from public.audit_log b where b.hash = a.prev_hash)));
    select count(*) into v_n from public.audit_log a where a.chain_no is null or a.chain_no = 0;
    if v_bad is not null then return query select false, v_n, v_bad; return; end if;
    select a.hash, a.id into v_prev, v_last_id from public.audit_log a where a.chain_no = 0;
    v_prev := coalesce(v_prev, v_zero); v_from := 0; v_last_no := 0; v_last_id := coalesce(v_last_id, 0);
  end if;

  -- entries since then: one strict line in chain_no order
  for e in select * from public.audit_log a where a.chain_no > v_from order by a.chain_no loop
    v_n := v_n + 1;
    if e.prev_hash <> v_prev or e.hash <> public.audit_entry_hash(e.prev_hash, e.at, e.actor_name, e.action, e.detail) then
      return query select false, v_n, e.id; return;
    end if;
    v_prev := e.hash; v_last_no := e.chain_no; v_last_id := e.id;
  end loop;

  if v_last_id > 0 and (cp.id is null or v_last_no > v_from) then
    insert into public.audit_checkpoints (upto_chain_no, upto_id, upto_hash, entries, full_check)
    values (v_last_no, v_last_id, v_prev, v_n, p_full);
  end if;
  return query select true, v_n, null::bigint;
end $$;

drop function if exists public.verify_audit_chain();
create function public.verify_audit_chain()
returns table (ok boolean, entries bigint, broken_at bigint)
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('admin', 'officer');
  return query select * from public.audit_chain_check(false);
end $$;

-- pg_cron, nightly: re-hash the whole log; email the office if anything was altered
create or replace function public.nightly_audit_check() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.audit_chain_check(true);
  if not r.ok then
    perform public.enqueue_notification('audit_chain', 'ScripTree: audit log chain broken at entry #' || r.broken_at,
      'The nightly re-hash of the audit log found entry #' || r.broken_at || ' altered after it was written. '
      || 'Every later entry is suspect. Investigate database access immediately.');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Index-friendly identifier lookups (stored values are upper-case by CHECK constraint / generator)
-- ---------------------------------------------------------------------
create or replace function public.student_login_email(p_identifier text) returns text
language sql stable security definer set search_path = public as $$
  select u.email from public.students s join auth.users u on u.id = s.user_id
  where s.matric_no = upper(trim(p_identifier)) or s.student_code = upper(trim(p_identifier))
  limit 1
$$;

create or replace function public.resolve_identifier(p_q text, p_session uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.students where matric_no = upper(trim(p_q)) or student_code = upper(trim(p_q)) limit 1),
    (select student_id from public.scripts where script_code = upper(trim(p_q)) and (p_session is null or session_id = p_session) limit 1),
    (select st.id from public.students st, public.exam_sessions es
      where p_session is not null and es.id = p_session
        and st.student_code = split_part(upper(trim(p_q)), '-', 1)
        and upper(trim(p_q)) = st.student_code || '-' || replace(es.course_code, ' ', '')))
  where public.is_staff()
$$;

-- CSV imports: skipped rows collected in an array (appending to jsonb copied the whole list every row);
-- import_candidates takes the same registration lock as the other registration paths.
create or replace function public.add_students(p_rows jsonb)
returns table (created int, existing int, updated int, skipped jsonb, ids uuid[])
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  r jsonb; v_matric text; v_code text; v_name text; v_dept text; v_level text; v_email text; v_raw_email text;
  v_sid uuid; v_cur_email text; v_other text;
  v_created int := 0; v_existing int := 0; v_updated int := 0; v_skip jsonb[] := '{}'; v_ids uuid[] := '{}';
begin
  perform public.require_role('admin', 'officer');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_matric    := upper(trim(coalesce(r ->> 'matric_no', '')));
    v_code      := upper(trim(coalesce(r ->> 'student_code', '')));
    v_name      := regexp_replace(trim(coalesce(r ->> 'full_name', '')), '\s+', ' ', 'g');
    v_dept      := trim(coalesce(r ->> 'department', ''));
    v_level     := upper(trim(coalesce(r ->> 'level', '')));
    v_raw_email := trim(coalesce(r ->> 'email', ''));
    v_email     := public.clean_email(v_raw_email);

    if v_matric !~ '^[A-Z]{2,5}/[0-9]{2}/[0-9]{3,6}$' then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid matric number (e.g. CSC/21/1001)'); continue;
    end if;
    if v_raw_email <> '' and v_email is null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid email: ' || left(v_raw_email, 60)); continue;
    end if;

    select id, email into v_sid, v_cur_email from public.students where matric_no = v_matric;
    if v_sid is not null then
      if v_cur_email is null and v_email is not null then
        update public.students set email = v_email where id = v_sid;
        v_updated := v_updated + 1;
      end if;
      v_existing := v_existing + 1; v_ids := v_ids || v_sid; continue;
    end if;

    if v_code !~ '^ST[0-9]{4,10}$' then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid student ID (ST followed by 4–10 digits)'); continue;
    end if;
    if length(v_name) < 2 or length(v_name) > 120 then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Full name missing'); continue;
    end if;
    if v_email is null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Email missing'); continue;
    end if;
    if v_dept = '' or length(v_dept) > 80 then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Department missing'); continue;
    end if;
    if v_level = '' or length(v_level) > 20 then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Level missing'); continue;
    end if;
    select matric_no into v_other from public.students where student_code = v_code;
    if v_other is not null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Student ID ' || v_code || ' already belongs to ' || v_other); continue;
    end if;

    insert into public.students (matric_no, student_code, full_name, department, level, email)
    values (v_matric, v_code, v_name, v_dept, v_level, v_email) returning id into v_sid;
    v_created := v_created + 1; v_ids := v_ids || v_sid;
  end loop;

  if v_created > 0 or v_updated > 0 or cardinality(v_skip) > 0 then
    perform public.audit('Add students', v_created || ' added'
      || case when v_existing > 0 then ', ' || v_existing || ' already on record' else '' end
      || case when v_updated > 0 then ' (' || v_updated || ' emails filled in)' else '' end
      || case when cardinality(v_skip) > 0 then ', ' || cardinality(v_skip) || ' skipped' else '' end);
  end if;
  return query select v_created, v_existing, v_updated, to_jsonb(v_skip), v_ids;
end $$;

create or replace function public.import_candidates(p_session uuid, p_rows jsonb)
returns table (added int, created int, already int, skipped jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  s public.exam_sessions; r jsonb; v_matric text; v_sid uuid; v_seq int;
  v_added int := 0; v_created int := 0; v_already int := 0; v_skip jsonb[] := '{}';
  v_code text; v_name text; v_email text; v_raw_email text;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status = 'closed' then raise exception 'Session is closed'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.reg.' || p_session));
  select coalesce(max(seq), 0) into v_seq from public.registrations where session_id = p_session;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_matric := upper(trim(coalesce(r ->> 'matric_no', '')));
    if v_matric !~ '^[A-Z]{2,5}/[0-9]{2}/[0-9]{3,6}$' then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid matric number'); continue;
    end if;
    if nullif(trim(r ->> 'course_code'), '') is not null and upper(trim(r ->> 'course_code')) <> s.course_code then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Different course: ' || (r ->> 'course_code')); continue;
    end if;
    v_raw_email := trim(coalesce(r ->> 'email', ''));
    v_email := public.clean_email(v_raw_email);
    if v_raw_email <> '' and v_email is null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid email: ' || left(v_raw_email, 60)); continue;
    end if;
    select id into v_sid from public.students where matric_no = v_matric;
    if v_sid is null then
      v_code := upper(trim(coalesce(r ->> 'student_code', '')));
      v_name := trim(coalesce(r ->> 'full_name', ''));
      if v_code !~ '^ST[0-9]{4,10}$' or length(v_name) < 2 or nullif(trim(r ->> 'department'), '') is null or nullif(trim(r ->> 'level'), '') is null or v_email is null then
        v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Unknown student — add full_name, student_code, email, department and level to create them'); continue;
      end if;
      if exists (select 1 from public.students where student_code = v_code) then
        v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Student ID ' || v_code || ' belongs to another matric number'); continue;
      end if;
      insert into public.students (matric_no, student_code, full_name, department, level, email)
      values (v_matric, v_code, left(v_name, 120), trim(r ->> 'department'), trim(r ->> 'level'), v_email) returning id into v_sid;
      v_created := v_created + 1;
    elsif v_email is not null then
      update public.students set email = v_email where id = v_sid and email is null;
    end if;
    if exists (select 1 from public.registrations where session_id = p_session and student_id = v_sid) then
      v_already := v_already + 1; continue;
    end if;
    v_seq := v_seq + 1;
    insert into public.registrations (session_id, student_id, seq) values (p_session, v_sid, v_seq);
    v_added := v_added + 1;
  end loop;

  perform public.audit('Import candidates', s.course_code || ' — ' || v_added || ' registered from CSV'
    || case when v_created > 0 then ', ' || v_created || ' new students' else '' end
    || case when cardinality(v_skip) > 0 then ', ' || cardinality(v_skip) || ' skipped' else '' end);
  return query select v_added, v_created, v_already, to_jsonb(v_skip);
end $$;

-- ---------------------------------------------------------------------
-- 9. No phantom audit entries; sign-in audit can't be flooded
-- ---------------------------------------------------------------------
create or replace function public.start_session(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions;
begin
  perform public.require_role('invigilator', 'officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if public.app_role() = 'invigilator' and s.invigilator_id is distinct from auth.uid() then raise exception 'Not your session' using errcode = '42501'; end if;
  if s.status <> 'scheduled' then raise exception 'Session already %', s.status; end if;
  update public.exam_sessions set status = 'live' where id = p_session;
  perform public.audit('Open session', s.course_code || ' · ' || s.venue);
end $$;

create or replace function public.decide_document(p_doc uuid, p_status public.doc_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare d public.student_documents; v_matric text; v_name text;
begin
  perform public.require_role('officer');
  if p_status = 'pending' then raise exception 'Choose verify or reject'; end if;
  if p_status = 'rejected' and length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Give a reason for rejecting'; end if;
  select * into d from public.student_documents where id = p_doc for update;
  if d.id is null then raise exception 'No such document'; end if;
  if d.status <> 'pending' then raise exception 'Document already %', d.status; end if;
  update public.student_documents
     set status = p_status, verified_by = auth.uid(), verified_at = now(),
         reason = case when p_status = 'rejected' then left(trim(p_reason), 200) end
   where id = p_doc;
  select matric_no into v_matric from public.students where id = d.student_id;
  select name into v_name from public.doc_types where id = d.doc_type;
  perform public.audit(case when p_status = 'verified' then 'Verify document' else 'Reject document' end, v_matric || ' — ' || v_name);
end $$;

create or replace function public.set_account_status(p_user uuid, p_status public.account_status) returns void
language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public.require_role('admin');
  if p_user = auth.uid() then raise exception 'You cannot change your own status'; end if;
  update public.profiles set status = p_status where id = p_user returning * into v;
  if v.id is null then raise exception 'No such account'; end if;
  perform public.audit(case when p_status = 'active' then 'Reactivate account' else 'Suspend account' end,
    v.full_name || ' — ' || v.role);
end $$;

create or replace function public.add_custody_event(p_script uuid, p_action text, p_location text)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text; v_name text; v_status public.script_status; v_loc text := coalesce(nullif(left(trim(p_location), 120), ''), 'Exams office');
begin
  perform public.require_role('officer');
  if p_action not in ('Sealed in batch', 'Received at exams office', 'Stored in records room', 'Retrieved for marking',
                      'Returned to records room', 'Released for result verification') then
    raise exception 'Choose a custody event from the list';
  end if;
  v_status := case
    when p_action like 'Sealed%' then 'bundled'
    when p_action like 'Received%' then 'received'
    when p_action like 'Stored%' or p_action like 'Returned%' then 'stored'
    else 'out' end;
  update public.scripts set status = v_status, location = v_loc where id = p_script returning script_code into v_code;
  if v_code is null then raise exception 'No such script'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.custody_events (script_id, action, location, actor_id, actor_name)
  values (p_script, p_action, v_loc, auth.uid(), v_name);
  perform public.audit('Custody event', v_code || ' — ' || p_action || ' (' || v_loc || ')');
end $$;

-- close: a mark made by another hall device at the same moment no longer aborts the close with a duplicate key
create or replace function public.close_session(p_session uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session); v_open int; v_unmarked int;
begin
  insert into public.attendance (session_id, student_id, present, mode, marked_by)
  select r.session_id, r.student_id, false, s.attendance_mode, auth.uid()
  from public.registrations r
  where r.session_id = p_session
    and not exists (select 1 from public.attendance a where a.session_id = r.session_id and a.student_id = r.student_id)
  on conflict (session_id, student_id) do nothing;
  get diagnostics v_unmarked = row_count;

  update public.exam_sessions set status = 'closed', closed_at = now(), last_reconciled_at = now() where id = p_session;
  select count(*) into v_open from public.reconcile_session(p_session) r
    where r.severity in ('crit', 'high', 'med') and not r.resolved;
  perform public.audit('Close session', s.course_code || ' — ' || v_open || ' discrepancies raised'
    || case when v_unmarked > 0 then ', ' || v_unmarked || ' unmarked recorded absent' else '' end);
  return v_open;
end $$;

-- one audit entry per sign-in, not one per call
create or replace function public.record_sign_in() returns void
language plpgsql security definer set search_path = public as $$
declare v_role public.app_role; v_last timestamptz;
begin
  select role, last_sign_in_at into v_role, v_last from public.profiles where id = auth.uid();
  if v_role is null then return; end if;
  if v_last > now() - interval '1 minute' then return; end if;
  update public.profiles set last_sign_in_at = now() where id = auth.uid();
  perform public.audit('Sign in', initcap(v_role::text) || ' portal');
end $$;

-- ---------------------------------------------------------------------
-- 8. Temporary passwords must actually be replaced
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists temp_pw_marker text;

-- service role (admin-users): flag the account and remember which password hash was issued
create or replace function public.mark_temp_password(p_user uuid) returns void
language sql security definer set search_path = public as $$
  update public.profiles p set must_change_password = true, temp_pw_marker = md5(u.encrypted_password)
  from auth.users u where u.id = p_user and p.id = p_user
$$;

create or replace function public.password_changed() returns void
language plpgsql security definer set search_path = public as $$
declare v_marker text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select temp_pw_marker into v_marker from public.profiles where id = auth.uid();
  if v_marker is not null and exists (select 1 from auth.users u where u.id = auth.uid() and md5(u.encrypted_password) = v_marker) then
    raise exception 'Choose a new password first';
  end if;
  update public.profiles set must_change_password = false, temp_pw_marker = null where id = auth.uid();
  perform public.audit('Set password', 'New password chosen');
end $$;

-- ---------------------------------------------------------------------
-- 7. Atomic sign-in rate limiting (student-login edge function)
--    Limits over 15 minutes, counting failures and in-flight attempts:
--    5 per identifier from one IP, 20 per identifier from all IPs, 30 per IP.
-- ---------------------------------------------------------------------
alter table public.login_attempts alter column ok drop not null;   -- null = in flight

create or replace function public.login_attempt_begin(p_identifier text, p_ip text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; n_pair int; n_id int; n_ip int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('scriptree.login.id.' || p_identifier));
  if p_ip is not null then perform pg_advisory_xact_lock(hashtext('scriptree.login.ip.' || p_ip)); end if;
  select count(*) filter (where ip is not distinct from p_ip), count(*) into n_pair, n_id
    from public.login_attempts where identifier = p_identifier and ok is not true and at > now() - interval '15 minutes';
  if p_ip is not null then
    select count(*) into n_ip from public.login_attempts where ip = p_ip and ok is not true and at > now() - interval '15 minutes';
  end if;
  if n_pair >= 5 or n_id >= 20 or n_ip >= 30 then return null; end if;
  insert into public.login_attempts (identifier, ip, ok) values (p_identifier, p_ip, null) returning id into v_id;
  return v_id;
end $$;

-- p_ok null: the auth server was busy; the attempt doesn't count against the student
create or replace function public.login_attempt_end(p_id bigint, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_ok is null then delete from public.login_attempts where id = p_id;
  else update public.login_attempts set ok = p_ok where id = p_id; end if;
end $$;

-- ---------------------------------------------------------------------
-- admin-users: staff sign-in / two-factor status without paging through every auth user
-- ---------------------------------------------------------------------
create or replace function public.staff_auth_info() returns table (id uuid, last_sign_in_at timestamptz, mfa boolean)
language sql stable security definer set search_path = public as $$
  select u.id, u.last_sign_in_at,
         exists (select 1 from auth.mfa_factors f where f.user_id = u.id and f.status::text = 'verified')
  from auth.users u join public.profiles p on p.id = u.id where p.role <> 'student'
$$;

-- register-file: size of an upload, read before downloading it
create or replace function public.upload_size(p_bucket text, p_path text) returns bigint
language sql stable security definer set search_path = public as $$
  select (o.metadata ->> 'size')::bigint from storage.objects o where o.bucket_id = p_bucket and o.name = p_path
$$;

-- ---------------------------------------------------------------------
-- 10. Invigilators: their own candidates only, no staff contact details
-- ---------------------------------------------------------------------
alter policy students_staff on public.students using (
  (select public.app_role()) in ('admin', 'officer')
  or ((select public.app_role()) = 'invigilator' and (
    exists (select 1 from public.registrations r join public.exam_sessions es on es.id = r.session_id
            where r.student_id = students.id and es.invigilator_id = (select auth.uid()))
    or exists (select 1 from public.scripts sc join public.exam_sessions es on es.id = sc.session_id
               where sc.student_id = students.id and es.invigilator_id = (select auth.uid())))));
alter policy profiles_staff on public.profiles using ((select public.app_role()) in ('admin', 'officer') and role <> 'student');

-- ---------------------------------------------------------------------
-- 11. Upload limit an edge function can hold in memory
-- ---------------------------------------------------------------------
update public.settings set max_file_mb = least(max_file_mb, 50) where id;
alter table public.settings drop constraint if exists settings_max_file_mb_check;
alter table public.settings add constraint settings_max_file_mb_check check (max_file_mb between 1 and 50);
update storage.buckets set file_size_limit = 52428800 where id in ('scans', 'documents');

-- ---------------------------------------------------------------------
-- Scheduled jobs
-- ---------------------------------------------------------------------
create or replace function public.call_edge_function(p_name text, p_body jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'scriptree_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'scriptree_cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'ScripTree: vault secrets scriptree_project_url / scriptree_cron_secret are not set; skipping %', p_name;
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    headers := jsonb_build_object('x-scriptree-cron', v_secret, 'Content-Type', 'application/json'),
    body := p_body,
    timeout_milliseconds := 300000);
end $$;

create or replace function public.call_edge_function(p_name text) returns bigint
language sql security definer set search_path = public as $$
  select public.call_edge_function(p_name, '{"scheduled": true}'::jsonb)
$$;

create or replace function public.schedule_jobs() returns void
language plpgsql security definer set search_path = public as $$
declare t time;
begin
  select nightly_check_at into t from public.settings;
  perform cron.schedule('scriptree-nightly-check',
    extract(minute from t)::int || ' ' || extract(hour from t)::int || ' * * *',
    $cmd$select public.call_edge_function('integrity-check')$cmd$);
  -- a run that didn't finish in one invocation is picked up again until it's done
  perform cron.schedule('scriptree-integrity-continue', '*/2 * * * *',
    $cmd$select public.call_edge_function('integrity-check', '{"scheduled": true, "continue": true}'::jsonb) where exists (select 1 from public.integrity_runs where finished_at is null)$cmd$);
  perform cron.schedule('scriptree-send-alerts', '*/5 * * * *',
    $cmd$select public.call_edge_function('send-alerts') where exists (select 1 from public.notifications where sent_at is null and attempts < 5)$cmd$);
  perform cron.schedule('scriptree-recon-refresh', '* * * * *', $cmd$select public.refresh_dirty_recon()$cmd$);
  perform cron.schedule('scriptree-audit-chain', '47 3 * * *', $cmd$select public.nightly_audit_check()$cmd$);
  perform cron.schedule('scriptree-prune-integrity', '27 4 * * *',
    $cmd$delete from public.integrity_checks where ok and checked_at < now() - interval '90 days'$cmd$);
end $$;
select public.schedule_jobs();

-- ---------------------------------------------------------------------
-- Grants: internal helpers and service-role entry points are not callable from the browser
-- ---------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.integrity_run_claim(uuid, uuid, boolean)', 'public.integrity_run_batch(uuid, jsonb, bigint)',
    'public.integrity_run_release(uuid)', 'public.integrity_run_finish(uuid)', 'public.record_integrity_run(uuid, jsonb)',
    'public.recon_set(uuid[])', 'public.counts_set(uuid[])', 'public.refresh_session_recon(uuid[])', 'public.refresh_dirty_recon(int)',
    'public.tg_recon_dirty()', 'public.tg_recon_dirty_files()', 'public.tg_session_status_dirty()',
    'public.audit_chain_check(boolean)', 'public.nightly_audit_check()', 'public.student_login_email(text)',
    'public.mark_temp_password(uuid)', 'public.login_attempt_begin(text, text)', 'public.login_attempt_end(bigint, boolean)',
    'public.staff_auth_info()', 'public.upload_size(text, text)',
    'public.call_edge_function(text, jsonb)', 'public.call_edge_function(text)', 'public.schedule_jobs()'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
grant execute on function public.integrity_run_claim(uuid, uuid, boolean), public.integrity_run_batch(uuid, jsonb, bigint),
  public.integrity_run_release(uuid), public.integrity_run_finish(uuid), public.record_integrity_run(uuid, jsonb),
  public.student_login_email(text), public.mark_temp_password(uuid), public.login_attempt_begin(text, text),
  public.login_attempt_end(bigint, boolean), public.staff_auth_info(), public.upload_size(text, text) to service_role;
grant select on public.integrity_runs to service_role;
grant execute on function public.verify_audit_chain(), public.session_summaries(), public.current_alerts(boolean),
  public.dashboard_stats(), public.ack_alert(text, text), public.password_changed(), public.record_sign_in() to authenticated;

-- fill the saved summaries for every closed session now (pg_cron keeps them fresh from here on)
select public.refresh_session_recon(array(select id from public.exam_sessions where status = 'closed'));
-- first checkpoint, so the app's check only has to look at new entries
select public.audit_chain_check(true);
analyze public.files, public.exam_sessions, public.session_recon, public.session_issues, public.audit_log;

-- =====================================================================
-- ScripTree — initial schema
-- Track, reconcile, preserve, alert. The paper script stays the official original.
--
-- Design rules
--   * Reads go through RLS. Writes go through SECURITY DEFINER functions
--     that check the caller's role AND write an audit entry in the same
--     transaction — nothing changes silently.
--   * audit_log is append-only and hash-chained (SHA-256 of prev hash +
--     fields). Updates/deletes are blocked by trigger, even for the owner.
--   * Admin and exams officer must be at AAL2 (two-factor) for app_role()
--     to return their role; without it RLS sees them as nobody.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------
create type public.app_role as enum ('admin', 'officer', 'invigilator', 'student');
create type public.account_status as enum ('active', 'suspended');
create type public.session_status as enum ('scheduled', 'live', 'closed');
create type public.attendance_mode as enum ('start', 'end', 'submission');
create type public.script_status as enum ('submitted', 'bundled', 'received', 'stored', 'out');
create type public.file_kind as enum ('script', 'doc');
create type public.capture_method as enum ('pdf', 'snap');
create type public.doc_status as enum ('pending', 'verified', 'rejected');

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        public.app_role not null,
  full_name   text not null check (length(full_name) between 2 and 120),
  email       text not null,
  title       text,                                  -- e.g. 'Invigilator · Hall D'
  status      public.account_status not null default 'active',
  last_sign_in_at timestamptz,
  created_at  timestamptz not null default now()
);

create table public.students (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid unique references auth.users (id) on delete set null,
  matric_no    text not null unique check (matric_no ~ '^[A-Z]{2,5}/[0-9]{2}/[0-9]{3,6}$'),
  student_code text not null unique check (student_code ~ '^ST[0-9]{4,10}$'),
  full_name    text not null check (length(full_name) between 2 and 120),
  department   text not null,
  level        text not null,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Role helpers (used by RLS and by every write function)
-- ---------------------------------------------------------------------
-- Returns the caller's role, or NULL when: not signed in, suspended, or a
-- privileged role (admin/officer) that has not completed two-factor.
create or replace function public.app_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.status = 'active'
    and (p.role not in ('admin', 'officer')
         or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2')
$$;

create or replace function public.is_staff() returns boolean
language sql stable as $$ select public.app_role() in ('admin', 'officer', 'invigilator') $$;

create or replace function public.my_student_id() returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from public.students s
  join public.profiles p on p.id = s.user_id
  where s.user_id = auth.uid() and p.status = 'active' and p.role = 'student'
$$;

create or replace function public.require_role(variadic allowed public.app_role[]) returns public.app_role
language plpgsql stable as $$
declare r public.app_role := public.app_role();
begin
  if r is null or not (r = any (allowed)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return r;
end $$;

-- ---------------------------------------------------------------------
-- Audit log — append-only, hash-chained
-- ---------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid,
  actor_name text not null,
  action     text not null,
  detail     text not null default '',
  prev_hash  text not null,
  hash       text not null
);

-- Canonical text that gets hashed. Timestamp rendered in UTC with microseconds
-- so verification recomputes exactly the same bytes.
create or replace function public.audit_entry_hash(p_prev text, p_at timestamptz, p_actor text, p_action text, p_detail text)
returns text language sql immutable as $$
  select encode(extensions.digest(
    p_prev || '|' || to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
    p_actor || '|' || p_action || '|' || p_detail, 'sha256'), 'hex')
$$;

create or replace function public.tg_audit_chain() returns trigger
language plpgsql as $$
declare v_prev text;
begin
  -- serialise writers so two entries can never claim the same predecessor
  perform pg_advisory_xact_lock(hashtext('scriptree.audit_log'));
  select hash into v_prev from public.audit_log order by id desc limit 1;
  new.prev_hash := coalesce(v_prev, repeat('0', 64));
  new.at := clock_timestamp();
  new.hash := public.audit_entry_hash(new.prev_hash, new.at, new.actor_name, new.action, new.detail);
  return new;
end $$;

create trigger audit_chain before insert on public.audit_log
for each row execute function public.tg_audit_chain();

create or replace function public.tg_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end $$;

create trigger audit_no_update before update or delete on public.audit_log
for each row execute function public.tg_audit_immutable();
create trigger audit_no_truncate before truncate on public.audit_log
for each statement execute function public.tg_audit_immutable();

-- Internal: write an entry as the current user.
create or replace function public.audit(p_action text, p_detail text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select coalesce(
    (select full_name from public.profiles where id = auth.uid()),
    (select full_name from public.students where user_id = auth.uid()),
    'System') into v_name;
  insert into public.audit_log (actor_id, actor_name, action, detail)
  values (auth.uid(), v_name, p_action, coalesce(p_detail, ''));
end $$;
revoke all on function public.audit(text, text) from public, anon, authenticated;

-- Re-hash the whole chain. Returns the first broken entry id, or NULL if intact.
create or replace function public.verify_audit_chain()
returns table (ok boolean, entries bigint, broken_at bigint)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare e record; v_prev text := repeat('0', 64); v_n bigint := 0;
begin
  perform public.require_role('admin', 'officer');
  for e in select * from public.audit_log order by id loop
    v_n := v_n + 1;
    if e.prev_hash <> v_prev
       or e.hash <> public.audit_entry_hash(e.prev_hash, e.at, e.actor_name, e.action, e.detail) then
      return query select false, v_n, e.id; return;
    end if;
    v_prev := e.hash;
  end loop;
  return query select true, v_n, null::bigint;
end $$;

-- ---------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------
create table public.settings (
  id                  boolean primary key default true check (id),
  default_att_mode    public.attendance_mode not null default 'start',
  allow_pdf_upload    boolean not null default true,
  allow_photo_snaps   boolean not null default true,
  max_file_mb         int not null default 20 check (max_file_mb between 1 and 200),
  nightly_check_at    time not null default '02:00',
  alert_email         text,
  updated_at          timestamptz not null default now()
);
insert into public.settings default values;

-- ---------------------------------------------------------------------
-- Exams
-- ---------------------------------------------------------------------
create table public.exam_sessions (
  id              uuid primary key default gen_random_uuid(),
  course_code     text not null check (course_code ~ '^[A-Z]{2,5} [0-9]{3}$'),
  course_title    text not null,
  exam_date       date not null,
  start_time      time not null,
  venue           text not null,
  invigilator_id  uuid references public.profiles (id),
  status          public.session_status not null default 'scheduled',
  attendance_mode public.attendance_mode not null default 'start',
  headcount       int check (headcount >= 0),
  last_reconciled_at timestamptz,
  closed_at       timestamptz,
  created_by      uuid references public.profiles (id),
  created_at      timestamptz not null default now(),
  unique (course_code, exam_date)
);

-- Registered candidates. seq drives the human script ID: CSC401-261102-046
create table public.registrations (
  session_id  uuid not null references public.exam_sessions (id) on delete cascade,
  student_id  uuid not null references public.students (id),
  seq         int not null,
  script_code text not null unique,
  primary key (session_id, student_id),
  unique (session_id, seq)
);

create or replace function public.make_script_code(p_session uuid, p_seq int) returns text
language sql stable as $$
  select replace(course_code, ' ', '') || '-' || to_char(exam_date, 'YYMMDD') || '-' || lpad(p_seq::text, 3, '0')
  from public.exam_sessions where id = p_session
$$;

create table public.attendance (
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  student_id uuid not null references public.students (id),
  present    boolean not null,
  mode       public.attendance_mode not null,
  marked_by  uuid references auth.users (id),
  marked_at  timestamptz not null default now(),
  primary key (session_id, student_id)
);

-- Physical answer booklets
create table public.scripts (
  id          uuid primary key default gen_random_uuid(),
  script_code text not null unique,
  session_id  uuid not null references public.exam_sessions (id) on delete cascade,
  student_id  uuid not null references public.students (id),
  status      public.script_status not null default 'submitted',
  location    text not null default 'Exam hall',
  created_at  timestamptz not null default now(),
  unique (session_id, student_id)
);

create table public.custody_events (
  id         uuid primary key default gen_random_uuid(),
  script_id  uuid not null references public.scripts (id) on delete cascade,
  action     text not null,
  location   text not null,
  note       text,
  file_id    uuid,
  actor_id   uuid references auth.users (id),
  actor_name text not null,
  at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Preserved files (scans and student documents)
-- sha256 is computed SERVER-SIDE by the register-file edge function.
-- Files are never overwritten: a rescan is a new version; old ones go inactive.
-- ---------------------------------------------------------------------
create table public.doc_types (
  id       text primary key,
  name     text not null,
  required boolean not null default true,
  sort     int not null default 0
);
insert into public.doc_types (id, name, required, sort) values
  ('jamb',   'JAMB Admission Letter',       true,  1),
  ('olevel', 'WAEC / NECO Result',          true,  2),
  ('birth',  'Birth Certificate',           true,  3),
  ('origin', 'State of Origin Certificate', true,  4),
  ('cform',  'Course Registration Form',    false, 5);

create table public.files (
  id            uuid primary key default gen_random_uuid(),
  file_no       bigint generated always as identity unique,  -- shown as F0001
  kind          public.file_kind not null,
  session_id    uuid references public.exam_sessions (id),
  student_id    uuid not null references public.students (id),
  doc_type      text references public.doc_types (id),
  storage_path  text not null unique,
  original_name text not null,
  size_bytes    bigint not null check (size_bytes > 0),
  sha256        text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  version       int not null default 1,
  active        boolean not null default true,
  method        public.capture_method,
  pages         int,
  uploaded_by   uuid references auth.users (id),
  uploaded_by_name text not null,
  uploaded_at   timestamptz not null default now(),
  check ((kind = 'script' and session_id is not null and doc_type is null)
      or (kind = 'doc' and doc_type is not null))
);
create index files_sha256_idx on public.files (sha256);
create index files_session_student_idx on public.files (session_id, student_id) where kind = 'script';

alter table public.custody_events
  add constraint custody_events_file_fk foreign key (file_id) references public.files (id);

create table public.integrity_checks (
  id         bigint generated always as identity primary key,
  file_id    uuid not null references public.files (id),
  ok         boolean not null,
  computed   text not null,
  checked_at timestamptz not null default now(),
  run_id     uuid not null
);
create index integrity_checks_file_idx on public.integrity_checks (file_id, checked_at desc);

-- Latest check per file
create or replace view public.file_integrity with (security_invoker = on) as
select distinct on (f.id) f.id as file_id, ic.ok, ic.checked_at
from public.files f
left join public.integrity_checks ic on ic.file_id = f.id
order by f.id, ic.checked_at desc nulls last;

create table public.student_documents (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references public.students (id),
  doc_type    text not null references public.doc_types (id),
  file_id     uuid not null references public.files (id),
  status      public.doc_status not null default 'pending',
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  reason      text,
  created_at  timestamptz not null default now()
);
create index student_documents_student_idx on public.student_documents (student_id, doc_type, created_at desc);

-- ---------------------------------------------------------------------
-- Reconciliation follow-up
-- ---------------------------------------------------------------------
create table public.resolutions (
  session_id  uuid not null references public.exam_sessions (id) on delete cascade,
  student_id  uuid not null references public.students (id),
  outcome     text not null,
  action      text not null,
  note        text,
  resolved_by uuid references public.profiles (id),
  resolved_at timestamptz not null default now(),
  primary key (session_id, student_id)
);

create table public.alert_acks (
  alert_key text primary key,
  acked_by  uuid references public.profiles (id),
  acked_by_name text not null,
  acked_at  timestamptz not null default now()
);

-- Who may see a session. SECURITY DEFINER so RLS policies can call it
-- without policies on sessions/registrations recursing into each other.
create or replace function public.can_see_session(p_session uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.app_role()
    when 'admin' then true
    when 'officer' then true
    when 'invigilator' then exists (select 1 from public.exam_sessions s where s.id = p_session and s.invigilator_id = auth.uid())
    when 'student' then exists (select 1 from public.registrations r where r.session_id = p_session and r.student_id = public.my_student_id())
    else false end
$$;

-- ---------------------------------------------------------------------
-- Reconciliation: registered vs present vs physical vs scanned
-- Mirrors the prototype's outcome rules exactly.
-- ---------------------------------------------------------------------
create or replace function public.reconcile_session(p_session uuid)
returns table (
  student_id uuid, matric_no text, student_code text, full_name text,
  is_registered boolean, present boolean, has_physical boolean,
  n_scans int, integrity_bad boolean, outcome text, severity text,
  resolved boolean, script_code text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_live boolean; v_student uuid := public.my_student_id();
begin
  -- staff: sessions they can see; students: only their own row
  if not public.can_see_session(p_session) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  select s.status = 'live' or s.status = 'scheduled' into v_live from public.exam_sessions s where s.id = p_session;

  return query
  with cand as (
    select r.student_id from public.registrations r where r.session_id = p_session
    union select sc.student_id from public.scripts sc where sc.session_id = p_session
    union select f.student_id from public.files f where f.session_id = p_session and f.kind = 'script' and f.active
  ),
  base as (
    select c.student_id,
      exists (select 1 from public.registrations r where r.session_id = p_session and r.student_id = c.student_id) as reg,
      (select a.present from public.attendance a where a.session_id = p_session and a.student_id = c.student_id) as att,
      exists (select 1 from public.scripts sc where sc.session_id = p_session and sc.student_id = c.student_id) as phys,
      (select count(*)::int from public.files f where f.session_id = p_session and f.student_id = c.student_id and f.kind = 'script' and f.active) as nscan,
      exists (select 1 from public.files f join public.file_integrity fi on fi.file_id = f.id
              where f.session_id = p_session and f.student_id = c.student_id and f.kind = 'script' and f.active and fi.ok = false) as bad
    from cand c
    where v_student is null or c.student_id = v_student
  ),
  judged as (
    select b.*,
      case
        when not b.reg then array['Unregistered candidate', 'high']
        when b.att is null then array['Awaiting attendance', 'pend']
        when b.att = false and (b.phys or b.nscan > 0) then array['Absent but script exists', 'high']
        when b.att = false then array['Absent', 'info']
        when b.bad then array['Integrity failure', 'crit']
        when not b.phys and b.nscan = 0 then case when v_live then array['Script + scan pending', 'pend'] else array['Missing script and scan', 'crit'] end
        when not b.phys then case when v_live then array['Script check-in pending', 'pend'] else array['Missing physical script', 'high'] end
        when b.nscan > 1 then array['Duplicate scan', 'med']
        when b.nscan = 0 then case when v_live then array['Scan pending', 'pend'] else array['Missing scan', 'med'] end
        else array['Complete', 'ok']
      end as o
    from base b
  )
  select j.student_id, st.matric_no, st.student_code, st.full_name,
         j.reg, j.att, j.phys, j.nscan, j.bad, j.o[1], j.o[2],
         exists (select 1 from public.resolutions rs where rs.session_id = p_session and rs.student_id = j.student_id),
         coalesce((select sc.script_code from public.scripts sc where sc.session_id = p_session and sc.student_id = j.student_id),
                  (select r.script_code from public.registrations r where r.session_id = p_session and r.student_id = j.student_id))
  from judged j join public.students st on st.id = j.student_id
  order by st.matric_no;
end $$;

-- Four counts + headcount for a session
create or replace function public.session_counts(p_session uuid)
returns table (registered int, present int, physical int, scanned int, headcount int)
language sql stable security definer set search_path = public as $$
  select
    (select count(*)::int from public.registrations where session_id = p_session),
    (select count(*)::int from public.attendance a join public.registrations r using (session_id, student_id)
       where a.session_id = p_session and a.present),
    (select count(*)::int from public.scripts where session_id = p_session),
    (select count(distinct student_id)::int from public.files where session_id = p_session and kind = 'script' and active),
    (select headcount from public.exam_sessions where id = p_session)
  where public.is_staff() and public.can_see_session(p_session)
$$;

-- ---------------------------------------------------------------------
-- Write functions (role-checked + audited)
-- ---------------------------------------------------------------------

-- Student sign-in: map matric number / student ID to the auth email.
-- Callable before login. Returns NULL for unknown identifiers.
create or replace function public.student_login_email(p_identifier text) returns text
language sql stable security definer set search_path = public as $$
  select u.email from public.students s join auth.users u on u.id = s.user_id
  where upper(trim(p_identifier)) in (upper(s.matric_no), upper(s.student_code))
  limit 1
$$;
grant execute on function public.student_login_email(text) to anon, authenticated;

create or replace function public.record_sign_in() returns void
language plpgsql security definer set search_path = public as $$
declare v_role public.app_role;
begin
  select role into v_role from public.profiles where id = auth.uid();
  if v_role is null then return; end if;
  update public.profiles set last_sign_in_at = now() where id = auth.uid();
  perform public.audit('Sign in', initcap(v_role::text) || ' portal');
end $$;

-- Exams officer: create a session
create or replace function public.create_exam_session(
  p_course_code text, p_course_title text, p_date date, p_time time,
  p_venue text, p_invigilator uuid, p_att_mode public.attendance_mode)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform public.require_role('officer');
  if not exists (select 1 from public.profiles where id = p_invigilator and role = 'invigilator' and status = 'active') then
    raise exception 'Choose an active invigilator';
  end if;
  insert into public.exam_sessions (course_code, course_title, exam_date, start_time, venue, invigilator_id, attendance_mode, created_by)
  values (upper(trim(p_course_code)), trim(p_course_title), p_date, p_time, trim(p_venue), p_invigilator, p_att_mode, auth.uid())
  returning id into v_id;
  perform public.audit('Create exam session', upper(trim(p_course_code)) || ' · ' || p_date || ' · ' || trim(p_venue));
  return v_id;
end $$;

-- Exams officer: register candidates by matric number (from CSV import)
create or replace function public.register_candidates(p_session uuid, p_matrics text[])
returns table (added int, already int, unknown text[])
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_m text; v_sid uuid; v_seq int; v_added int := 0; v_already int := 0; v_unknown text[] := '{}'; v_code text;
begin
  perform public.require_role('officer');
  if (select status from public.exam_sessions where id = p_session) = 'closed' then
    raise exception 'Session is closed';
  end if;
  select coalesce(max(seq), 0) into v_seq from public.registrations where session_id = p_session;
  foreach v_m in array p_matrics loop
    select id into v_sid from public.students where matric_no = upper(trim(v_m));
    if v_sid is null then v_unknown := v_unknown || v_m; continue; end if;
    if exists (select 1 from public.registrations where session_id = p_session and student_id = v_sid) then
      v_already := v_already + 1; continue;
    end if;
    v_seq := v_seq + 1;
    insert into public.registrations (session_id, student_id, seq, script_code)
    values (p_session, v_sid, v_seq, public.make_script_code(p_session, v_seq));
    v_added := v_added + 1;
  end loop;
  select course_code into v_code from public.exam_sessions where id = p_session;
  perform public.audit('Import candidates', v_code || ' — ' || v_added || ' candidates registered'
    || case when cardinality(v_unknown) > 0 then ', ' || cardinality(v_unknown) || ' unknown' else '' end);
  return query select v_added, v_already, v_unknown;
end $$;

-- Invigilator (own session) / officer: open a session
create or replace function public.start_session(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions;
begin
  perform public.require_role('invigilator', 'officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if public.app_role() = 'invigilator' and s.invigilator_id <> auth.uid() then raise exception 'Not your session' using errcode = '42501'; end if;
  if s.status <> 'scheduled' then raise exception 'Session already %', s.status; end if;
  update public.exam_sessions set status = 'live' where id = p_session;
  perform public.audit('Open session', s.course_code || ' · ' || s.venue);
end $$;

-- helper: caller may run the hall for this session
create or replace function public.assert_hall(p_session uuid) returns public.exam_sessions
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions;
begin
  perform public.require_role('invigilator', 'officer');
  select * into s from public.exam_sessions where id = p_session;
  if s.id is null then raise exception 'No such session'; end if;
  if public.app_role() = 'invigilator' and s.invigilator_id is distinct from auth.uid() then
    raise exception 'Not your session' using errcode = '42501';
  end if;
  if s.status <> 'live' then raise exception 'Session is not live'; end if;
  return s;
end $$;
revoke all on function public.assert_hall(uuid) from public, anon, authenticated;

create or replace function public.set_attendance_mode(p_session uuid, p_mode public.attendance_mode) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session);
begin
  update public.exam_sessions set attendance_mode = p_mode where id = p_session;
  perform public.audit('Set attendance timing', s.course_code || ' — ' || p_mode);
end $$;

create or replace function public.set_headcount(p_session uuid, p_count int) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session);
begin
  if p_count < 0 or p_count > 5000 then raise exception 'Invalid headcount'; end if;
  update public.exam_sessions set headcount = p_count where id = p_session;
  perform public.audit('Record headcount', s.course_code || ' — ' || p_count);
end $$;

create or replace function public.mark_attendance(p_session uuid, p_student uuid, p_present boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session); v_matric text;
begin
  select matric_no into v_matric from public.students where id = p_student;
  if not exists (select 1 from public.registrations where session_id = p_session and student_id = p_student) then
    raise exception 'Student is not registered for this session';
  end if;
  insert into public.attendance (session_id, student_id, present, mode, marked_by)
  values (p_session, p_student, p_present, s.attendance_mode, auth.uid())
  on conflict (session_id, student_id) do update
    set present = excluded.present, mode = excluded.mode, marked_by = excluded.marked_by, marked_at = now();
  perform public.audit('Update attendance', s.course_code || ' — ' || v_matric || ' ' ||
    case when p_present then 'present' else 'absent' end || ' (' || s.attendance_mode || ')');
end $$;

-- Resolve matric no. / student ID / script ID to a student (optionally within a session)
create or replace function public.resolve_identifier(p_q text, p_session uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.students where upper(trim(p_q)) in (upper(matric_no), upper(student_code))),
    (select student_id from public.scripts where upper(script_code) = upper(trim(p_q)) and (p_session is null or session_id = p_session) limit 1),
    (select student_id from public.registrations where upper(script_code) = upper(trim(p_q)) and (p_session is null or session_id = p_session) limit 1))
  where public.is_staff()
$$;

-- Invigilator: check in a physical script
create or replace function public.check_in_script(p_session uuid, p_identifier text)
returns table (script_code text, registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare s public.exam_sessions := public.assert_hall(p_session);
        v_student uuid; v_reg public.registrations; v_code text; v_script uuid; v_name text; v_matric text;
begin
  v_student := public.resolve_identifier(p_identifier, p_session);
  if v_student is null then raise exception 'No student or script matches "%"', p_identifier; end if;
  if exists (select 1 from public.scripts where session_id = p_session and student_id = v_student) then
    raise exception 'Already checked in — possible duplicate booklet';
  end if;
  select * into v_reg from public.registrations where session_id = p_session and student_id = v_student;
  if v_reg.session_id is null then
    -- unregistered candidate: give a 9xx code so it can be tracked and flagged
    v_code := public.make_script_code(p_session, 900 + (select count(*)::int from public.scripts sc
      where sc.session_id = p_session and not exists (select 1 from public.registrations r where r.session_id = p_session and r.student_id = sc.student_id)) + 1);
  else
    v_code := v_reg.script_code;
  end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.scripts (script_code, session_id, student_id, status, location)
  values (v_code, p_session, v_student, 'submitted', 'Exam hall') returning id into v_script;
  insert into public.custody_events (script_id, action, location, actor_id, actor_name)
  values (v_script, 'Submitted to invigilator', s.venue, auth.uid(), v_name);
  if s.attendance_mode = 'submission' and v_reg.session_id is not null then
    insert into public.attendance (session_id, student_id, present, mode, marked_by)
    values (p_session, v_student, true, 'submission', auth.uid())
    on conflict (session_id, student_id) do update set present = true, mode = 'submission', marked_by = auth.uid(), marked_at = now();
  end if;
  select matric_no into v_matric from public.students where id = v_student;
  perform public.audit('Check in script', s.course_code || ' — ' || v_matric || ' (' || v_code || ')'
    || case when v_reg.session_id is null then ' — NOT REGISTERED' else '' end);
  return query select v_code, v_reg.session_id is not null;
end $$;

-- Invigilator: close session → gaps become discrepancies
create or replace function public.close_session(p_session uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session); v_open int;
begin
  update public.exam_sessions set status = 'closed', closed_at = now(), last_reconciled_at = now() where id = p_session;
  select count(*) into v_open from public.reconcile_session(p_session) r
    where r.severity in ('crit', 'high', 'med') and not r.resolved;
  perform public.audit('Close session', s.course_code || ' — ' || v_open || ' discrepancies raised');
  return v_open;
end $$;

-- Exams officer: run reconciliation (stamps time + audit)
create or replace function public.run_reconciliation(p_session uuid)
returns table (complete_count int, open_count int)
language plpgsql security definer set search_path = public as $$
declare v_c int; v_o int; v_code text;
begin
  perform public.require_role('officer');
  select count(*) filter (where severity = 'ok'), count(*) filter (where severity in ('crit','high','med') and not resolved)
    into v_c, v_o from public.reconcile_session(p_session);
  update public.exam_sessions set last_reconciled_at = now() where id = p_session returning course_code into v_code;
  perform public.audit('Run reconciliation', v_code || ' — ' || v_c || ' complete, ' || v_o || ' open discrepancies');
  return query select v_c, v_o;
end $$;

create or replace function public.resolve_discrepancy(p_session uuid, p_student uuid, p_outcome text, p_action text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text; v_matric text;
begin
  perform public.require_role('officer');
  if length(coalesce(p_action, '')) < 3 then raise exception 'Choose what was done'; end if;
  insert into public.resolutions (session_id, student_id, outcome, action, note, resolved_by)
  values (p_session, p_student, p_outcome, p_action, nullif(trim(p_note), ''), auth.uid())
  on conflict (session_id, student_id) do update
    set outcome = excluded.outcome, action = excluded.action, note = excluded.note, resolved_by = excluded.resolved_by, resolved_at = now();
  select course_code into v_code from public.exam_sessions where id = p_session;
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Resolve discrepancy', v_code || ' ' || v_matric || ' — ' || p_outcome || ': ' || p_action
    || coalesce(' (' || nullif(trim(p_note), '') || ')', ''));
end $$;

-- Exams officer: record a custody event (received / stored / retrieved ...)
create or replace function public.add_custody_event(p_script uuid, p_action text, p_location text)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text; v_name text; v_status public.script_status;
begin
  perform public.require_role('officer');
  v_status := case
    when p_action like 'Sealed%' then 'bundled'
    when p_action like 'Received%' then 'received'
    when p_action like 'Stored%' or p_action like 'Returned%' then 'stored'
    else 'out' end;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.custody_events (script_id, action, location, actor_id, actor_name)
  values (p_script, p_action, coalesce(nullif(trim(p_location), ''), 'Exams office'), auth.uid(), v_name);
  update public.scripts set status = v_status, location = coalesce(nullif(trim(p_location), ''), 'Exams office')
  where id = p_script returning script_code into v_code;
  perform public.audit('Custody event', v_code || ' — ' || p_action || ' (' || coalesce(nullif(trim(p_location), ''), 'Exams office') || ')');
end $$;

create or replace function public.decide_document(p_doc uuid, p_status public.doc_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare d public.student_documents; v_matric text; v_name text;
begin
  perform public.require_role('officer');
  if p_status = 'pending' then raise exception 'Choose verify or reject'; end if;
  if p_status = 'rejected' and length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Give a reason for rejecting'; end if;
  select * into d from public.student_documents where id = p_doc for update;
  if d.status <> 'pending' then raise exception 'Document already %', d.status; end if;
  update public.student_documents
     set status = p_status, verified_by = auth.uid(), verified_at = now(),
         reason = case when p_status = 'rejected' then trim(p_reason) end
   where id = p_doc;
  select matric_no into v_matric from public.students where id = d.student_id;
  select name into v_name from public.doc_types where id = d.doc_type;
  perform public.audit(case when p_status = 'verified' then 'Verify document' else 'Reject document' end, v_matric || ' — ' || v_name);
end $$;

create or replace function public.ack_alert(p_key text, p_title text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  perform public.require_role('officer');
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.alert_acks (alert_key, acked_by, acked_by_name) values (p_key, auth.uid(), v_name)
  on conflict (alert_key) do nothing;
  perform public.audit('Acknowledge alert', p_title);
end $$;

-- Admin
create or replace function public.update_settings(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_role('admin');
  update public.settings set
    default_att_mode  = coalesce((p ->> 'default_att_mode')::public.attendance_mode, default_att_mode),
    allow_pdf_upload  = coalesce((p ->> 'allow_pdf_upload')::boolean, allow_pdf_upload),
    allow_photo_snaps = coalesce((p ->> 'allow_photo_snaps')::boolean, allow_photo_snaps),
    max_file_mb       = coalesce((p ->> 'max_file_mb')::int, max_file_mb),
    nightly_check_at  = coalesce((p ->> 'nightly_check_at')::time, nightly_check_at),
    alert_email       = coalesce(p ->> 'alert_email', alert_email),
    updated_at = now();
  perform public.audit('Update settings', p::text);
end $$;

create or replace function public.set_account_status(p_user uuid, p_status public.account_status) returns void
language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public.require_role('admin');
  if p_user = auth.uid() then raise exception 'You cannot change your own status'; end if;
  update public.profiles set status = p_status where id = p_user returning * into v;
  perform public.audit(case when p_status = 'active' then 'Reactivate account' else 'Suspend account' end,
    v.full_name || ' — ' || v.role);
end $$;

-- ---------------------------------------------------------------------
-- RLS — reads only. No table grants writes to authenticated users;
-- all writes go through the functions above (or edge functions with the
-- service role).
-- ---------------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.students          enable row level security;
alter table public.audit_log         enable row level security;
alter table public.settings          enable row level security;
alter table public.exam_sessions     enable row level security;
alter table public.registrations     enable row level security;
alter table public.attendance        enable row level security;
alter table public.scripts           enable row level security;
alter table public.custody_events    enable row level security;
alter table public.doc_types         enable row level security;
alter table public.files             enable row level security;
alter table public.integrity_checks  enable row level security;
alter table public.student_documents enable row level security;
alter table public.resolutions       enable row level security;
alter table public.alert_acks        enable row level security;

-- profiles: yourself; staff see staff (names on sessions); admin sees all
create policy profiles_self on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_staff on public.profiles for select to authenticated using (public.is_staff() and role <> 'student');
create policy profiles_admin on public.profiles for select to authenticated using (public.app_role() = 'admin');

-- students: staff see all; a student sees self
create policy students_staff on public.students for select to authenticated using (public.is_staff());
create policy students_self on public.students for select to authenticated using (user_id = auth.uid());

create policy audit_read on public.audit_log for select to authenticated using (public.app_role() in ('admin', 'officer'));
create policy settings_read on public.settings for select to authenticated using (public.is_staff());
create policy doc_types_read on public.doc_types for select to authenticated using (auth.uid() is not null);

-- sessions + per-session tables: whoever can_see_session; students only their own rows
create policy sessions_read on public.exam_sessions for select to authenticated using (public.can_see_session(id));
create policy reg_staff on public.registrations for select to authenticated using (public.is_staff() and public.can_see_session(session_id));
create policy reg_self on public.registrations for select to authenticated using (student_id = public.my_student_id());
create policy att_staff on public.attendance for select to authenticated using (public.is_staff() and public.can_see_session(session_id));
create policy att_self on public.attendance for select to authenticated using (student_id = public.my_student_id());
create policy scripts_staff on public.scripts for select to authenticated using (public.is_staff() and public.can_see_session(session_id));
create policy scripts_self on public.scripts for select to authenticated using (student_id = public.my_student_id());
create policy custody_staff on public.custody_events for select to authenticated using (
  public.is_staff() and exists (select 1 from public.scripts sc where sc.id = script_id and public.can_see_session(sc.session_id)));
create policy resolutions_staff on public.resolutions for select to authenticated using (public.app_role() in ('admin', 'officer'));
create policy acks_staff on public.alert_acks for select to authenticated using (public.app_role() in ('admin', 'officer'));

-- files: officer/admin all; invigilator scans for own sessions; student own
create policy files_officer on public.files for select to authenticated using (public.app_role() in ('admin', 'officer'));
create policy files_invig on public.files for select to authenticated using (
  public.app_role() = 'invigilator' and kind = 'script' and public.can_see_session(session_id));
create policy files_self on public.files for select to authenticated using (student_id = public.my_student_id());
create policy integrity_read on public.integrity_checks for select to authenticated using (public.app_role() in ('admin', 'officer'));
create policy docs_officer on public.student_documents for select to authenticated using (public.app_role() in ('admin', 'officer'));
create policy docs_self on public.student_documents for select to authenticated using (student_id = public.my_student_id());

-- Defence in depth: no direct writes to app tables from the API roles,
-- even if a permissive policy is ever added by mistake.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on all tables in schema public from anon;

-- Lock down function execution: signed-in users only, internal helpers nobody.
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
revoke execute on function public.audit(text, text) from authenticated;
revoke execute on function public.assert_hall(uuid) from authenticated;
revoke execute on function public.tg_audit_chain() from authenticated;
revoke execute on function public.tg_audit_immutable() from authenticated;
grant  execute on function public.student_login_email(text) to anon;

-- ---------------------------------------------------------------------
-- Storage buckets (private). Uploads land in incoming/ and are only
-- "registered" (hashed, given a files row) by the register-file edge function.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scans', 'scans', false, 209715200, array['application/pdf']),
       ('documents', 'documents', false, 52428800, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Staff in the hall upload scans to scans/incoming/<uid>/...
create policy scans_upload on storage.objects for insert to authenticated
with check (bucket_id = 'scans' and public.app_role() in ('invigilator', 'officer')
            and (storage.foldername(name))[1] = 'incoming'
            and (storage.foldername(name))[2] = auth.uid()::text);
-- Students upload to documents/incoming/<uid>/...
create policy docs_upload on storage.objects for insert to authenticated
with check (bucket_id = 'documents' and public.app_role() = 'student'
            and (storage.foldername(name))[1] = 'incoming'
            and (storage.foldername(name))[2] = auth.uid()::text);
-- Reading archived files: officers/admins only (students get signed URLs via edge function later)
create policy archive_read on storage.objects for select to authenticated
using (bucket_id in ('scans', 'documents') and public.app_role() in ('admin', 'officer'));

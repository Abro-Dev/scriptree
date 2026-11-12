-- One identifier per student: the student ID, e.g. BU/24C/IT/10778
--   BU     school code (letters)
--   24C    year of entry (two digits) + intake A, B, C or D
--   IT     department code (letters)
--   10778  student number
--
-- The separate "ST…" student code is dropped. The ID lives in students.matric_no (column name kept so
-- the ~20 functions and the API that read it don't all need rewriting); every screen and CSV calls it "Student ID".
-- Script codes become student ID + course code, e.g. BU/24C/IT/10778-CSC409.
--
-- Self-contained: safe to run whether or not 20261112000000_matric_format.sql was applied first.

-- ---------------------------------------------------------------------
-- the format rule
-- ---------------------------------------------------------------------
create or replace function public.is_student_id(p text) returns boolean
language sql immutable parallel safe set search_path = public as $$
  select coalesce(p ~ '^[A-Z]{2,5}/[0-9]{2}[A-D]/[A-Z]{2,5}/[0-9]{3,6}$', false)
$$;
grant execute on function public.is_student_id(text) to authenticated, service_role;

do $$
declare n int; c text;
begin
  select count(*) into n from public.students where not public.is_student_id(matric_no);
  if n > 0 then
    raise exception '% student(s) have an ID that is not in the BU/24C/IT/10778 format — fix or remove them before applying this migration', n;
  end if;
  -- drop the old format checks on matric_no / student_code, whatever they are named
  for c in select conname from pg_constraint
           where conrelid = 'public.students'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ~ '(matric_no|student_code)' loop
    execute format('alter table public.students drop constraint %I', c);
  end loop;
end $$;

alter table public.students add constraint students_student_id_check check (public.is_student_id(matric_no));
alter table public.students drop column if exists student_code;
drop function if exists public.is_matric(text);

-- ---------------------------------------------------------------------
-- script code = student ID + course code (-2, -3 … for a resit)
-- ---------------------------------------------------------------------
create or replace function public.make_script_code(p_session uuid, p_student uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_base text; v_code text; n int := 1;
begin
  select st.matric_no || '-' || replace(es.course_code, ' ', '') into v_base
  from public.students st, public.exam_sessions es
  where st.id = p_student and es.id = p_session;
  if v_base is null then raise exception 'Unknown student or session'; end if;
  v_code := v_base;
  -- taken by another sitting of the same course: this is a resit
  while exists (select 1 from public.scripts sc where sc.script_code = v_code
                and not (sc.session_id = p_session and sc.student_id = p_student)) loop
    n := n + 1;
    v_code := v_base || '-' || n;
  end loop;
  return v_code;
end $$;

-- ---------------------------------------------------------------------
-- reconcile_session: no student_code column (return type changes, so drop first)
-- ---------------------------------------------------------------------
drop function if exists public.reconcile_session(uuid);
create function public.reconcile_session(p_session uuid)
returns table (
  student_id uuid, matric_no text, full_name text,
  is_registered boolean, present boolean, has_physical boolean,
  n_scans int, integrity_bad boolean, outcome text, severity text,
  resolved boolean, script_code text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_live boolean; v_student uuid := public.my_student_id();
begin
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
        when b.att is null then case when v_live then array['Awaiting attendance', 'pend'] else array['Attendance not marked', 'med'] end
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
  select j.student_id, st.matric_no, st.full_name,
         j.reg, j.att, j.phys, j.nscan, j.bad, j.o[1], j.o[2],
         exists (select 1 from public.resolutions rs where rs.session_id = p_session and rs.student_id = j.student_id and rs.outcome = j.o[1]),
         (select sc.script_code from public.scripts sc where sc.session_id = p_session and sc.student_id = j.student_id)
  from judged j join public.students st on st.id = j.student_id
  order by st.matric_no;
end $$;
revoke all on function public.reconcile_session(uuid) from public, anon;
grant execute on function public.reconcile_session(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- lookups by student ID (or script code)
-- ---------------------------------------------------------------------
create or replace function public.student_login_email(p_identifier text) returns text
language sql stable security definer set search_path = public as $$
  select u.email from public.students s join auth.users u on u.id = s.user_id
  where s.matric_no = upper(trim(p_identifier))
  limit 1
$$;

create or replace function public.resolve_identifier(p_q text, p_session uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.students where matric_no = upper(trim(p_q)) limit 1),
    (select student_id from public.scripts where script_code = upper(trim(p_q)) and (p_session is null or session_id = p_session) limit 1),
    (select st.id from public.students st, public.exam_sessions es
      where p_session is not null and es.id = p_session
        and st.matric_no = split_part(upper(trim(p_q)), '-', 1)
        and upper(trim(p_q)) = st.matric_no || '-' || replace(es.course_code, ' ', '')))
  where public.is_staff()
$$;

-- ---------------------------------------------------------------------
-- student roster import: student ID + details (CSV column student_id; matric_no still accepted)
-- ---------------------------------------------------------------------
create or replace function public.add_students(p_rows jsonb)
returns table (created int, existing int, updated int, skipped jsonb, ids uuid[])
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  r jsonb; v_id text; v_name text; v_dept text; v_level text; v_email text; v_raw_email text;
  v_sid uuid; v_cur_email text;
  v_created int := 0; v_existing int := 0; v_updated int := 0; v_skip jsonb[] := '{}'; v_ids uuid[] := '{}';
begin
  perform public.require_role('admin', 'officer');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_id        := upper(trim(coalesce(r ->> 'student_id', r ->> 'matric_no', '')));
    v_name      := regexp_replace(trim(coalesce(r ->> 'full_name', '')), '\s+', ' ', 'g');
    v_dept      := trim(coalesce(r ->> 'department', ''));
    v_level     := upper(trim(coalesce(r ->> 'level', '')));
    v_raw_email := trim(coalesce(r ->> 'email', ''));
    v_email     := public.clean_email(v_raw_email);

    if not public.is_student_id(v_id) then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Invalid student ID (e.g. BU/24C/IT/10778)'); continue;
    end if;
    if v_raw_email <> '' and v_email is null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Invalid email: ' || left(v_raw_email, 60)); continue;
    end if;

    select id, email into v_sid, v_cur_email from public.students where matric_no = v_id;
    if v_sid is not null then
      if v_cur_email is null and v_email is not null then
        update public.students set email = v_email where id = v_sid;
        v_updated := v_updated + 1;
      end if;
      v_existing := v_existing + 1; v_ids := v_ids || v_sid; continue;
    end if;

    if length(v_name) < 2 or length(v_name) > 120 then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Full name missing'); continue;
    end if;
    if v_email is null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Email missing'); continue;
    end if;
    if v_dept = '' or length(v_dept) > 80 then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Department missing'); continue;
    end if;
    if v_level = '' or length(v_level) > 20 then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Level missing'); continue;
    end if;

    insert into public.students (matric_no, full_name, department, level, email)
    values (v_id, v_name, v_dept, v_level, v_email) returning id into v_sid;
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

-- ---------------------------------------------------------------------
-- candidate import for a session
-- ---------------------------------------------------------------------
create or replace function public.import_candidates(p_session uuid, p_rows jsonb)
returns table (added int, created int, already int, skipped jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  s public.exam_sessions; r jsonb; v_id text; v_sid uuid; v_seq int;
  v_added int := 0; v_created int := 0; v_already int := 0; v_skip jsonb[] := '{}';
  v_name text; v_email text; v_raw_email text;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status = 'closed' then raise exception 'Session is closed'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.reg.' || p_session));
  select coalesce(max(seq), 0) into v_seq from public.registrations where session_id = p_session;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_id := upper(trim(coalesce(r ->> 'student_id', r ->> 'matric_no', '')));
    if not public.is_student_id(v_id) then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Invalid student ID (e.g. BU/24C/IT/10778)'); continue;
    end if;
    if nullif(trim(r ->> 'course_code'), '') is not null and upper(trim(r ->> 'course_code')) <> s.course_code then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Different course: ' || (r ->> 'course_code')); continue;
    end if;
    v_raw_email := trim(coalesce(r ->> 'email', ''));
    v_email := public.clean_email(v_raw_email);
    if v_raw_email <> '' and v_email is null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Invalid email: ' || left(v_raw_email, 60)); continue;
    end if;
    select id into v_sid from public.students where matric_no = v_id;
    if v_sid is null then
      v_name := trim(coalesce(r ->> 'full_name', ''));
      if length(v_name) < 2 or nullif(trim(r ->> 'department'), '') is null or nullif(trim(r ->> 'level'), '') is null or v_email is null then
        v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Unknown student — add full_name, email, department and level to create them'); continue;
      end if;
      insert into public.students (matric_no, full_name, department, level, email)
      values (v_id, left(v_name, 120), trim(r ->> 'department'), trim(r ->> 'level'), v_email) returning id into v_sid;
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

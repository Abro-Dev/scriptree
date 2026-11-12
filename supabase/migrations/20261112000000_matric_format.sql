-- Matric numbers now follow the school format, e.g. BU/24C/IT/10778:
--   BU     school code (letters)
--   24C    year of entry (two digits) + intake A, B, C or D
--   IT     department code (letters)
--   10778  student number
-- One helper holds the rule so the table constraint and every import path agree.

create or replace function public.is_matric(p text) returns boolean
language sql immutable parallel safe set search_path = public as $$
  select coalesce(p ~ '^[A-Z]{2,5}/[0-9]{2}[A-D]/[A-Z]{2,5}/[0-9]{3,6}$', false)
$$;

do $$
declare n int; c text;
begin
  select count(*) into n from public.students where not public.is_matric(matric_no);
  if n > 0 then
    raise exception '% student(s) have a matric number in the old format — fix or remove them before applying this migration', n;
  end if;
  -- drop the old format check whatever it is named
  for c in select conname from pg_constraint
           where conrelid = 'public.students'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%matric_no%' loop
    execute format('alter table public.students drop constraint %I', c);
  end loop;
end $$;

alter table public.students add constraint students_matric_no_check check (public.is_matric(matric_no));

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

    if not public.is_matric(v_matric) then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid matric number (e.g. BU/24C/IT/10778)'); continue;
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
    if not public.is_matric(v_matric) then
      v_skip := v_skip || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid matric number (e.g. BU/24C/IT/10778)'); continue;
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

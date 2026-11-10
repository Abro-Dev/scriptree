-- Script codes are now Student ID + course code, created when the script is submitted.
--
-- Before: each registration was given a code like CSC401-261102-046 (course, date, register order)
-- at import time, and unregistered candidates got a 9xx number at check-in.
--
-- Now:
--   * The code is <student ID>-<course code>, e.g. ST210034-CSC409. The same booklet carries the same
--     code from hall submission through custody, scanning, marking and recording.
--   * It's created at submission (check_in_script / fix_check_in_script), not at registration.
--     A registered candidate who never submits has no script code.
--   * A student who sits the same course again (resit) gets a suffix so the code stays unique:
--     ST210034-CSC409-2, -3, ...
--   * registrations.script_code is dropped. Existing scripts are renamed to the new format.

-- ---------------------------------------------------------------------
-- The generator
-- ---------------------------------------------------------------------
create or replace function public.make_script_code(p_session uuid, p_student uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_base text; v_code text; n int := 1;
begin
  select st.student_code || '-' || replace(es.course_code, ' ', '') into v_base
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
revoke all on function public.make_script_code(uuid, uuid) from public, anon, authenticated;

-- rename existing scripts, oldest first so first sittings keep the plain code
do $$
declare r record;
begin
  for r in select id, session_id, student_id from public.scripts order by created_at, id loop
    update public.scripts set script_code = public.make_script_code(r.session_id, r.student_id) where id = r.id;
  end loop;
end $$;

alter table public.registrations drop column script_code;
drop function if exists public.make_script_code(uuid, int);

-- ---------------------------------------------------------------------
-- Lookup: a script code resolves to its student. A code typed before the script
-- exists (student ID + this session's course) also resolves.
-- ---------------------------------------------------------------------
create or replace function public.resolve_identifier(p_q text, p_session uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.students where upper(trim(p_q)) in (upper(matric_no), upper(student_code))),
    (select student_id from public.scripts where upper(script_code) = upper(trim(p_q)) and (p_session is null or session_id = p_session) limit 1),
    (select st.id from public.students st, public.exam_sessions es
      where p_session is not null and es.id = p_session
        and upper(trim(p_q)) = upper(st.student_code || '-' || replace(es.course_code, ' ', ''))))
  where public.is_staff()
$$;

-- ---------------------------------------------------------------------
-- Submission: the code is created here
-- ---------------------------------------------------------------------
create or replace function public.check_in_script(p_session uuid, p_identifier text)
returns table (script_code text, registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare s public.exam_sessions := public.assert_hall(p_session);
        v_student uuid; v_reg boolean; v_code text; v_script uuid; v_name text; v_matric text;
begin
  v_student := public.resolve_identifier(p_identifier, p_session);
  if v_student is null then raise exception 'No student or script matches "%"', p_identifier; end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.script.' || v_student));
  if exists (select 1 from public.scripts where session_id = p_session and student_id = v_student) then
    raise exception 'Already checked in — possible duplicate booklet';
  end if;
  v_reg := exists (select 1 from public.registrations where session_id = p_session and student_id = v_student);
  v_code := public.make_script_code(p_session, v_student);
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.scripts (script_code, session_id, student_id, status, location)
  values (v_code, p_session, v_student, 'submitted', 'Exam hall') returning id into v_script;
  insert into public.custody_events (script_id, action, location, actor_id, actor_name)
  values (v_script, 'Submitted to invigilator', s.venue, auth.uid(), v_name);
  if s.attendance_mode = 'submission' and v_reg then
    insert into public.attendance (session_id, student_id, present, mode, marked_by)
    values (p_session, v_student, true, 'submission', auth.uid())
    on conflict (session_id, student_id) do update set present = true, mode = 'submission', marked_by = auth.uid(), marked_at = now();
  end if;
  select matric_no into v_matric from public.students where id = v_student;
  perform public.audit('Check in script', s.course_code || ' — ' || v_matric || ' (' || v_code || ')'
    || case when not v_reg then ' — NOT REGISTERED' else '' end);
  return query select v_code, v_reg;
end $$;

create or replace function public.fix_check_in_script(p_session uuid, p_student uuid, p_location text, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_fix(p_session, p_note);
        v_code text; v_script uuid; v_name text; v_matric text; v_loc text := trim(coalesce(p_location, ''));
begin
  if length(v_loc) < 2 or length(v_loc) > 80 then raise exception 'Say where the script is now'; end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.script.' || p_student));
  if exists (select 1 from public.scripts where session_id = p_session and student_id = p_student) then
    raise exception 'A script is already checked in for this candidate';
  end if;
  if not exists (select 1 from public.registrations where session_id = p_session and student_id = p_student) then
    raise exception 'Register the candidate for this session first';
  end if;
  v_code := public.make_script_code(p_session, p_student);
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.scripts (script_code, session_id, student_id, status, location)
  values (v_code, p_session, p_student, 'submitted', v_loc) returning id into v_script;
  insert into public.custody_events (script_id, action, location, note, actor_id, actor_name)
  values (v_script, 'Located and checked in by exams office', v_loc, trim(p_note), auth.uid(), v_name);
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Late script check-in', s.course_code || ' — ' || v_matric || ' (' || v_code || ') at ' || v_loc || ' (' || trim(p_note) || ')');
  return v_code;
end $$;

-- Late registration no longer renumbers anything: the script (if any) already has its final code.
create or replace function public.fix_register_candidate(p_session uuid, p_student uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_fix(p_session, p_note); v_seq int; v_code text; v_matric text;
begin
  if exists (select 1 from public.registrations where session_id = p_session and student_id = p_student) then
    raise exception 'Already registered';
  end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.reg.' || p_session));
  select coalesce(max(seq), 0) + 1 into v_seq from public.registrations where session_id = p_session;
  insert into public.registrations (session_id, student_id, seq) values (p_session, p_student, v_seq);
  select script_code into v_code from public.scripts where session_id = p_session and student_id = p_student;
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Late registration', s.course_code || ' — ' || v_matric || ' registered'
    || coalesce(' (script ' || v_code || ')', '') || ' (' || trim(p_note) || ')');
  return v_code;
end $$;

-- ---------------------------------------------------------------------
-- Registration: no code any more
-- ---------------------------------------------------------------------
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
  perform pg_advisory_xact_lock(hashtext('scriptree.reg.' || p_session));
  select coalesce(max(seq), 0) into v_seq from public.registrations where session_id = p_session;
  foreach v_m in array p_matrics loop
    select id into v_sid from public.students where matric_no = upper(trim(v_m));
    if v_sid is null then v_unknown := v_unknown || v_m; continue; end if;
    if exists (select 1 from public.registrations where session_id = p_session and student_id = v_sid) then
      v_already := v_already + 1; continue;
    end if;
    v_seq := v_seq + 1;
    insert into public.registrations (session_id, student_id, seq) values (p_session, v_sid, v_seq);
    v_added := v_added + 1;
  end loop;
  select course_code into v_code from public.exam_sessions where id = p_session;
  perform public.audit('Import candidates', v_code || ' — ' || v_added || ' candidates registered'
    || case when cardinality(v_unknown) > 0 then ', ' || cardinality(v_unknown) || ' unknown' else '' end);
  return query select v_added, v_already, v_unknown;
end $$;

create or replace function public.import_candidates(p_session uuid, p_rows jsonb)
returns table (added int, created int, already int, skipped jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  s public.exam_sessions; r jsonb; v_matric text; v_sid uuid; v_seq int;
  v_added int := 0; v_created int := 0; v_already int := 0; v_skipped jsonb := '[]'::jsonb;
  v_code text; v_name text; v_email text; v_raw_email text;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status = 'closed' then raise exception 'Session is closed'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;
  select coalesce(max(seq), 0) into v_seq from public.registrations where session_id = p_session;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_matric := upper(trim(coalesce(r ->> 'matric_no', '')));
    if v_matric !~ '^[A-Z]{2,5}/[0-9]{2}/[0-9]{3,6}$' then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid matric number'); continue;
    end if;
    if nullif(trim(r ->> 'course_code'), '') is not null and upper(trim(r ->> 'course_code')) <> s.course_code then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Different course: ' || (r ->> 'course_code')); continue;
    end if;
    v_raw_email := trim(coalesce(r ->> 'email', ''));
    v_email := public.clean_email(v_raw_email);
    if v_raw_email <> '' and v_email is null then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid email: ' || left(v_raw_email, 60)); continue;
    end if;
    select id into v_sid from public.students where matric_no = v_matric;
    if v_sid is null then
      v_code := upper(trim(coalesce(r ->> 'student_code', '')));
      v_name := trim(coalesce(r ->> 'full_name', ''));
      if v_code !~ '^ST[0-9]{4,10}$' or length(v_name) < 2 or nullif(trim(r ->> 'department'), '') is null or nullif(trim(r ->> 'level'), '') is null or v_email is null then
        v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Unknown student — add full_name, student_code, email, department and level to create them'); continue;
      end if;
      if exists (select 1 from public.students where student_code = v_code) then
        v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Student ID ' || v_code || ' belongs to another matric number'); continue;
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
    || case when jsonb_array_length(v_skipped) > 0 then ', ' || jsonb_array_length(v_skipped) || ' skipped' else '' end);
  return query select v_added, v_created, v_already, v_skipped;
end $$;

-- ---------------------------------------------------------------------
-- reconcile_session: script_code comes only from a submitted script
-- (unchanged otherwise from 20261109040000_resolve_fixes)
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
  select j.student_id, st.matric_no, st.student_code, st.full_name,
         j.reg, j.att, j.phys, j.nscan, j.bad, j.o[1], j.o[2],
         exists (select 1 from public.resolutions rs where rs.session_id = p_session and rs.student_id = j.student_id and rs.outcome = j.o[1]),
         (select sc.script_code from public.scripts sc where sc.session_id = p_session and sc.student_id = j.student_id)
  from judged j join public.students st on st.id = j.student_id
  order by st.matric_no;
end $$;

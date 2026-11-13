-- =====================================================================
-- Fixes from the 2026-11-13 audit (brute-force, fuzz and race testing).
--
-- Security / integrity
--   1. A temporary password must be replaced before the database grants anything (was browser-only).
--   2. ack_alert only accepts alerts that exist right now, and takes the title from the alert itself.
--   3. Audit chain: the nightly check remembers the newest entry it saw, so entries deleted from the
--      end are noticed; its result is what the in-app "verify" shows; a weekly anchor email carries
--      the newest entry's number and hash outside the database.
--   4. Scans: the same file saved against a different candidate is reported.
--   5. Sign-in limiter: all-address cap raised (20 let anyone lock a student out).
--   6. Invigilators see their candidates' student records only around the exam, not forever.
--   7. Nothing in public is executable before sign-in (PostgreSQL re-grants EXECUTE to PUBLIC on
--      every new function; a per-schema default can't switch that off).
-- Features that were missing
--   8. Several halls or sittings for one course on one day.
--   9. Edit, cancel and reopen a session; change its invigilator. Edit a student's record.
--  10. Withdraw a verification made by mistake. Students can open their own documents.
--  11. Mark everyone present in one go.
-- Robustness
--  12. close_session can't run twice at once; roster imports can't collide; text and date limits on
--      sessions, imports and resolutions.
--  13. The alert sender stops firing every 5 minutes when no alert email is set.
--
-- Deploy with it: admin-users, integrity-check, register-file (and student-login for its comment only).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Temporary password = no role yet
-- ---------------------------------------------------------------------
create or replace function public.app_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.status = 'active'
    and not p.must_change_password
    and (p.role not in ('admin', 'officer')
         or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2')
$$;

create or replace function public.my_student_id() returns uuid
language sql stable security definer set search_path = public as $$
  select s.id from public.students s
  join public.profiles p on p.id = s.user_id
  where s.user_id = auth.uid() and p.status = 'active' and p.role = 'student' and not p.must_change_password
$$;

-- ---------------------------------------------------------------------
-- 8. Several halls / sittings per course per day
-- ---------------------------------------------------------------------
alter table public.exam_sessions drop constraint if exists exam_sessions_course_code_exam_date_key;
create unique index if not exists exam_sessions_sitting_idx
  on public.exam_sessions (course_code, exam_date, start_time, lower(venue));
create index if not exists exam_sessions_course_date_idx on public.exam_sessions (course_code, exam_date);

-- shared checks for creating and editing a session; returns the normalised course code
create or replace function public.check_session_fields(p_course_code text, p_title text, p_date date, p_time time, p_venue text, p_invigilator uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare v_code text := regexp_replace(upper(trim(coalesce(p_course_code, ''))), '^([A-Z]{2,5})\s*([0-9]{3})$', '\1 \2');
begin
  if v_code !~ '^[A-Z]{2,5} [0-9]{3}$' then raise exception 'Course code looks like "CSC 411"'; end if;
  if length(trim(coalesce(p_title, ''))) not between 3 and 200 then raise exception 'Enter the course title (3 to 200 characters)'; end if;
  if length(trim(coalesce(p_venue, ''))) not between 2 and 120 then raise exception 'Enter the venue (2 to 120 characters)'; end if;
  if p_date is null or p_date < current_date - 366 or p_date > current_date + 731 then raise exception 'Choose an exam date within the last year or the next two'; end if;
  if p_time is null then raise exception 'Enter the start time'; end if;
  if p_invigilator is null or not exists (select 1 from public.profiles where id = p_invigilator and role = 'invigilator' and status = 'active') then
    raise exception 'Choose an active invigilator';
  end if;
  return v_code;
end $$;
revoke all on function public.check_session_fields(text, text, date, time, text, uuid) from public, anon, authenticated;

create or replace function public.create_exam_session(
  p_course_code text, p_course_title text, p_date date, p_time time,
  p_venue text, p_invigilator uuid, p_att_mode public.attendance_mode)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_code text; v_mode public.attendance_mode;
begin
  perform public.require_role('officer');
  v_code := public.check_session_fields(p_course_code, p_course_title, p_date, p_time, p_venue, p_invigilator);
  v_mode := coalesce(p_att_mode, (select default_att_mode from public.settings), 'start');
  begin
    insert into public.exam_sessions (course_code, course_title, exam_date, start_time, venue, invigilator_id, attendance_mode, created_by)
    values (v_code, trim(p_course_title), p_date, p_time, trim(p_venue), p_invigilator, v_mode, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception '% already has a session on % at % in % (duplicate)', v_code, p_date, to_char(p_time, 'HH24:MI'), trim(p_venue);
  end;
  perform public.audit('Create exam session', v_code || ' · ' || p_date || ' ' || to_char(p_time, 'HH24:MI') || ' · ' || trim(p_venue));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 9. Edit / cancel / reopen a session
-- ---------------------------------------------------------------------
-- Scheduled: everything but the course code. Live: title, venue and invigilator (a stand-in takes over).
create or replace function public.update_exam_session(
  p_session uuid, p_course_title text, p_date date, p_time time, p_venue text, p_invigilator uuid)
returns void language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions; v_changes text[] := '{}'; v_old text; v_new text;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status = 'closed' then raise exception 'Session is closed — reopen it first'; end if;
  if s.status = 'live' and (p_date is distinct from s.exam_date or p_time is distinct from s.start_time) then
    raise exception 'The date and time can''t change once the session is open';
  end if;
  -- an unchanged invigilator may have been suspended since; only a new choice has to be active
  if p_invigilator is distinct from s.invigilator_id then
    perform public.check_session_fields(s.course_code, p_course_title, p_date, p_time, p_venue, p_invigilator);
  else
    perform public.check_session_fields(s.course_code, p_course_title, p_date, p_time, p_venue,
      (select id from public.profiles where role = 'invigilator' and status = 'active' limit 1));
  end if;
  if trim(p_course_title) <> s.course_title then v_changes := v_changes || ('title → ' || left(trim(p_course_title), 80)); end if;
  if p_date <> s.exam_date then v_changes := v_changes || ('date ' || s.exam_date || ' → ' || p_date); end if;
  if p_time <> s.start_time then v_changes := v_changes || ('time ' || to_char(s.start_time, 'HH24:MI') || ' → ' || to_char(p_time, 'HH24:MI')); end if;
  if trim(p_venue) <> s.venue then v_changes := v_changes || ('venue ' || s.venue || ' → ' || trim(p_venue)); end if;
  if p_invigilator is distinct from s.invigilator_id then
    select full_name into v_old from public.profiles where id = s.invigilator_id;
    select full_name into v_new from public.profiles where id = p_invigilator;
    v_changes := v_changes || ('invigilator ' || coalesce(v_old, 'nobody') || ' → ' || v_new);
  end if;
  if cardinality(v_changes) = 0 then return; end if;
  begin
    update public.exam_sessions set course_title = trim(p_course_title), exam_date = p_date, start_time = p_time,
           venue = trim(p_venue), invigilator_id = p_invigilator
     where id = p_session;
  exception when unique_violation then
    raise exception '% already has a session on % at % in %', s.course_code, p_date, to_char(p_time, 'HH24:MI'), trim(p_venue);
  end;
  perform public.audit('Edit exam session', s.course_code || ' · ' || s.exam_date || ' — ' || array_to_string(v_changes, '; '));
end $$;

-- Cancel = remove a session that never started. Anything with attendance, scripts or scans stays.
create or replace function public.delete_exam_session(p_session uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions; v_reg int;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status <> 'scheduled' then raise exception 'Only a session that hasn''t been opened can be cancelled'; end if;
  if length(trim(coalesce(p_reason, ''))) not between 5 and 300 then raise exception 'Say why the session is being cancelled'; end if;
  if exists (select 1 from public.attendance where session_id = p_session)
     or exists (select 1 from public.scripts where session_id = p_session)
     or exists (select 1 from public.files where session_id = p_session) then
    raise exception 'This session already has attendance, scripts or scans — it can''t be cancelled';
  end if;
  select count(*) into v_reg from public.registrations where session_id = p_session;
  delete from public.exam_sessions where id = p_session;   -- registrations go with it
  perform public.audit('Cancel exam session', s.course_code || ' · ' || s.exam_date || ' · ' || s.venue || ' — ' || v_reg
    || ' registrations removed (' || trim(p_reason) || ')');
end $$;

-- Closed by mistake, or scripts turned up: back to live. Marks made at close stay and can be corrected.
create or replace function public.reopen_session(p_session uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status <> 'closed' then raise exception 'Only a closed session can be reopened'; end if;
  if length(trim(coalesce(p_note, ''))) not between 5 and 300 then raise exception 'Say why the session is being reopened'; end if;
  update public.exam_sessions set status = 'live', closed_at = null where id = p_session;
  perform public.audit('Reopen session', s.course_code || ' · ' || s.venue || ' (' || trim(p_note) || ')');
end $$;

-- ---------------------------------------------------------------------
-- 9. Edit a student's record (the student ID itself never changes)
-- ---------------------------------------------------------------------
create or replace function public.update_student(p_student uuid, p_full_name text, p_email text, p_department text, p_level text)
returns void language plpgsql security definer set search_path = public as $$
declare st public.students; v_name text := regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g');
        v_dept text := trim(coalesce(p_department, '')); v_level text := upper(trim(coalesce(p_level, '')));
        v_raw text := trim(coalesce(p_email, '')); v_email text := public.clean_email(p_email); v_changes text[] := '{}';
begin
  perform public.require_role('admin', 'officer');
  select * into st from public.students where id = p_student for update;
  if st.id is null then raise exception 'No such student'; end if;
  if length(v_name) not between 2 and 120 then raise exception 'Enter the full name'; end if;
  if v_dept = '' or length(v_dept) > 80 then raise exception 'Enter the department (up to 80 characters)'; end if;
  if v_level = '' or length(v_level) > 20 then raise exception 'Enter the level (up to 20 characters)'; end if;
  if v_raw <> '' and v_email is null then raise exception 'That email address isn''t valid'; end if;
  if v_name <> st.full_name then v_changes := v_changes || ('name ' || st.full_name || ' → ' || v_name); end if;
  if v_dept <> st.department then v_changes := v_changes || ('department ' || st.department || ' → ' || v_dept); end if;
  if v_level <> st.level then v_changes := v_changes || ('level ' || st.level || ' → ' || v_level); end if;
  if v_email is distinct from st.email then v_changes := v_changes || 'email changed'::text; end if;
  if cardinality(v_changes) = 0 then return; end if;
  update public.students set full_name = v_name, department = v_dept, level = v_level, email = v_email where id = p_student;
  if st.user_id is not null then update public.profiles set full_name = v_name where id = st.user_id; end if;
  perform public.audit('Edit student', st.matric_no || ' — ' || array_to_string(v_changes, '; '));
end $$;

-- ---------------------------------------------------------------------
-- 12. Roster imports: one at a time, with the same limits everywhere
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
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;
  -- two imports naming the same new student would otherwise both pass the "already on record?" check
  perform pg_advisory_xact_lock(hashtext('scriptree.students'));
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then
      v_skip := v_skip || jsonb_build_object('matric_no', '', 'reason', 'Not a student row'); continue;
    end if;
    v_id        := upper(trim(coalesce(r ->> 'student_id', r ->> 'matric_no', '')));
    v_name      := regexp_replace(trim(coalesce(r ->> 'full_name', '')), '\s+', ' ', 'g');
    v_dept      := trim(coalesce(r ->> 'department', ''));
    v_level     := upper(trim(coalesce(r ->> 'level', '')));
    v_raw_email := trim(coalesce(r ->> 'email', ''));
    v_email     := public.clean_email(v_raw_email);
    if not public.is_student_id(v_id) then
      v_skip := v_skip || jsonb_build_object('matric_no', left(v_id, 40), 'reason', 'Invalid student ID (e.g. BU/24C/IT/10778)'); continue;
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
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Department missing or over 80 characters'); continue;
    end if;
    if v_level = '' or length(v_level) > 20 then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Level missing or over 20 characters'); continue;
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

create or replace function public.import_candidates(p_session uuid, p_rows jsonb)
returns table (added int, created int, already int, skipped jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  s public.exam_sessions; r jsonb; v_id text; v_sid uuid; v_seq int;
  v_added int := 0; v_created int := 0; v_already int := 0; v_skip jsonb[] := '{}';
  v_name text; v_dept text; v_level text; v_email text; v_raw_email text; v_other text;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status = 'closed' then raise exception 'Session is closed'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.students'));
  perform pg_advisory_xact_lock(hashtext('scriptree.reg.' || p_session));
  select coalesce(max(seq), 0) into v_seq from public.registrations where session_id = p_session;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then
      v_skip := v_skip || jsonb_build_object('matric_no', '', 'reason', 'Not a candidate row'); continue;
    end if;
    v_id := upper(trim(coalesce(r ->> 'student_id', r ->> 'matric_no', '')));
    if not public.is_student_id(v_id) then
      v_skip := v_skip || jsonb_build_object('matric_no', left(v_id, 40), 'reason', 'Invalid student ID (e.g. BU/24C/IT/10778)'); continue;
    end if;
    if nullif(trim(r ->> 'course_code'), '') is not null
       and regexp_replace(upper(trim(r ->> 'course_code')), '^([A-Z]{2,5})\s*([0-9]{3})$', '\1 \2') <> s.course_code then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Different course: ' || left(r ->> 'course_code', 20)); continue;
    end if;
    v_raw_email := trim(coalesce(r ->> 'email', ''));
    v_email := public.clean_email(v_raw_email);
    if v_raw_email <> '' and v_email is null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Invalid email: ' || left(v_raw_email, 60)); continue;
    end if;
    select id into v_sid from public.students where matric_no = v_id;
    if v_sid is null then
      v_name  := regexp_replace(trim(coalesce(r ->> 'full_name', '')), '\s+', ' ', 'g');
      v_dept  := trim(coalesce(r ->> 'department', ''));
      v_level := upper(trim(coalesce(r ->> 'level', '')));
      if length(v_name) < 2 or v_dept = '' or v_level = '' or v_email is null then
        v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Unknown student — add full_name, email, department and level to create them'); continue;
      end if;
      if length(v_name) > 120 or length(v_dept) > 80 or length(v_level) > 20 then
        v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Name, department or level is too long'); continue;
      end if;
      insert into public.students (matric_no, full_name, department, level, email)
      values (v_id, v_name, v_dept, v_level, v_email) returning id into v_sid;
      v_created := v_created + 1;
    elsif v_email is not null then
      update public.students set email = v_email where id = v_sid and email is null;
    end if;
    if exists (select 1 from public.registrations where session_id = p_session and student_id = v_sid) then
      v_already := v_already + 1; continue;
    end if;
    -- one hall per student for the same paper on the same day
    select es.venue into v_other from public.registrations rg join public.exam_sessions es on es.id = rg.session_id
     where rg.student_id = v_sid and es.id <> p_session and es.course_code = s.course_code and es.exam_date = s.exam_date limit 1;
    if v_other is not null then
      v_skip := v_skip || jsonb_build_object('matric_no', v_id, 'reason', 'Already registered for ' || s.course_code || ' that day in ' || v_other); continue;
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
-- 11/12. Hall: one close at a time, mark everyone present, no NULL marks
-- ---------------------------------------------------------------------
create or replace function public.close_session(p_session uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session); v_open int; v_unmarked int; v_status public.session_status;
begin
  -- a second device (or a double tap) closing at the same moment waits here, then sees it's already closed
  select status into v_status from public.exam_sessions where id = p_session for update;
  if v_status <> 'live' then raise exception 'Session is already closed'; end if;

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

create or replace function public.mark_attendance(p_session uuid, p_student uuid, p_present boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session); v_matric text;
begin
  if p_present is null then raise exception 'Choose present or absent'; end if;
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

-- Everyone not yet marked becomes present; the invigilator then unticks the absentees.
create or replace function public.mark_all_present(p_session uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session); v_n int;
begin
  insert into public.attendance (session_id, student_id, present, mode, marked_by)
  select r.session_id, r.student_id, true, s.attendance_mode, auth.uid()
  from public.registrations r
  where r.session_id = p_session
    and not exists (select 1 from public.attendance a where a.session_id = r.session_id and a.student_id = r.student_id)
  on conflict (session_id, student_id) do nothing;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform public.audit('Mark all present', s.course_code || ' — ' || v_n || ' unmarked candidates marked present (' || s.attendance_mode || ')');
  end if;
  return v_n;
end $$;

-- ---------------------------------------------------------------------
-- 12. resolve_discrepancy: bounded text (otherwise as 20261109040000)
-- ---------------------------------------------------------------------
create or replace function public.resolve_discrepancy(p_session uuid, p_student uuid, p_outcome text, p_action text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text; v_matric text; r record; v_explain boolean; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform public.require_role('officer');
  if length(coalesce(p_action, '')) not between 3 and 120 then raise exception 'Choose what was done'; end if;
  if length(coalesce(p_outcome, '')) not between 3 and 80 then raise exception 'Unknown discrepancy'; end if;
  if length(v_note) > 500 then raise exception 'Keep the note under 500 characters'; end if;
  select * into r from public.reconcile_session(p_session) x where x.student_id = p_student;
  if r.student_id is null then raise exception 'That candidate is not part of this session'; end if;
  v_explain := p_action in ('Escalated to department', 'Accepted — explained in note');
  if r.severity in ('crit', 'high', 'med') then
    if not v_explain then
      raise exception 'The record still shows "%". Finish the correction first, or escalate it with a note.', r.outcome;
    end if;
    if r.outcome <> p_outcome then
      raise exception 'The record now shows "%" — reopen it to review the new problem', r.outcome;
    end if;
    if length(coalesce(v_note, '')) < 10 then raise exception 'Explain why this is being closed without a fix'; end if;
  end if;
  insert into public.resolutions (session_id, student_id, outcome, action, note, resolved_by)
  values (p_session, p_student, p_outcome, p_action, v_note, auth.uid())
  on conflict (session_id, student_id) do update
    set outcome = excluded.outcome, action = excluded.action, note = excluded.note, resolved_by = excluded.resolved_by, resolved_at = now();
  select course_code into v_code from public.exam_sessions where id = p_session;
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Resolve discrepancy', v_code || ' ' || v_matric || ' — ' || p_outcome || ': ' || p_action
    || case when r.severity in ('crit', 'high', 'med') then ' (not fixed, record still: ' || r.outcome || ')' else ' (record now: ' || r.outcome || ')' end
    || coalesce(' — ' || v_note, ''));
end $$;

-- ---------------------------------------------------------------------
-- 2. ack_alert: only a current alert, titled by the alert itself
--    (p_title is still accepted so older browsers keep working; it is ignored)
-- ---------------------------------------------------------------------
create or replace function public.ack_alert(p_key text, p_title text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text; v_new int; v_title text;
begin
  perform public.require_role('officer');
  select a.title into v_title from public.current_alerts(true) a where a.alert_key = p_key limit 1;
  if v_title is null then raise exception 'That alert has changed or cleared — refresh the list'; end if;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.alert_acks (alert_key, acked_by, acked_by_name) values (p_key, auth.uid(), v_name)
  on conflict (alert_key) do nothing;
  get diagnostics v_new = row_count;
  if v_new > 0 then perform public.audit('Acknowledge alert', left(v_title, 300)); end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. Audit chain: remembered head, nightly result shown in the app, weekly anchor email
-- ---------------------------------------------------------------------
create table if not exists public.audit_chain_status (
  id            boolean primary key default true check (id),
  ok            boolean not null,
  broken_at     bigint,
  entries       bigint not null default 0,
  head_chain_no bigint,
  head_id       bigint,
  head_hash     text,
  checked_at    timestamptz not null default now()
);
alter table public.audit_chain_status enable row level security;
drop policy if exists audit_chain_status_read on public.audit_chain_status;
create policy audit_chain_status_read on public.audit_chain_status for select to authenticated
  using ((select public.app_role()) in ('admin', 'officer'));
revoke all on public.audit_chain_status from anon;
revoke insert, update, delete, truncate on public.audit_chain_status from authenticated;

-- pg_cron, nightly: re-hash everything, check the entry that was newest last night is still there,
-- remember tonight's newest entry, email the office when anything is wrong. Mondays: anchor email.
create or replace function public.nightly_audit_check() returns void
language plpgsql security definer set search_path = public as $$
declare r record; prev public.audit_chain_status; v_no bigint; v_id bigint; v_hash text; v_ok boolean; v_bad bigint; v_cut boolean := false;
begin
  select * into r from public.audit_chain_check(true);
  select * into prev from public.audit_chain_status where id;
  v_ok := r.ok; v_bad := r.broken_at;
  -- entries removed from the end leave a chain that still links; the head we saw last night must still exist
  if v_ok and prev.head_chain_no is not null
     and not exists (select 1 from public.audit_log a where a.chain_no = prev.head_chain_no and a.hash = prev.head_hash) then
    v_ok := false; v_bad := prev.head_id; v_cut := true;
  end if;
  select chain_no, id, hash into v_no, v_id, v_hash from public.audit_log where chain_no is not null order by chain_no desc limit 1;

  if not v_ok then
    perform public.enqueue_notification('audit_chain',
      case when v_cut then 'ScripTree: audit log entries have been removed' else 'ScripTree: audit log chain broken at entry #' || v_bad end,
      case when v_cut then 'Entry #' || v_bad || ' was the newest audit entry at the last nightly check and is no longer in the log. '
                        || 'Entries have been deleted from the end of the audit log. Investigate database access immediately.'
           else 'The nightly re-hash of the audit log found entry #' || v_bad || ' altered after it was written. '
             || 'Every later entry is suspect. Investigate database access immediately.' end);
  elsif extract(isodow from now()) = 1 and v_no is not null then
    perform public.enqueue_notification('audit_anchor', 'ScripTree: weekly audit log anchor',
      'Keep this email. It records the newest audit entry as of ' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC:' || E'\n\n'
      || '  • Entry #' || v_id || ' — chain position ' || v_no || E'\n'
      || '  • Hash ' || v_hash || E'\n\n'
      || 'If the audit log is ever questioned, this entry must still be in it with exactly this hash. '
      || r.entries || ' entries were re-hashed and linked correctly.');
  end if;

  -- a failed night keeps the head from the last good night, so the alarm repeats until someone deals with it
  insert into public.audit_chain_status (id, ok, broken_at, entries, head_chain_no, head_id, head_hash, checked_at)
  values (true, v_ok, v_bad, r.entries, v_no, v_id, v_hash, now())
  on conflict (id) do update set ok = excluded.ok, broken_at = excluded.broken_at, entries = excluded.entries, checked_at = excluded.checked_at,
    head_chain_no = case when excluded.ok then excluded.head_chain_no else public.audit_chain_status.head_chain_no end,
    head_id       = case when excluded.ok then excluded.head_id       else public.audit_chain_status.head_id end,
    head_hash     = case when excluded.ok then excluded.head_hash     else public.audit_chain_status.head_hash end;
end $$;

-- the app's check: new entries re-hashed now, plus whatever the last nightly full check found
create or replace function public.verify_audit_chain()
returns table (ok boolean, entries bigint, broken_at bigint)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare r record; st public.audit_chain_status;
begin
  perform public.require_role('admin', 'officer');
  select * into r from public.audit_chain_check(false);
  select * into st from public.audit_chain_status where id;
  if r.ok and st.id is not null then
    if not st.ok then
      return query select false, r.entries, st.broken_at; return;
    end if;
    if st.head_chain_no is not null
       and not exists (select 1 from public.audit_log a where a.chain_no = st.head_chain_no and a.hash = st.head_hash) then
      return query select false, r.entries, st.head_id; return;
    end if;
  end if;
  return query select r.ok, r.entries, r.broken_at;
end $$;

-- start from tonight's state
select public.nightly_audit_check();

-- ---------------------------------------------------------------------
-- 4. register_scan: say when this exact file is already filed under someone else
--    (new output column, so the function is recreated)
-- ---------------------------------------------------------------------
drop function if exists public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean);
create function public.register_scan(
  p_actor uuid, p_aal text, p_session uuid, p_student uuid,
  p_path text, p_name text, p_size bigint, p_sha256 text,
  p_method public.capture_method, p_pages int, p_rescan boolean)
returns table (file_id uuid, file_no bigint, version int, duplicate boolean, same_as text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_actor public.profiles; s public.exam_sessions; v_prior int; v_active int;
  v_script uuid; v_id uuid; v_no bigint; v_ver int; v_matric text; v_present boolean; v_same text;
begin
  select * into v_actor from public.profiles where id = p_actor;
  if v_actor.id is null or v_actor.status <> 'active' or v_actor.role not in ('invigilator', 'officer') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_actor.role = 'officer' and coalesce(p_aal, '') <> 'aal2' then
    raise exception 'Two-factor required' using errcode = '42501';
  end if;
  select * into s from public.exam_sessions where id = p_session;
  if s.id is null then raise exception 'No such session'; end if;
  if v_actor.role = 'invigilator' then
    if s.invigilator_id is distinct from p_actor then raise exception 'Not your session' using errcode = '42501'; end if;
    if s.status <> 'live' then raise exception 'Session is not live'; end if;
  end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Bad fingerprint'; end if;
  if not exists (select 1 from public.students where id = p_student) then raise exception 'No such student'; end if;

  -- who may be scanned: a present registered candidate, or anyone whose physical script was checked in
  select present into v_present from public.attendance where session_id = p_session and student_id = p_student;
  select id into v_script from public.scripts where session_id = p_session and student_id = p_student;
  if not coalesce(v_present, false) and v_script is null then
    raise exception 'That student is not marked present and has no script checked in';
  end if;

  perform pg_advisory_xact_lock(hashtext('scriptree.scan.' || p_session || p_student));
  select count(*), count(*) filter (where active) into v_prior, v_active
    from public.files where kind = 'script' and session_id = p_session and student_id = p_student;
  if coalesce(p_rescan, false) then
    update public.files set active = false where kind = 'script' and session_id = p_session and student_id = p_student and active;
  end if;
  v_ver := v_prior + 1;

  -- the very same bytes already filed for a different candidate: almost always the wrong file picked
  select st.matric_no || ' · ' || es.course_code into v_same
  from public.files f join public.students st on st.id = f.student_id join public.exam_sessions es on es.id = f.session_id
  where f.sha256 = p_sha256 and f.kind = 'script' and f.active
    and (f.student_id <> p_student or f.session_id <> p_session)
  order by f.uploaded_at desc limit 1;

  insert into public.files (kind, session_id, student_id, storage_path, original_name, size_bytes, sha256,
                            version, active, method, pages, uploaded_by, uploaded_by_name)
  values ('script', p_session, p_student, p_path, left(p_name, 200), p_size, p_sha256,
          v_ver, true, p_method, p_pages, p_actor, v_actor.full_name)
  returning id, files.file_no into v_id, v_no;

  if v_script is not null then
    insert into public.custody_events (script_id, action, location, file_id, actor_id, actor_name)
    values (v_script, 'Scanned + SHA-256 recorded', 'Scan station', v_id, p_actor, v_actor.full_name);
  end if;

  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit_as(p_actor, 'Upload scan', s.course_code || ' — ' || v_matric || ' v' || v_ver || ' · '
    || case when p_method = 'snap' then coalesce(p_pages, 0) || ' photo snaps merged' else 'direct PDF' end
    || ' · SHA-256 ' || left(p_sha256, 12) || '…'
    || case when coalesce(p_rescan, false) and v_active > 0 then ' (rescan, replaces previous)' when v_active > 0 then ' — DUPLICATE' else '' end
    || coalesce(' — SAME FILE AS ' || v_same, ''));

  return query select v_id, v_no, v_ver, (not coalesce(p_rescan, false) and v_active > 0), v_same;
end $$;

-- ---------------------------------------------------------------------
-- 10. Withdraw a verification; students open their own documents
-- ---------------------------------------------------------------------
create or replace function public.revoke_document_verification(p_doc uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare d public.student_documents; v_matric text; v_name text; v_reason text := trim(coalesce(p_reason, ''));
begin
  perform public.require_role('officer');
  if length(v_reason) not between 5 and 180 then raise exception 'Say why the verification is being withdrawn'; end if;
  select * into d from public.student_documents where id = p_doc for update;
  if d.id is null then raise exception 'No such document'; end if;
  if d.status <> 'verified' then raise exception 'Only a verified document can have its verification withdrawn'; end if;
  -- back to "rejected with a reason": the student sees why and can upload again; the old file stays archived
  update public.student_documents
     set status = 'rejected', verified_by = auth.uid(), verified_at = now(), reason = left('Verification withdrawn: ' || v_reason, 200)
   where id = p_doc;
  select matric_no into v_matric from public.students where id = d.student_id;
  select name into v_name from public.doc_types where id = d.doc_type;
  perform public.audit('Withdraw document verification', v_matric || ' — ' || v_name || ' (' || v_reason || ')');
end $$;

drop function if exists public.my_documents();
create function public.my_documents()
returns table (
  doc_id uuid, doc_type text, status public.doc_status, reason text, uploaded_at timestamptz,
  file_no bigint, sha256 text, size_bytes bigint, original_name text,
  verified_by_name text, verified_at timestamptz, storage_path text
)
language sql stable security definer set search_path = public as $$
  select distinct on (d.doc_type)
    d.id, d.doc_type, d.status, d.reason, d.created_at, f.file_no, f.sha256, f.size_bytes, f.original_name,
    p.full_name, d.verified_at, f.storage_path
  from public.student_documents d
  join public.files f on f.id = d.file_id
  left join public.profiles p on p.id = d.verified_by
  where d.student_id = public.my_student_id()
  order by d.doc_type, d.created_at desc
$$;

-- a student may read (so: get a short-lived link to) files archived under their own account
drop policy if exists docs_read_own on storage.objects;
create policy docs_read_own on storage.objects for select to authenticated
using (bucket_id = 'documents'
       and (storage.foldername(name))[1] = 'archive'
       and (storage.foldername(name))[2] = (select auth.uid())::text
       and (select public.app_role()) = 'student');

-- ---------------------------------------------------------------------
-- 5. Sign-in limiter: 5 per ID from one address, 50 per ID from all addresses, 30 per address
--    (student sign-in addresses are no longer derivable from the ID, so this function is the only
--    way to try a password; 20 across all addresses let anyone lock a student out too cheaply)
-- ---------------------------------------------------------------------
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
  if n_pair >= 5 or n_id >= 50 or n_ip >= 30 then return null; end if;
  insert into public.login_attempts (identifier, ip, ok) values (p_identifier, p_ip, null) returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 6. Invigilators: candidates' student records while the session is open and for 30 days after
-- ---------------------------------------------------------------------
alter policy students_staff on public.students using (
  (select public.app_role()) in ('admin', 'officer')
  or ((select public.app_role()) = 'invigilator' and (
    exists (select 1 from public.registrations r join public.exam_sessions es on es.id = r.session_id
            where r.student_id = students.id and es.invigilator_id = (select auth.uid())
              and (es.status <> 'closed' or es.closed_at > now() - interval '30 days'))
    or exists (select 1 from public.scripts sc join public.exam_sessions es on es.id = sc.session_id
               where sc.student_id = students.id and es.invigilator_id = (select auth.uid())
                 and (es.status <> 'closed' or es.closed_at > now() - interval '30 days')))));

-- ---------------------------------------------------------------------
-- 13. Alert sender only runs when there is somewhere to send to
-- ---------------------------------------------------------------------
create or replace function public.schedule_jobs() returns void
language plpgsql security definer set search_path = public as $$
declare t time;
begin
  select nightly_check_at into t from public.settings;
  perform cron.schedule('scriptree-nightly-check',
    extract(minute from t)::int || ' ' || extract(hour from t)::int || ' * * *',
    $cmd$select public.call_edge_function('integrity-check')$cmd$);
  perform cron.schedule('scriptree-integrity-continue', '*/2 * * * *',
    $cmd$select public.call_edge_function('integrity-check', '{"scheduled": true, "continue": true}'::jsonb) where exists (select 1 from public.integrity_runs where finished_at is null)$cmd$);
  perform cron.schedule('scriptree-send-alerts', '*/5 * * * *',
    $cmd$select public.call_edge_function('send-alerts') where exists (select 1 from public.notifications where sent_at is null and attempts < 5) and exists (select 1 from public.settings where alert_email is not null)$cmd$);
  perform cron.schedule('scriptree-recon-refresh', '* * * * *', $cmd$select public.refresh_dirty_recon()$cmd$);
  perform cron.schedule('scriptree-audit-chain', '47 3 * * *', $cmd$select public.nightly_audit_check()$cmd$);
  perform cron.schedule('scriptree-prune-integrity', '27 4 * * *',
    $cmd$delete from public.integrity_checks where ok and checked_at < now() - interval '90 days'$cmd$);
  -- alerts nobody could receive are dropped after 30 days instead of flooding the inbox the day an address is set
  perform cron.schedule('scriptree-prune-notifications', '37 4 * * *',
    $cmd$delete from public.notifications where (sent_at is not null and sent_at < now() - interval '180 days') or (sent_at is null and created_at < now() - interval '30 days')$cmd$);
end $$;
select public.schedule_jobs();

-- ---------------------------------------------------------------------
-- 7. Grants. Nothing is callable before sign-in; signed-in users keep exactly what they had.
--    PostgreSQL grants EXECUTE to PUBLIC on every new function, so this block closes it for every
--    function that exists now. REPEAT THE REVOKE AT THE END OF ANY LATER MIGRATION THAT ADDS FUNCTIONS.
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text sig,
           has_function_privilege('authenticated', p.oid, 'execute') auth,
           has_function_privilege('service_role', p.oid, 'execute') svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.auth then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if f.svc then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;

-- service-role / internal entry points created or recreated above
revoke execute on function public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean) from authenticated;
grant  execute on function public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean) to service_role;
revoke execute on function public.check_session_fields(text, text, date, time, text, uuid) from authenticated;
revoke execute on function public.nightly_audit_check(), public.schedule_jobs(), public.login_attempt_begin(text, text) from authenticated;
grant  execute on function public.login_attempt_begin(text, text) to service_role;
-- browser-callable functions added above
grant execute on function public.update_exam_session(uuid, text, date, time, text, uuid), public.delete_exam_session(uuid, text),
  public.reopen_session(uuid, text), public.update_student(uuid, text, text, text, text), public.mark_all_present(uuid),
  public.revoke_document_verification(uuid, text), public.my_documents() to authenticated;

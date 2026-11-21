-- QR labels and scan checks
--
-- Flow:
--   1. The exams office registers candidates and assigns an invigilator.
--   2. Before the exam the invigilator generates and prints a QR label for every registered candidate.
--      The QR holds the script ID: student ID + course code, e.g. BU/24C/IT/10778-CSC409 (-2, -3 … for a resit).
--      The label is pasted on the candidate's booklet.
--   3. After the exam the invigilator scans each booklet's QR with the camera: that is the check-in
--      (submission confirmed, custody starts).
--   4. At the scan station the QR on the scanned page must match the student the file is being saved for.
--
-- Fixes from the scanning audit (2026-11-21):
--   a. register_scan takes the QR read from the file (or from the booklet by camera, or "checked by eye") and
--      refuses a file whose QR belongs to someone else.
--   b. register-file refuses a file whose browser fingerprint differs from the server's (edge function).
--   c. The server's upload hash counts as the first passing integrity check.
--   d. A scan saved before the paper was checked in is added to the custody timeline at check-in.
--   e. Custody events follow a fixed order.

-- ---------------------------------------------------------------------
-- 1. The label code lives on the registration (created when labels are generated)
-- ---------------------------------------------------------------------
alter table public.registrations add column if not exists script_code text unique;
update public.registrations r set script_code = sc.script_code
  from public.scripts sc where sc.session_id = r.session_id and sc.student_id = r.student_id and r.script_code is null;

alter table public.files add column if not exists qr_check text check (qr_check in ('file', 'camera', 'manual'));

-- a code is taken if any other sitting holds it, as a script or as a printed label
create or replace function public.make_script_code(p_session uuid, p_student uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_base text; v_code text; n int := 1;
begin
  select st.matric_no || '-' || replace(es.course_code, ' ', '') into v_base
  from public.students st, public.exam_sessions es
  where st.id = p_student and es.id = p_session;
  if v_base is null then raise exception 'Unknown student or session'; end if;
  v_code := v_base;
  while exists (select 1 from public.scripts sc where sc.script_code = v_code
                and not (sc.session_id = p_session and sc.student_id = p_student))
     or exists (select 1 from public.registrations r where r.script_code = v_code
                and not (r.session_id = p_session and r.student_id = p_student)) loop
    n := n + 1;
    v_code := v_base || '-' || n;
  end loop;
  return v_code;
end $$;

-- the code for this candidate in this sitting: the checked-in script's, else the label's, else a new one
create or replace function public.script_code_for(p_session uuid, p_student uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select script_code from public.scripts where session_id = p_session and student_id = p_student),
    (select script_code from public.registrations where session_id = p_session and student_id = p_student),
    public.make_script_code(p_session, p_student))
$$;

-- ---------------------------------------------------------------------
-- 2. Labels: generate (once per candidate) and log each print
-- ---------------------------------------------------------------------
create or replace function public.script_labels(p_session uuid)
returns table (student_id uuid, matric_no text, full_name text, script_code text, checked_in boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare s public.exam_sessions; r record; v_new int := 0;
begin
  perform public.require_role('invigilator', 'officer');
  select * into s from public.exam_sessions where id = p_session;
  if s.id is null then raise exception 'No such session'; end if;
  if public.app_role() = 'invigilator' and s.invigilator_id is distinct from auth.uid() then
    raise exception 'Not your session' using errcode = '42501';
  end if;
  if s.status = 'closed' then raise exception 'Session is closed — labels can no longer be printed'; end if;

  for r in select rg.student_id from public.registrations rg
           where rg.session_id = p_session and rg.script_code is null order by rg.seq loop
    perform pg_advisory_xact_lock(hashtext('scriptree.script.' || r.student_id));
    update public.registrations set script_code = public.script_code_for(p_session, r.student_id)
     where session_id = p_session and student_id = r.student_id and script_code is null;
    v_new := v_new + 1;
  end loop;
  if v_new > 0 then
    perform public.audit('Generate QR labels', s.course_code || ' — ' || v_new || ' label code' || case when v_new = 1 then '' else 's' end || ' created');
  end if;

  return query
  select rg.student_id, st.matric_no, st.full_name, rg.script_code,
         exists (select 1 from public.scripts sc where sc.session_id = p_session and sc.student_id = rg.student_id)
  from public.registrations rg join public.students st on st.id = rg.student_id
  where rg.session_id = p_session
  order by st.matric_no;
end $$;

-- every print (or reprint) is on the record: a spare label is a way to swap a booklet
create or replace function public.record_label_print(p_session uuid, p_students uuid[]) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions; v_n int; v_total int; v_list text;
begin
  perform public.require_role('invigilator', 'officer');
  select * into s from public.exam_sessions where id = p_session;
  if s.id is null then raise exception 'No such session'; end if;
  if public.app_role() = 'invigilator' and s.invigilator_id is distinct from auth.uid() then
    raise exception 'Not your session' using errcode = '42501';
  end if;
  if cardinality(coalesce(p_students, '{}')) = 0 then raise exception 'Choose at least one label'; end if;
  select count(*), string_agg(rg.script_code, ', ' order by rg.script_code) into v_n, v_list
    from public.registrations rg where rg.session_id = p_session and rg.student_id = any(p_students) and rg.script_code is not null;
  select count(*) into v_total from public.registrations where session_id = p_session;
  perform public.audit('Print QR labels', s.course_code || ' — ' || v_n || ' of ' || v_total || ' labels'
    || case when v_n < v_total then ': ' || left(v_list, 400) else '' end);
end $$;

-- ---------------------------------------------------------------------
-- 3. Lookup: a printed label code resolves too
-- ---------------------------------------------------------------------
create or replace function public.resolve_identifier(p_q text, p_session uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.students where matric_no = upper(trim(p_q)) limit 1),
    (select student_id from public.scripts where script_code = upper(trim(p_q)) and (p_session is null or session_id = p_session) limit 1),
    (select student_id from public.registrations where script_code = upper(trim(p_q)) and (p_session is null or session_id = p_session) limit 1),
    (select st.id from public.students st, public.exam_sessions es
      where p_session is not null and es.id = p_session
        and st.matric_no = split_part(upper(trim(p_q)), '-', 1)
        and upper(trim(p_q)) = st.matric_no || '-' || replace(es.course_code, ' ', '')))
  where public.is_staff()
$$;

-- a label from another sitting, for a clear message instead of "no match"
create or replace function public.label_elsewhere(p_q text, p_session uuid) returns text
language sql stable security definer set search_path = public as $$
  select es.course_code || ' on ' || to_char(es.exam_date, 'DD Mon YYYY')
  from public.exam_sessions es
  where es.id <> p_session and es.id in (
    select session_id from public.registrations where script_code = upper(trim(p_q))
    union select session_id from public.scripts where script_code = upper(trim(p_q)))
  limit 1
$$;

-- scans saved before the paper was checked in join its custody timeline, at the time they were saved
create or replace function public.link_earlier_scans(p_script uuid, p_session uuid, p_student uuid) returns void
language sql security definer set search_path = public as $$
  insert into public.custody_events (script_id, action, location, note, file_id, actor_id, actor_name, at)
  select p_script, 'Scanned + SHA-256 recorded', 'Scan station', 'Scanned before the paper was checked in',
         f.id, f.uploaded_by, f.uploaded_by_name, f.uploaded_at
  from public.files f
  where f.kind = 'script' and f.session_id = p_session and f.student_id = p_student
    and not exists (select 1 from public.custody_events ce where ce.file_id = f.id)
$$;

-- ---------------------------------------------------------------------
-- 4. Check-in (the QR scan after the exam, or a typed ID)
-- ---------------------------------------------------------------------
create or replace function public.check_in_script(p_session uuid, p_identifier text)
returns table (script_code text, registered boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare s public.exam_sessions := public.assert_hall(p_session);
        v_student uuid; v_reg boolean; v_code text; v_script uuid; v_name text; v_matric text; v_other text;
begin
  v_student := public.resolve_identifier(p_identifier, p_session);
  if v_student is null then
    v_other := public.label_elsewhere(p_identifier, p_session);
    if v_other is not null then raise exception 'This label is for % — not this exam', v_other; end if;
    raise exception 'No student or script matches "%"', p_identifier;
  end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.script.' || v_student));
  if exists (select 1 from public.scripts where session_id = p_session and student_id = v_student) then
    raise exception 'Already checked in — possible duplicate booklet';
  end if;
  v_reg := exists (select 1 from public.registrations where session_id = p_session and student_id = v_student);
  v_code := public.script_code_for(p_session, v_student);
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.scripts (script_code, session_id, student_id, status, location)
  values (v_code, p_session, v_student, 'submitted', 'Exam hall') returning id into v_script;
  insert into public.custody_events (script_id, action, location, actor_id, actor_name)
  values (v_script, 'Submitted to invigilator', s.venue, auth.uid(), v_name);
  perform public.link_earlier_scans(v_script, p_session, v_student);
  if s.attendance_mode = 'submission' and v_reg then
    insert into public.attendance (session_id, student_id, present, mode, marked_by)
    values (p_session, v_student, true, 'submission', auth.uid())
    on conflict (session_id, student_id) do update set present = true, mode = 'submission', marked_by = auth.uid(), marked_at = now();
  end if;
  select matric_no into v_matric from public.students where id = v_student;
  perform public.audit('Check in script', s.course_code || ' — ' || v_matric || ' (' || v_code || ')'
    || case when upper(trim(p_identifier)) = v_code then ' · by script ID (QR)' else ' · by student ID' end
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
  v_code := public.script_code_for(p_session, p_student);
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.scripts (script_code, session_id, student_id, status, location)
  values (v_code, p_session, p_student, 'submitted', v_loc) returning id into v_script;
  insert into public.custody_events (script_id, action, location, note, actor_id, actor_name)
  values (v_script, 'Located and checked in by exams office', v_loc, trim(p_note), auth.uid(), v_name);
  perform public.link_earlier_scans(v_script, p_session, p_student);
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Late script check-in', s.course_code || ' — ' || v_matric || ' (' || v_code || ') at ' || v_loc || ' (' || trim(p_note) || ')');
  return v_code;
end $$;

-- existing scans that never made it onto a timeline
do $$
declare r record;
begin
  for r in select id, session_id, student_id from public.scripts loop
    perform public.link_earlier_scans(r.id, r.session_id, r.student_id);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. Custody events in order
-- ---------------------------------------------------------------------
create or replace function public.custody_next(p_status public.script_status) returns text[]
language sql immutable set search_path = public as $$
  select case p_status
    when 'submitted' then array['Sealed in batch', 'Received at exams office']
    when 'bundled'   then array['Received at exams office']
    when 'received'  then array['Stored in records room', 'Retrieved for marking', 'Released for result verification']
    when 'stored'    then array['Retrieved for marking', 'Released for result verification']
    when 'out'       then array['Returned to records room']
  end
$$;

create or replace function public.add_custody_event(p_script uuid, p_action text, p_location text)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text; v_name text; v_cur public.script_status; v_status public.script_status;
        v_loc text := coalesce(nullif(left(trim(p_location), 120), ''), 'Exams office');
begin
  perform public.require_role('officer');
  select status into v_cur from public.scripts where id = p_script for update;
  if v_cur is null then raise exception 'No such script'; end if;
  if not coalesce(p_action = any(public.custody_next(v_cur)), false) then
    raise exception 'A % script can only be: %', v_cur, array_to_string(public.custody_next(v_cur), ', ');
  end if;
  v_status := case
    when p_action like 'Sealed%' then 'bundled'
    when p_action like 'Received%' then 'received'
    when p_action like 'Stored%' or p_action like 'Returned%' then 'stored'
    else 'out' end;
  update public.scripts set status = v_status, location = v_loc where id = p_script returning script_code into v_code;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.custody_events (script_id, action, location, actor_id, actor_name)
  values (p_script, p_action, v_loc, auth.uid(), v_name);
  perform public.audit('Custody event', v_code || ' — ' || p_action || ' (' || v_loc || ')');
end $$;

-- ---------------------------------------------------------------------
-- 6. register_scan: the QR must belong to this candidate; the upload hash is the first check
-- ---------------------------------------------------------------------
drop function if exists public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean);
create function public.register_scan(
  p_actor uuid, p_aal text, p_session uuid, p_student uuid,
  p_path text, p_name text, p_size bigint, p_sha256 text,
  p_method public.capture_method, p_pages int, p_rescan boolean,
  p_qr text, p_qr_source text)
returns table (file_id uuid, file_no bigint, version int, duplicate boolean, same_as text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_actor public.profiles; s public.exam_sessions; v_prior int; v_active int;
  v_script uuid; v_id uuid; v_no bigint; v_ver int; v_matric text; v_present boolean; v_same text;
  v_expect text; v_qr text := nullif(upper(trim(coalesce(p_qr, ''))), ''); v_owner text;
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
  select matric_no into v_matric from public.students where id = p_student;
  if v_matric is null then raise exception 'No such student'; end if;

  -- who may be scanned: a present registered candidate, or anyone whose physical script was checked in
  select present into v_present from public.attendance where session_id = p_session and student_id = p_student;
  select id into v_script from public.scripts where session_id = p_session and student_id = p_student;
  if not coalesce(v_present, false) and v_script is null then
    raise exception 'That student is not marked present and has no script checked in';
  end if;

  -- the QR on the booklet decides whose script this is
  if coalesce(p_qr_source, '') not in ('file', 'camera', 'manual') then
    raise exception 'Check the QR on the script first (refresh the page if this keeps happening)';
  end if;
  if p_qr_source in ('file', 'camera') and v_qr is null then raise exception 'No QR code given'; end if;
  v_expect := public.script_code_for(p_session, p_student);
  if v_qr is not null and v_qr <> v_expect then
    select st.matric_no || ' · ' || st.full_name into v_owner
      from public.students st where st.id = public.resolve_identifier_any(v_qr);
    raise exception 'The QR on this script is % (%), not % — save it for the right student',
      v_qr, coalesce(v_owner, 'unknown label'), v_expect;
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

  -- the server hashed these exact bytes a moment ago: that is the first passing integrity check
  insert into public.files (kind, session_id, student_id, storage_path, original_name, size_bytes, sha256,
                            version, active, method, pages, uploaded_by, uploaded_by_name,
                            qr_check, last_check_ok, last_checked_at)
  values ('script', p_session, p_student, p_path, left(p_name, 200), p_size, p_sha256,
          v_ver, true, p_method, p_pages, p_actor, v_actor.full_name,
          p_qr_source, true, now())
  returning id, files.file_no into v_id, v_no;

  if v_script is not null then
    insert into public.custody_events (script_id, action, location, file_id, actor_id, actor_name)
    values (v_script, 'Scanned + SHA-256 recorded', 'Scan station', v_id, p_actor, v_actor.full_name);
  end if;

  perform public.audit_as(p_actor, 'Upload scan', s.course_code || ' — ' || v_matric || ' v' || v_ver || ' · '
    || case when p_method = 'snap' then coalesce(p_pages, 0) || ' photo snaps merged' else 'direct PDF' end
    || ' · SHA-256 ' || left(p_sha256, 12) || '…'
    || case p_qr_source when 'file' then ' · QR on page matched' when 'camera' then ' · booklet QR matched by camera'
                        else ' · QR not readable, checked by eye' end
    || case when coalesce(p_rescan, false) and v_active > 0 then ' (rescan, replaces previous)' when v_active > 0 then ' — DUPLICATE' else '' end
    || coalesce(' — SAME FILE AS ' || v_same, ''));

  return query select v_id, v_no, v_ver, (not coalesce(p_rescan, false) and v_active > 0), v_same;
end $$;

-- resolve_identifier needs a staff JWT; register_scan runs as the service role
create or replace function public.resolve_identifier_any(p_q text) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select student_id from public.scripts where script_code = upper(trim(p_q)) limit 1),
    (select student_id from public.registrations where script_code = upper(trim(p_q)) limit 1),
    (select id from public.students where matric_no = split_part(upper(trim(p_q)), '-', 1) limit 1))
$$;

-- ---------------------------------------------------------------------
-- 7. Grants (see 20261113000000 §7: repeat the revoke after adding functions)
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

-- internal helpers: never callable from the browser
revoke execute on function public.make_script_code(uuid, uuid), public.script_code_for(uuid, uuid),
  public.label_elsewhere(text, uuid), public.link_earlier_scans(uuid, uuid, uuid), public.resolve_identifier_any(text),
  public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean, text, text)
  from authenticated;
grant execute on function public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean, text, text),
  public.resolve_identifier_any(text), public.script_code_for(uuid, uuid) to service_role;
-- browser-callable (each checks the caller's role itself)
grant execute on function public.script_labels(uuid), public.record_label_print(uuid, uuid[]),
  public.custody_next(public.script_status), public.check_in_script(uuid, text), public.add_custody_event(uuid, text, text),
  public.resolve_identifier(text, uuid), public.fix_check_in_script(uuid, uuid, text, text) to authenticated;

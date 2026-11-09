-- Resolving a discrepancy now means fixing the record, not just writing a note about it.
--
-- Before: resolve_discrepancy() stored "Attendance corrected" / "Rescanned" / "Script located" and the
-- row was hidden, even though attendance, scripts and files were unchanged (the hall functions only work
-- while a session is live, so after close there was no way to correct anything).
--
-- Now:
--   * Officer correction functions that work on live AND closed sessions, each audited with a reason:
--       fix_attendance, fix_check_in_script, fix_register_candidate, withdraw_scan.
--     A missing or failed scan is fixed by uploading through register-file (register_scan already
--     accepts officers with 2FA on closed sessions; rescan=true retires the bad version).
--   * resolve_discrepancy() re-checks the record. Actions that claim a fix are refused until the record
--     really is clean. A record that can't be fixed can only be closed with an explanation
--     ("Escalated to department" / "Accepted — explained in note"), never silently.
--   * A resolution only counts for the outcome it was recorded against. If the record later breaks in a
--     different way, it shows as open again.

-- ---------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------
create or replace function public.assert_fix(p_session uuid, p_note text) returns public.exam_sessions
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status = 'scheduled' then raise exception 'The session has not started — use the exam hall once it opens'; end if;
  if length(trim(coalesce(p_note, ''))) < 5 then raise exception 'Say why the record is being corrected'; end if;
  return s;
end $$;
revoke all on function public.assert_fix(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- reconcile_session: same rules, plus "Attendance not marked" on closed sessions;
-- "resolved" must match the current outcome
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
        -- after close every registered candidate has a mark, except someone registered late by a correction
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
         coalesce((select sc.script_code from public.scripts sc where sc.session_id = p_session and sc.student_id = j.student_id),
                  (select r.script_code from public.registrations r where r.session_id = p_session and r.student_id = j.student_id))
  from judged j join public.students st on st.id = j.student_id
  order by st.matric_no;
end $$;

-- ---------------------------------------------------------------------
-- Correction: attendance
-- ---------------------------------------------------------------------
create or replace function public.fix_attendance(p_session uuid, p_student uuid, p_present boolean, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_fix(p_session, p_note); v_matric text; v_was boolean;
begin
  if not exists (select 1 from public.registrations where session_id = p_session and student_id = p_student) then
    raise exception 'Register the candidate for this session first';
  end if;
  select present into v_was from public.attendance where session_id = p_session and student_id = p_student;
  if v_was is not distinct from p_present then
    raise exception 'Attendance is already recorded as %', case when p_present then 'present' else 'absent' end;
  end if;
  insert into public.attendance (session_id, student_id, present, mode, marked_by)
  values (p_session, p_student, p_present, s.attendance_mode, auth.uid())
  on conflict (session_id, student_id) do update
    set present = excluded.present, marked_by = excluded.marked_by, marked_at = now();
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Correct attendance', s.course_code || ' — ' || v_matric || ' '
    || case when v_was then 'present' when not v_was then 'absent' else 'unmarked' end || ' → '
    || case when p_present then 'present' else 'absent' end || ' (' || trim(p_note) || ')');
end $$;

-- ---------------------------------------------------------------------
-- Correction: a physical script that was found after the hall (late check-in)
-- ---------------------------------------------------------------------
create or replace function public.fix_check_in_script(p_session uuid, p_student uuid, p_location text, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_fix(p_session, p_note);
        v_reg public.registrations; v_code text; v_script uuid; v_name text; v_matric text; v_loc text := trim(coalesce(p_location, ''));
begin
  if length(v_loc) < 2 or length(v_loc) > 80 then raise exception 'Say where the script is now'; end if;
  if exists (select 1 from public.scripts where session_id = p_session and student_id = p_student) then
    raise exception 'A script is already checked in for this candidate';
  end if;
  select * into v_reg from public.registrations where session_id = p_session and student_id = p_student;
  if v_reg.session_id is null then raise exception 'Register the candidate for this session first'; end if;
  v_code := v_reg.script_code;
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.scripts (script_code, session_id, student_id, status, location)
  values (v_code, p_session, p_student, 'submitted', v_loc) returning id into v_script;
  insert into public.custody_events (script_id, action, location, note, actor_id, actor_name)
  values (v_script, 'Located and checked in by exams office', v_loc, trim(p_note), auth.uid(), v_name);
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Late script check-in', s.course_code || ' — ' || v_matric || ' (' || v_code || ') at ' || v_loc || ' (' || trim(p_note) || ')');
  return v_code;
end $$;

-- ---------------------------------------------------------------------
-- Correction: register a candidate who sat the paper but wasn't on the list
-- Their 9xx script (if any) is renumbered to the new registration's code.
-- ---------------------------------------------------------------------
create or replace function public.fix_register_candidate(p_session uuid, p_student uuid, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_fix(p_session, p_note); v_seq int; v_code text; v_matric text;
begin
  if exists (select 1 from public.registrations where session_id = p_session and student_id = p_student) then
    raise exception 'Already registered';
  end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.reg.' || p_session));
  select coalesce(max(seq), 0) + 1 into v_seq from public.registrations where session_id = p_session;
  v_code := public.make_script_code(p_session, v_seq);
  insert into public.registrations (session_id, student_id, seq, script_code) values (p_session, p_student, v_seq, v_code);
  update public.scripts set script_code = v_code where session_id = p_session and student_id = p_student;
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Late registration', s.course_code || ' — ' || v_matric || ' registered as ' || v_code || ' (' || trim(p_note) || ')');
  return v_code;
end $$;

-- ---------------------------------------------------------------------
-- Correction: withdraw an extra scan. The file is kept (inactive) — never deleted.
-- ---------------------------------------------------------------------
create or replace function public.withdraw_scan(p_file uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare f public.files; s public.exam_sessions; v_left int; v_script uuid; v_name text; v_matric text;
begin
  select * into f from public.files where id = p_file and kind = 'script';
  if f.id is null then raise exception 'No such scan'; end if;
  s := public.assert_fix(f.session_id, p_note);
  if not f.active then raise exception 'That scan is already withdrawn'; end if;
  perform pg_advisory_xact_lock(hashtext('scriptree.scan.' || f.session_id || f.student_id));
  select count(*) into v_left from public.files
    where kind = 'script' and session_id = f.session_id and student_id = f.student_id and active and id <> f.id;
  if v_left = 0 then raise exception 'This is the only scan — upload a replacement instead of withdrawing it'; end if;
  update public.files set active = false where id = f.id;
  select id into v_script from public.scripts where session_id = f.session_id and student_id = f.student_id;
  select full_name into v_name from public.profiles where id = auth.uid();
  if v_script is not null then
    insert into public.custody_events (script_id, action, location, note, file_id, actor_id, actor_name)
    values (v_script, 'Duplicate scan withdrawn', 'Exams office', trim(p_note), f.id, auth.uid(), v_name);
  end if;
  select matric_no into v_matric from public.students where id = f.student_id;
  perform public.audit('Withdraw scan', s.course_code || ' — ' || v_matric || ' F' || lpad(f.file_no::text, 4, '0')
    || ' v' || f.version || ' (' || trim(p_note) || ')');
end $$;

-- ---------------------------------------------------------------------
-- resolve_discrepancy: verify before closing
-- ---------------------------------------------------------------------
create or replace function public.resolve_discrepancy(p_session uuid, p_student uuid, p_outcome text, p_action text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare v_code text; v_matric text; r record; v_explain boolean;
begin
  perform public.require_role('officer');
  if length(coalesce(p_action, '')) < 3 then raise exception 'Choose what was done'; end if;
  select * into r from public.reconcile_session(p_session) x where x.student_id = p_student;
  if r.student_id is null then raise exception 'That candidate is not part of this session'; end if;

  v_explain := p_action in ('Escalated to department', 'Accepted — explained in note');
  if r.severity in ('crit', 'high', 'med') then
    -- still broken: only an explained exception may close it, and only for the problem it actually has
    if not v_explain then
      raise exception 'The record still shows "%". Finish the correction first, or escalate it with a note.', r.outcome;
    end if;
    if r.outcome <> p_outcome then
      raise exception 'The record now shows "%" — reopen it to review the new problem', r.outcome;
    end if;
    if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Explain why this is being closed without a fix'; end if;
  end if;

  insert into public.resolutions (session_id, student_id, outcome, action, note, resolved_by)
  values (p_session, p_student, p_outcome, p_action, nullif(trim(p_note), ''), auth.uid())
  on conflict (session_id, student_id) do update
    set outcome = excluded.outcome, action = excluded.action, note = excluded.note, resolved_by = excluded.resolved_by, resolved_at = now();
  select course_code into v_code from public.exam_sessions where id = p_session;
  select matric_no into v_matric from public.students where id = p_student;
  perform public.audit('Resolve discrepancy', v_code || ' ' || v_matric || ' — ' || p_outcome || ': ' || p_action
    || case when r.severity in ('crit', 'high', 'med') then ' (not fixed, record still: ' || r.outcome || ')' else ' (record now: ' || r.outcome || ')' end
    || coalesce(' — ' || nullif(trim(p_note), ''), ''));
end $$;

-- the scan list a resolver needs (officers already read files via RLS; this adds integrity state)
create or replace function public.candidate_scans(p_session uuid, p_student uuid)
returns table (file_id uuid, file_no bigint, version int, original_name text, uploaded_at timestamptz, uploaded_by_name text, ok boolean)
language sql stable security definer set search_path = public as $$
  select f.id, f.file_no, f.version, f.original_name, f.uploaded_at, f.uploaded_by_name, fi.ok
  from public.files f left join public.file_integrity fi on fi.file_id = f.id
  where f.kind = 'script' and f.session_id = p_session and f.student_id = p_student and f.active
    and public.app_role() in ('admin', 'officer')
  order by f.version
$$;

grant execute on function public.fix_attendance(uuid, uuid, boolean, text)        to authenticated;
grant execute on function public.fix_check_in_script(uuid, uuid, text, text)      to authenticated;
grant execute on function public.fix_register_candidate(uuid, uuid, text)         to authenticated;
grant execute on function public.withdraw_scan(uuid, text)                        to authenticated;
grant execute on function public.candidate_scans(uuid, uuid)                      to authenticated;

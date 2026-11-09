-- =====================================================================
-- Phase 2 — Exam hall
--   * register_scan(): called ONLY by the register-file edge function (service
--     role) after it has hashed the uploaded bytes itself. The browser can
--     never supply a fingerprint.
--   * close_session(): unmarked candidates are recorded absent on close, so no
--     record stays "awaiting attendance" forever.
-- =====================================================================

-- Audit on behalf of a named user (for service-role callers, where auth.uid() is null)
create or replace function public.audit_as(p_actor uuid, p_action text, p_detail text) returns void
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select coalesce(
    (select full_name from public.profiles where id = p_actor),
    (select full_name from public.students where user_id = p_actor),
    'System') into v_name;
  insert into public.audit_log (actor_id, actor_name, action, detail)
  values (p_actor, v_name, p_action, coalesce(p_detail, ''));
end $$;
revoke execute on function public.audit_as(uuid, text, text) from public, anon, authenticated;

create or replace function public.register_scan(
  p_actor uuid, p_aal text, p_session uuid, p_student uuid,
  p_path text, p_name text, p_size bigint, p_sha256 text,
  p_method public.capture_method, p_pages int, p_rescan boolean)
returns table (file_id uuid, file_no bigint, version int, duplicate boolean)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_actor public.profiles; s public.exam_sessions; v_prior int; v_active int;
  v_script uuid; v_id uuid; v_no bigint; v_ver int; v_matric text; v_present boolean;
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

  -- who may be scanned: a present registered candidate, or anyone whose physical script was checked in
  select present into v_present from public.attendance where session_id = p_session and student_id = p_student;
  select id into v_script from public.scripts where session_id = p_session and student_id = p_student;
  if not coalesce(v_present, false) and v_script is null then
    raise exception 'That student is not marked present and has no script checked in';
  end if;

  perform pg_advisory_xact_lock(hashtext('scriptree.scan.' || p_session || p_student));
  select count(*), count(*) filter (where active) into v_prior, v_active
    from public.files where kind = 'script' and session_id = p_session and student_id = p_student;
  if p_rescan then
    update public.files set active = false where kind = 'script' and session_id = p_session and student_id = p_student and active;
  end if;
  v_ver := v_prior + 1;

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
    || case when p_rescan and v_active > 0 then ' (rescan, replaces previous)' when v_active > 0 then ' — DUPLICATE' else '' end);

  return query select v_id, v_no, v_ver, (not p_rescan and v_active > 0);
end $$;
revoke execute on function public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean)
  from public, anon, authenticated;
grant execute on function public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean)
  to service_role;

-- Close: unmarked → absent, then count discrepancies
create or replace function public.close_session(p_session uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions := public.assert_hall(p_session); v_open int; v_unmarked int;
begin
  insert into public.attendance (session_id, student_id, present, mode, marked_by)
  select r.session_id, r.student_id, false, s.attendance_mode, auth.uid()
  from public.registrations r
  where r.session_id = p_session
    and not exists (select 1 from public.attendance a where a.session_id = r.session_id and a.student_id = r.student_id);
  get diagnostics v_unmarked = row_count;

  update public.exam_sessions set status = 'closed', closed_at = now(), last_reconciled_at = now() where id = p_session;
  select count(*) into v_open from public.reconcile_session(p_session) r
    where r.severity in ('crit', 'high', 'med') and not r.resolved;
  perform public.audit('Close session', s.course_code || ' — ' || v_open || ' discrepancies raised'
    || case when v_unmarked > 0 then ', ' || v_unmarked || ' unmarked recorded absent' else '' end);
  return v_open;
end $$;

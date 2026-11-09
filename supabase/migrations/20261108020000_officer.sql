-- =====================================================================
-- Phase 3 — Exams officer
--   import_candidates()     CSV import: register known students, create new ones when
--                           the row carries full details, flag the rest
--   session_summaries()     four counts + completeness per session (dashboard, list)
--   current_alerts()        every exception, computed from live data (one source of truth)
--   dashboard_stats()       custody, integrity and document numbers
--   record_integrity_run()  service-role only; called by the integrity-check edge function
-- =====================================================================

create or replace function public.import_candidates(p_session uuid, p_rows jsonb)
returns table (added int, created int, already int, skipped jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  s public.exam_sessions; r jsonb; v_matric text; v_sid uuid; v_seq int;
  v_added int := 0; v_created int := 0; v_already int := 0; v_skipped jsonb := '[]'::jsonb;
  v_code text; v_name text;
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
    select id into v_sid from public.students where matric_no = v_matric;
    if v_sid is null then
      v_code := upper(trim(coalesce(r ->> 'student_code', '')));
      v_name := trim(coalesce(r ->> 'full_name', ''));
      if v_code !~ '^ST[0-9]{4,10}$' or length(v_name) < 2 or nullif(trim(r ->> 'department'), '') is null or nullif(trim(r ->> 'level'), '') is null then
        v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Unknown student — add full_name, student_code, department and level to create them'); continue;
      end if;
      if exists (select 1 from public.students where student_code = v_code) then
        v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Student ID ' || v_code || ' belongs to another matric number'); continue;
      end if;
      insert into public.students (matric_no, student_code, full_name, department, level)
      values (v_matric, v_code, left(v_name, 120), trim(r ->> 'department'), trim(r ->> 'level')) returning id into v_sid;
      v_created := v_created + 1;
    end if;
    if exists (select 1 from public.registrations where session_id = p_session and student_id = v_sid) then
      v_already := v_already + 1; continue;
    end if;
    v_seq := v_seq + 1;
    insert into public.registrations (session_id, student_id, seq, script_code)
    values (p_session, v_sid, v_seq, public.make_script_code(p_session, v_seq));
    v_added := v_added + 1;
  end loop;

  perform public.audit('Import candidates', s.course_code || ' — ' || v_added || ' registered from CSV'
    || case when v_created > 0 then ', ' || v_created || ' new students' else '' end
    || case when jsonb_array_length(v_skipped) > 0 then ', ' || jsonb_array_length(v_skipped) || ' skipped' else '' end);
  return query select v_added, v_created, v_already, v_skipped;
end $$;

-- ---------------------------------------------------------------------
create or replace function public.session_summaries()
returns table (
  id uuid, course_code text, course_title text, exam_date date, start_time time, venue text,
  status public.session_status, invigilator_name text, last_reconciled_at timestamptz,
  registered int, present int, physical int, scanned int, headcount int,
  complete int, open_issues int, pending int, hc_mismatch boolean
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare s record; c record; r record;
begin
  perform public.require_role('officer', 'admin');
  for s in select es.*, p.full_name as invig from public.exam_sessions es left join public.profiles p on p.id = es.invigilator_id
           order by es.exam_date desc, es.start_time loop
    select * into c from public.session_counts(s.id);
    select count(*) filter (where x.severity = 'ok') as n_ok,
           count(*) filter (where x.severity in ('crit','high','med') and not x.resolved) as n_open,
           count(*) filter (where x.severity = 'pend') as n_pend
      into r from public.reconcile_session(s.id) x;
    return query select s.id, s.course_code, s.course_title, s.exam_date, s.start_time, s.venue, s.status, s.invig,
      s.last_reconciled_at, c.registered, c.present, c.physical, c.scanned, c.headcount,
      r.n_ok::int, r.n_open::int, r.n_pend::int,
      (s.status = 'closed' and c.headcount is not null and c.headcount <> c.physical);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Alerts. key is stable so acknowledgements stick; resolving a discrepancy removes its alert.
create or replace function public.current_alerts(p_include_acked boolean default false)
returns table (
  alert_key text, severity text, kind text, title text, detail text,
  session_id uuid, student_id uuid, raised_at timestamptz, acked_by text, acked_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare s record; c record; x record; v_pend int; v_out jsonb := '[]'::jsonb;
begin
  perform public.require_role('officer', 'admin');

  for s in select * from public.exam_sessions where status <> 'scheduled' loop
    select * into c from public.session_counts(s.id);
    if s.status = 'live' then
      if c.present > c.scanned then
        v_out := v_out || jsonb_build_object('alert_key', s.id || '-live-scan', 'severity', 'high', 'kind', 'Count mismatch',
          'title', s.course_code || ': ' || (c.present - c.scanned) || ' of ' || c.present || ' present candidates have no scan yet',
          'detail', 'Live session in ' || s.venue || '.' || case when c.present > c.physical then ' ' || (c.present - c.physical) || ' scripts also not yet checked in.' else '' end,
          'session_id', s.id, 'raised_at', now());
      end if;
      continue;
    end if;
    if c.headcount is not null and c.headcount <> c.physical then
      v_out := v_out || jsonb_build_object('alert_key', s.id || '-hc', 'severity', 'high', 'kind', 'Headcount mismatch',
        'title', s.course_code || ': headcount ' || c.headcount || ' but ' || c.physical || ' physical scripts received',
        'detail', 'Hall headcount does not match scripts checked in.', 'session_id', s.id, 'raised_at', coalesce(s.closed_at, now()));
    end if;
    for x in select * from public.reconcile_session(s.id) r where r.severity in ('crit','high','med') and not r.resolved loop
      v_out := v_out || jsonb_build_object('alert_key', s.id || '-' || x.student_id, 'severity', x.severity, 'kind', x.outcome,
        'title', s.course_code || ': ' || x.outcome || ' — ' || x.matric_no,
        'detail', x.full_name || '. ' || case x.outcome
          when 'Integrity failure' then 'Stored file hash no longer matches the hash recorded at upload.'
          when 'Duplicate scan' then x.n_scans || ' active scans for one candidate.'
          when 'Unregistered candidate' then 'Not on the registered list for this course.'
          when 'Absent but script exists' then 'Marked absent on attendance, yet a script was received.'
          else 'Present at the exam, record incomplete.' end,
        'session_id', s.id, 'student_id', x.student_id, 'raised_at', coalesce(s.closed_at, now()));
    end loop;
  end loop;

  select count(*) into v_pend from public.student_documents where status = 'pending';
  if v_pend > 0 then
    v_out := v_out || jsonb_build_object('alert_key', 'docs-pending', 'severity', 'med', 'kind', 'Documents awaiting verification',
      'title', v_pend || ' student documents awaiting verification', 'detail', 'Uploaded by students; verify or reject with a reason.',
      'raised_at', (select min(created_at) from public.student_documents where status = 'pending'));
  end if;

  return query
  select a.alert_key, a.severity, a.kind, a.title, a.detail, a.session_id, a.student_id, a.raised_at, k.acked_by_name, k.acked_at
  from jsonb_to_recordset(v_out) as a(alert_key text, severity text, kind text, title text, detail text,
                                      session_id uuid, student_id uuid, raised_at timestamptz)
  left join public.alert_acks k on k.alert_key = a.alert_key
  where p_include_acked or k.alert_key is null
  order by case a.severity when 'crit' then 0 when 'high' then 1 else 2 end, a.raised_at desc;
end $$;

-- ---------------------------------------------------------------------
create or replace function public.dashboard_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform public.require_role('officer', 'admin');
  select jsonb_build_object(
    'scripts_total', (select count(*) from public.scripts),
    'scripts_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.scripts group by status) t), '{}'::jsonb),
    'scan_files', (select count(*) from public.files where kind = 'script' and active),
    'files_total', (select count(*) from public.files),
    'files_failed', (select count(*) from public.file_integrity fi join public.files f on f.id = fi.file_id where fi.ok = false and f.active),
    'files_checked', (select count(*) from public.file_integrity where ok is not null),
    'last_check_at', (select max(checked_at) from public.integrity_checks),
    'students_total', (select count(*) from public.students),
    'students_complete', (select count(*) from public.students st where not exists (
        select 1 from public.doc_types t where t.required and not exists (
          select 1 from public.student_documents d where d.student_id = st.id and d.doc_type = t.id and d.status = 'verified'))),
    'docs_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.student_documents group by status) t), '{}'::jsonb),
    'docs_verified_by_type', coalesce((select jsonb_object_agg(doc_type, n) from (
        select doc_type, count(distinct student_id) n from public.student_documents where status = 'verified' group by doc_type) t), '{}'::jsonb)
  ) into v;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Integrity run results from the edge function. p_actor null = scheduled (System).
create or replace function public.record_integrity_run(p_actor uuid, p_results jsonb)
returns table (checked int, failed int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_run uuid := gen_random_uuid(); v_n int; v_bad int;
begin
  insert into public.integrity_checks (file_id, ok, computed, run_id)
  select (e ->> 'file_id')::uuid, (e ->> 'ok')::boolean, e ->> 'computed', v_run
  from jsonb_array_elements(p_results) e;
  get diagnostics v_n = row_count;
  select count(*) into v_bad from jsonb_array_elements(p_results) e where not (e ->> 'ok')::boolean;
  if p_actor is null then
    insert into public.audit_log (actor_id, actor_name, action, detail)
    values (null, 'System', 'Nightly integrity check', v_n || ' files re-hashed — ' || v_bad || ' mismatch' || case when v_bad = 1 then '' else 'es' end);
  else
    perform public.audit_as(p_actor, 'Integrity check', v_n || ' files re-hashed — ' || v_bad || ' mismatch' || case when v_bad = 1 then '' else 'es' end);
  end if;
  return query select v_n, v_bad;
end $$;
revoke execute on function public.record_integrity_run(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_integrity_run(uuid, jsonb) to service_role;

-- service role needs to read these to run the check
grant select on public.files, public.profiles to service_role;

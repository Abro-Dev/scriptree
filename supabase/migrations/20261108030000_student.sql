-- =====================================================================
-- Phase 4 — Student portal
--   my_exams()          the student's own row from each session they're registered for
--   my_documents()      latest document per type, with the verifier's name (students
--                       can't read staff profiles directly)
--   register_document() service-role only; called by register-file after it hashes the upload
-- =====================================================================

create or replace function public.my_exams()
returns table (
  session_id uuid, course_code text, course_title text, exam_date date, venue text,
  status public.session_status, script_code text, present boolean, has_physical boolean,
  n_scans int, outcome text, severity text, resolved boolean
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_student uuid := public.my_student_id(); s record;
begin
  if v_student is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  for s in select es.* from public.exam_sessions es
           join public.registrations r on r.session_id = es.id and r.student_id = v_student
           order by es.exam_date desc, es.start_time loop
    return query
      select s.id, s.course_code, s.course_title, s.exam_date, s.venue, s.status,
             x.script_code, x.present, x.has_physical, x.n_scans, x.outcome, x.severity, x.resolved
      from public.reconcile_session(s.id) x where x.student_id = v_student;
  end loop;
end $$;

create or replace function public.my_documents()
returns table (
  doc_id uuid, doc_type text, status public.doc_status, reason text, uploaded_at timestamptz,
  file_no bigint, sha256 text, size_bytes bigint, original_name text,
  verified_by_name text, verified_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select distinct on (d.doc_type)
    d.id, d.doc_type, d.status, d.reason, d.created_at, f.file_no, f.sha256, f.size_bytes, f.original_name,
    p.full_name, d.verified_at
  from public.student_documents d
  join public.files f on f.id = d.file_id
  left join public.profiles p on p.id = d.verified_by
  where d.student_id = public.my_student_id()
  order by d.doc_type, d.created_at desc
$$;

create or replace function public.register_document(
  p_actor uuid, p_doc_type text, p_path text, p_name text, p_size bigint, p_sha256 text)
returns table (file_no bigint, doc_id uuid)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_student uuid; v_name text; v_latest public.doc_status; v_type text; v_file uuid; v_no bigint; v_doc uuid; v_ver int;
begin
  select s.id, s.full_name into v_student, v_name
  from public.students s join public.profiles p on p.id = s.user_id
  where s.user_id = p_actor and p.role = 'student' and p.status = 'active';
  if v_student is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  select name into v_type from public.doc_types where id = p_doc_type;
  if v_type is null then raise exception 'Unknown document type'; end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'Bad fingerprint'; end if;

  perform pg_advisory_xact_lock(hashtext('scriptree.doc.' || v_student || p_doc_type));
  select status into v_latest from public.student_documents
   where student_id = v_student and doc_type = p_doc_type order by created_at desc limit 1;
  if v_latest = 'pending' then raise exception 'This document is already awaiting verification'; end if;
  if v_latest = 'verified' then raise exception 'This document is already verified'; end if;

  select count(*) + 1 into v_ver from public.files where kind = 'doc' and student_id = v_student and doc_type = p_doc_type;
  update public.files set active = false where kind = 'doc' and student_id = v_student and doc_type = p_doc_type and active;
  insert into public.files (kind, student_id, doc_type, storage_path, original_name, size_bytes, sha256, version, active, uploaded_by, uploaded_by_name)
  values ('doc', v_student, p_doc_type, p_path, left(p_name, 200), p_size, p_sha256, v_ver, true, p_actor, v_name)
  returning id, files.file_no into v_file, v_no;
  insert into public.student_documents (student_id, doc_type, file_id) values (v_student, p_doc_type, v_file) returning id into v_doc;

  perform public.audit_as(p_actor, 'Upload document', (select matric_no from public.students where id = v_student)
    || ' — ' || v_type || case when v_ver > 1 then ' (re-upload v' || v_ver || ')' else '' end || ' · SHA-256 ' || left(p_sha256, 12) || '…');
  return query select v_no, v_doc;
end $$;
revoke execute on function public.register_document(uuid, text, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.register_document(uuid, text, text, text, bigint, text) to service_role;

-- Upload size limit, readable by any signed-in user (students can't read the settings table)
create or replace function public.upload_limit_mb() returns int
language sql stable security definer set search_path = public as $$
  select max_file_mb from public.settings where auth.uid() is not null
$$;

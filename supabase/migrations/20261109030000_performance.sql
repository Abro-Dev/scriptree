-- Performance: indexes for the lookups RLS and the screens actually do, and RLS policies that
-- evaluate the caller's role once per query instead of once per row.
--
-- Why the policy rewrite matters: a policy like `using (public.app_role() in (...))` calls app_role(),
-- which queries profiles, for every row the table scan touches. Wrapping it as
-- `(select public.app_role())` turns it into an InitPlan that Postgres runs once per statement and
-- reuses (Supabase's recommended RLS pattern). Access rules are unchanged: each policy below allows
-- exactly the same rows as before.

-- ---------------------------------------------------------------------
-- Indexes on foreign keys / filters that had none
-- ---------------------------------------------------------------------
-- can_see_session() for invigilators: exam_sessions where invigilator_id = me
create index if not exists exam_sessions_invigilator_idx on public.exam_sessions (invigilator_id);
-- can_see_session() for students, the reg_self policy and the script tracker
create index if not exists registrations_student_idx on public.registrations (student_id);
-- att_self / scripts_self / files_self / tracker lookups by student
create index if not exists attendance_student_idx on public.attendance (student_id);
create index if not exists scripts_student_idx on public.scripts (student_id);
create index if not exists files_student_idx on public.files (student_id);
-- archive list: filter by kind, newest first
create index if not exists files_kind_no_idx on public.files (kind, file_no desc);
-- custody timeline per script (custody_staff policy and the tracker)
create index if not exists custody_events_script_idx on public.custody_events (script_id, at);
-- documents queue (status filter, oldest first) and the pending count inside current_alerts
create index if not exists student_documents_status_idx on public.student_documents (status, created_at);

-- Audit log search uses ILIKE '%term%' on three columns, which a b-tree can't serve. Trigram GIN can.
create extension if not exists pg_trgm with schema extensions;
create index if not exists audit_log_search_trgm_idx on public.audit_log
  using gin (action extensions.gin_trgm_ops, detail extensions.gin_trgm_ops, actor_name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------
-- RLS: same rules, evaluated once per statement
-- ---------------------------------------------------------------------
alter policy profiles_self  on public.profiles using (id = (select auth.uid()));
alter policy profiles_staff on public.profiles using ((select public.is_staff()) and role <> 'student');
alter policy profiles_admin on public.profiles using ((select public.app_role()) = 'admin');

alter policy students_staff on public.students using ((select public.is_staff()));
alter policy students_self  on public.students using (user_id = (select auth.uid()));

alter policy audit_read    on public.audit_log using ((select public.app_role()) in ('admin', 'officer'));
alter policy settings_read on public.settings  using ((select public.is_staff()));
alter policy doc_types_read on public.doc_types using ((select auth.uid()) is not null);

-- Officers and admins see every session, so they skip the per-row can_see_session() call entirely.
alter policy sessions_read on public.exam_sessions using (
  (select public.app_role()) in ('admin', 'officer') or public.can_see_session(id));

alter policy reg_staff on public.registrations using (
  (select public.app_role()) in ('admin', 'officer')
  or ((select public.app_role()) = 'invigilator' and public.can_see_session(session_id)));
alter policy reg_self on public.registrations using (student_id = (select public.my_student_id()));

alter policy att_staff on public.attendance using (
  (select public.app_role()) in ('admin', 'officer')
  or ((select public.app_role()) = 'invigilator' and public.can_see_session(session_id)));
alter policy att_self on public.attendance using (student_id = (select public.my_student_id()));

alter policy scripts_staff on public.scripts using (
  (select public.app_role()) in ('admin', 'officer')
  or ((select public.app_role()) = 'invigilator' and public.can_see_session(session_id)));
alter policy scripts_self on public.scripts using (student_id = (select public.my_student_id()));

alter policy custody_staff on public.custody_events using (
  (select public.app_role()) in ('admin', 'officer')
  or ((select public.app_role()) = 'invigilator'
      and exists (select 1 from public.scripts sc where sc.id = script_id and public.can_see_session(sc.session_id))));

alter policy resolutions_staff on public.resolutions using ((select public.app_role()) in ('admin', 'officer'));
alter policy acks_staff        on public.alert_acks  using ((select public.app_role()) in ('admin', 'officer'));

alter policy files_officer on public.files using ((select public.app_role()) in ('admin', 'officer'));
alter policy files_invig   on public.files using (
  (select public.app_role()) = 'invigilator' and kind = 'script' and public.can_see_session(session_id));
alter policy files_self    on public.files using (student_id = (select public.my_student_id()));

alter policy integrity_read on public.integrity_checks using ((select public.app_role()) in ('admin', 'officer'));
alter policy docs_officer   on public.student_documents using ((select public.app_role()) in ('admin', 'officer'));
alter policy docs_self      on public.student_documents using (student_id = (select public.my_student_id()));
alter policy notifications_read on public.notifications using ((select public.app_role()) in ('admin', 'officer'));

alter policy scans_upload on storage.objects with check (
  bucket_id = 'scans' and (select public.app_role()) in ('invigilator', 'officer')
  and (storage.foldername(name))[1] = 'incoming'
  and (storage.foldername(name))[2] = (select auth.uid())::text);
alter policy docs_upload on storage.objects with check (
  bucket_id = 'documents' and (select public.app_role()) = 'student'
  and (storage.foldername(name))[1] = 'incoming'
  and (storage.foldername(name))[2] = (select auth.uid())::text);
alter policy archive_read on storage.objects using (
  bucket_id in ('scans', 'documents') and (select public.app_role()) in ('admin', 'officer'));

-- fresh planner statistics for the new indexes
analyze public.exam_sessions, public.registrations, public.attendance, public.scripts, public.files,
        public.custody_events, public.student_documents, public.audit_log;

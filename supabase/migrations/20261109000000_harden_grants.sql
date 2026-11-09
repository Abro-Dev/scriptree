-- Hardening after the first security-advisor run.
--
-- 1. init.sql revoked EXECUTE from public/anon on the functions that existed
--    at that point. Functions created by the later migrations kept
--    PostgreSQL's default EXECUTE-to-PUBLIC, so the anon key could call them
--    (they all check the caller's role, but nothing should be reachable
--    before sign-in). Close that, and make it the default for new functions.
-- 2. Pin search_path on the six helpers that didn't set one.

revoke execute on all functions in schema public from public, anon;
alter default privileges in schema public revoke execute on functions from public, anon;

-- Signed-in users: every RPC checks the caller's role itself; RLS policies
-- also call the role helpers (app_role, can_see_session, ...) as the invoker.
grant execute on all functions in schema public to authenticated;

-- ...except the internal ones, which only run inside other functions,
-- as triggers, from pg_cron, or from edge functions with the service role.
revoke execute on function public.audit(text, text)               from authenticated;
revoke execute on function public.audit_as(uuid, text, text)      from authenticated;
revoke execute on function public.assert_hall(uuid)               from authenticated;
revoke execute on function public.enqueue_notification(text, text, text) from authenticated;
revoke execute on function public.call_edge_function(text)        from authenticated;
revoke execute on function public.schedule_jobs()                 from authenticated;
revoke execute on function public.student_login_email(text)       from authenticated;
revoke execute on function public.record_integrity_run(uuid, jsonb) from authenticated;
revoke execute on function public.register_document(uuid, text, text, text, bigint, text) from authenticated;
revoke execute on function public.register_scan(uuid, text, uuid, uuid, text, text, bigint, text, public.capture_method, int, boolean) from authenticated;
revoke execute on function public.tg_audit_chain()         from authenticated;
revoke execute on function public.tg_audit_immutable()     from authenticated;
revoke execute on function public.tg_session_closed()      from authenticated;
revoke execute on function public.tg_settings_reschedule() from authenticated;

-- Edge functions run with the service role.
grant execute on all functions in schema public to service_role;

alter function public.make_script_code(uuid, int) set search_path = public;
alter function public.audit_entry_hash(text, timestamptz, text, text, text) set search_path = public;
alter function public.require_role(variadic public.app_role[]) set search_path = public;
alter function public.is_staff() set search_path = public;
alter function public.tg_audit_chain() set search_path = public;
alter function public.tg_audit_immutable() set search_path = public;

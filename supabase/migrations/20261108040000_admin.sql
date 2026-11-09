-- =====================================================================
-- Phase 5 — Admin
--   * profiles.must_change_password: set when an admin issues a temporary password;
--     the app forces a new password before anything else.
--   * set_staff_role(): admin re-assigns a staff member's role.
--   * password_changed(): the user clears their own flag after choosing a password.
--   Account creation itself (auth users) happens in the admin-users edge function.
-- =====================================================================

alter table public.profiles add column if not exists must_change_password boolean not null default false;

create or replace function public.password_changed() returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  update public.profiles set must_change_password = false where id = auth.uid();
  perform public.audit('Set password', 'New password chosen');
end $$;

create or replace function public.set_staff_role(p_user uuid, p_role public.app_role) returns void
language plpgsql security definer set search_path = public as $$
declare v public.profiles; v_old public.app_role;
begin
  perform public.require_role('admin');
  if p_user = auth.uid() then raise exception 'You cannot change your own role'; end if;
  if p_role = 'student' then raise exception 'Staff cannot be made students'; end if;
  select role into v_old from public.profiles where id = p_user for update;
  if v_old is null then raise exception 'No such account'; end if;
  if v_old = 'student' then raise exception 'Student accounts keep the student role'; end if;
  if v_old = 'invigilator' and p_role <> 'invigilator'
     and exists (select 1 from public.exam_sessions where invigilator_id = p_user and status <> 'closed') then
    raise exception 'Reassign their open exam sessions first';
  end if;
  update public.profiles set role = p_role where id = p_user returning * into v;
  perform public.audit('Change role', v.full_name || ' — ' || v_old || ' → ' || p_role);
end $$;

-- the edge function audits on the admin's behalf
grant execute on function public.audit_as(uuid, text, text) to service_role;

-- settings: empty alert email clears it; validate the address shape
create or replace function public.update_settings(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := nullif(trim(p ->> 'alert_email'), '');
begin
  perform public.require_role('admin');
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Invalid alert email'; end if;
  if coalesce((p ->> 'allow_pdf_upload')::boolean, true) = false and coalesce((p ->> 'allow_photo_snaps')::boolean, true) = false then
    raise exception 'Keep at least one capture method';
  end if;
  update public.settings set
    default_att_mode  = coalesce((p ->> 'default_att_mode')::public.attendance_mode, default_att_mode),
    allow_pdf_upload  = coalesce((p ->> 'allow_pdf_upload')::boolean, allow_pdf_upload),
    allow_photo_snaps = coalesce((p ->> 'allow_photo_snaps')::boolean, allow_photo_snaps),
    max_file_mb       = coalesce((p ->> 'max_file_mb')::int, max_file_mb),
    nightly_check_at  = coalesce((p ->> 'nightly_check_at')::time, nightly_check_at),
    alert_email       = case when p ? 'alert_email' then v_email else alert_email end,
    updated_at = now();
  perform public.audit('Update settings', 'Attendance ' || coalesce(p ->> 'default_att_mode', '—') || ', max ' || coalesce(p ->> 'max_file_mb', '—')
    || ' MB, PDF ' || coalesce(p ->> 'allow_pdf_upload', '—') || ', snaps ' || coalesce(p ->> 'allow_photo_snaps', '—')
    || ', nightly ' || coalesce(p ->> 'nightly_check_at', '—') || ', alerts to ' || coalesce(v_email, 'nobody'));
end $$;

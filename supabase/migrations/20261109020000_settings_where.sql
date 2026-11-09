-- Supabase enables pg_safeupdate for API requests, which rejects any UPDATE
-- without a WHERE clause ("UPDATE requires a WHERE clause"). settings is a
-- single-row table (id boolean primary key, always true), so target that row.

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
    updated_at = now()
  where id;
  perform public.audit('Update settings', 'Attendance ' || coalesce(p ->> 'default_att_mode', '—') || ', max ' || coalesce(p ->> 'max_file_mb', '—')
    || ' MB, PDF ' || coalesce(p ->> 'allow_pdf_upload', '—') || ', snaps ' || coalesce(p ->> 'allow_photo_snaps', '—')
    || ', nightly ' || coalesce(p ->> 'nightly_check_at', '—') || ', alerts to ' || coalesce(v_email, 'nobody'));
end $$;

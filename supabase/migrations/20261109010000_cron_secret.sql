-- Scheduled jobs authenticate to edge functions with their own secret.
--
-- The first version sent the service-role key and the functions compared it
-- to their SUPABASE_SERVICE_ROLE_KEY env var. On projects using Supabase's
-- newer API keys that env value differs from the key shown in the
-- dashboard, so the comparison never matched and every scheduled call got 401.
--
-- Now a random secret is generated here, kept in Vault, sent by pg_cron in an
-- x-scriptree-cron header, and checked by the functions through
-- is_cron_request() (service role only). Nobody has to copy keys around, and
-- the scriptree_service_key Vault secret is no longer used.

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'scriptree_cron_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'scriptree_cron_secret',
                                'ScripTree: authenticates pg_cron calls to edge functions');
  end if;
end $$;

create or replace function public.is_cron_request(p_token text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(length(p_token) >= 32 and p_token = (
    select decrypted_secret from vault.decrypted_secrets where name = 'scriptree_cron_secret'), false)
$$;
revoke execute on function public.is_cron_request(text) from public, anon, authenticated;
grant  execute on function public.is_cron_request(text) to service_role;

create or replace function public.call_edge_function(p_name text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'scriptree_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'scriptree_cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'ScripTree: vault secrets scriptree_project_url / scriptree_cron_secret are not set; skipping %', p_name;
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_name,
    headers := jsonb_build_object('x-scriptree-cron', v_secret, 'Content-Type', 'application/json'),
    body := '{"scheduled": true}'::jsonb,
    timeout_milliseconds := 300000);
end $$;
revoke execute on function public.call_edge_function(text) from public, anon, authenticated;

create or replace function public.notification_status()
returns table (pending int, failing int, last_sent_at timestamptz, last_error text, nightly_job boolean, sender_job boolean, secrets_ready boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_role('admin', 'officer');
  return query select
    (select count(*)::int from public.notifications where sent_at is null),
    (select count(*)::int from public.notifications where sent_at is null and attempts > 0),
    (select max(sent_at) from public.notifications),
    (select n.last_error from public.notifications n where n.sent_at is null and n.last_error is not null order by n.id desc limit 1),
    exists (select 1 from cron.job where jobname = 'scriptree-nightly-check'),
    exists (select 1 from cron.job where jobname = 'scriptree-send-alerts'),
    (select count(*) = 2 from vault.secrets where name in ('scriptree_project_url', 'scriptree_cron_secret'));
end $$;

-- Audit log page now always filters by a time window (last 24 hours by default).
-- Index the timestamp so that range scan stays cheap as the log grows.
create index if not exists audit_log_at_idx on public.audit_log (at desc);

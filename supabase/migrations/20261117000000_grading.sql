-- =====================================================================
-- Grading and results
--
-- Flow: hall check-in → custody → session closed and reconciled → the exams officer grades each
-- script → the officer publishes the session's results → each student sees a score per script
-- and per course.
--
-- Rules
--   * Only the exams officer grades.
--   * A script can be graded only when its record is clean: the session is closed, the physical
--     script was checked in, and reconciliation says Complete, or the officer accepted the
--     discrepancy with an explanation. Pending records, open issues and escalated cases can't be
--     graded.
--   * Eligibility is worked out live from reconciliation, never stored. If a graded script's record
--     goes bad later (a failed integrity check, say), the student sees the result as withheld until
--     the officer clears it.
--   * Students see nothing until the officer publishes. After publishing, changing a score needs a
--     reason. Every version of every score is kept (grade_history, append-only) and audited.
--   * Scores never appear in custody events, because invigilators can read those. Custody shows
--     "Graded" and nothing more.
--
-- Also here
--   * recon_set takes an optional student, so a student's own results don't reconcile whole sessions.
--   * recon_set and counts_set are no longer callable from the browser. They are SECURITY DEFINER
--     without a role check and were only ever meant for other database functions.
--   * Student notification emails: notifications.to_email; the sender delivers those even when no
--     office alert email is set.
--
-- Deploy with it: send-alerts (student emails, office alerts first).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Settings: grade bands (highest first; the last band starts at 0)
-- ---------------------------------------------------------------------
alter table public.settings add column if not exists grade_bands jsonb not null default
  '[{"grade":"A","min":70},{"grade":"B","min":60},{"grade":"C","min":50},{"grade":"D","min":45},{"grade":"E","min":40},{"grade":"F","min":0}]'::jsonb;

-- Validate and normalise a band list; returns it sorted highest first.
create or replace function public.check_grade_bands(p jsonb) returns jsonb
language plpgsql immutable as $$
declare b jsonb; v_grades text[] := '{}'; v_mins numeric[] := '{}'; v_g text; v_raw text; v_out jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 2 and 12 then
    raise exception 'Give between 2 and 12 grade bands';
  end if;
  for b in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(b) <> 'object' then raise exception 'Each grade band needs a grade and a lowest mark'; end if;
    v_g := upper(trim(coalesce(b ->> 'grade', '')));
    if v_g !~ '^[A-Z][A-Z0-9+-]{0,2}$' then raise exception 'Grade names are 1 to 3 characters, e.g. A, B+ or F'; end if;
    if v_g = any (v_grades) then raise exception 'Grade % is listed twice', v_g; end if;
    v_raw := trim(coalesce(b ->> 'min', ''));
    if v_raw !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' or v_raw::numeric > 100 then
      raise exception 'Grade %: the lowest mark must be a number from 0 to 100', v_g;
    end if;
    if v_raw::numeric = any (v_mins) then raise exception 'Two grades start at %', v_raw::numeric; end if;
    v_grades := v_grades || v_g; v_mins := v_mins || v_raw::numeric;
  end loop;
  if not (0 = any (v_mins)) then raise exception 'The lowest grade must start at 0'; end if;
  select jsonb_agg(jsonb_build_object('grade', g, 'min', m) order by m desc) into v_out
  from unnest(v_grades, v_mins) u(g, m);
  return v_out;
end $$;

-- update_settings (as 20261109020000) plus grade bands
create or replace function public.update_settings(p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := nullif(trim(p ->> 'alert_email'), ''); v_bands jsonb;
begin
  perform public.require_role('admin');
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Invalid alert email'; end if;
  if coalesce((p ->> 'allow_pdf_upload')::boolean, true) = false and coalesce((p ->> 'allow_photo_snaps')::boolean, true) = false then
    raise exception 'Keep at least one capture method';
  end if;
  if p ? 'grade_bands' then v_bands := public.check_grade_bands(p -> 'grade_bands'); end if;
  update public.settings set
    default_att_mode  = coalesce((p ->> 'default_att_mode')::public.attendance_mode, default_att_mode),
    allow_pdf_upload  = coalesce((p ->> 'allow_pdf_upload')::boolean, allow_pdf_upload),
    allow_photo_snaps = coalesce((p ->> 'allow_photo_snaps')::boolean, allow_photo_snaps),
    max_file_mb       = coalesce((p ->> 'max_file_mb')::int, max_file_mb),
    nightly_check_at  = coalesce((p ->> 'nightly_check_at')::time, nightly_check_at),
    alert_email       = case when p ? 'alert_email' then v_email else alert_email end,
    grade_bands       = coalesce(v_bands, grade_bands),
    updated_at = now()
  where id;
  perform public.audit('Update settings', 'Attendance ' || coalesce(p ->> 'default_att_mode', '—') || ', max ' || coalesce(p ->> 'max_file_mb', '—')
    || ' MB, PDF ' || coalesce(p ->> 'allow_pdf_upload', '—') || ', snaps ' || coalesce(p ->> 'allow_photo_snaps', '—')
    || ', nightly ' || coalesce(p ->> 'nightly_check_at', '—') || ', alerts to ' || coalesce(v_email, 'nobody')
    || coalesce(', grades ' || (select string_agg((b ->> 'grade') || '≥' || (b ->> 'min'), ' ') from jsonb_array_elements(v_bands) b), ''));
end $$;

-- Anyone signed in may read the bands (students turn their percentages into grades with them).
create or replace function public.grade_bands() returns jsonb
language sql stable security definer set search_path = public as $$
  select grade_bands from public.settings where id
$$;

-- ---------------------------------------------------------------------
-- 2. Session: maximum score and results release
-- ---------------------------------------------------------------------
alter table public.exam_sessions
  add column if not exists max_score numeric(5,2) not null default 100,
  add column if not exists results_status text not null default 'draft',
  add column if not exists results_published_at timestamptz,
  add column if not exists results_published_by uuid references public.profiles (id);
alter table public.exam_sessions drop constraint if exists exam_sessions_max_score_check;
alter table public.exam_sessions add constraint exam_sessions_max_score_check check (max_score between 1 and 999);
alter table public.exam_sessions drop constraint if exists exam_sessions_results_status_check;
alter table public.exam_sessions add constraint exam_sessions_results_status_check check (results_status in ('draft', 'published'));

-- ---------------------------------------------------------------------
-- 3. Grades
-- ---------------------------------------------------------------------
create table if not exists public.script_grades (
  script_id      uuid primary key references public.scripts (id) on delete cascade,
  session_id     uuid not null references public.exam_sessions (id) on delete cascade,
  student_id     uuid not null references public.students (id),
  score          numeric(5,2) not null check (score >= 0),
  graded_by      uuid not null references public.profiles (id),
  graded_by_name text not null,
  graded_at      timestamptz not null default now(),
  unique (session_id, student_id)
);
create index if not exists script_grades_student_idx on public.script_grades (student_id);

-- Every version of every score. Append-only. Cancelling a session that never opened is the only
-- thing that removes scripts, and a session that never opened has no grades.
create table if not exists public.grade_history (
  id         bigint generated always as identity primary key,
  script_id  uuid not null references public.scripts (id) on delete cascade,
  session_id uuid not null,
  student_id uuid not null,
  old_score  numeric(5,2),
  new_score  numeric(5,2),
  reason     text,
  actor_id   uuid,
  actor_name text not null,
  at         timestamptz not null default now()
);
create index if not exists grade_history_script_idx on public.grade_history (script_id, id);

create or replace function public.tg_grade_history_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'grade_history is append-only' using errcode = '42501';
end $$;
drop trigger if exists grade_history_no_change on public.grade_history;
create trigger grade_history_no_change before update or delete on public.grade_history
for each row execute function public.tg_grade_history_immutable();

-- read through the functions below only
alter table public.script_grades enable row level security;
alter table public.grade_history enable row level security;
revoke all on public.script_grades, public.grade_history from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. recon_set: optional student filter (outcome rules unchanged from 20261110020000)
-- ---------------------------------------------------------------------
drop function if exists public.recon_set(uuid[]);
create function public.recon_set(p_sessions uuid[], p_student uuid default null)
returns table (session_id uuid, student_id uuid, reg boolean, att boolean, phys boolean, nscan int, bad boolean,
               outcome text, severity text, resolved boolean)
language sql stable security definer set search_path = public as $$
  with cand as (
    select r.session_id, r.student_id from public.registrations r
      where r.session_id = any (p_sessions) and (p_student is null or r.student_id = p_student)
    union select sc.session_id, sc.student_id from public.scripts sc
      where sc.session_id = any (p_sessions) and (p_student is null or sc.student_id = p_student)
    union select f.session_id, f.student_id from public.files f
      where f.kind = 'script' and f.active and f.session_id = any (p_sessions) and (p_student is null or f.student_id = p_student)
  ),
  scans as (
    select f.session_id, f.student_id, count(*)::int n, bool_or(f.last_check_ok = false) bad
    from public.files f where f.kind = 'script' and f.active and f.session_id = any (p_sessions)
      and (p_student is null or f.student_id = p_student)
    group by 1, 2
  ),
  base as (
    select c.session_id, c.student_id, r.student_id is not null reg, a.present att, sc.id is not null phys,
           coalesce(sn.n, 0) nscan, coalesce(sn.bad, false) bad, es.status in ('live', 'scheduled') live
    from cand c
    join public.exam_sessions es on es.id = c.session_id
    left join public.registrations r on r.session_id = c.session_id and r.student_id = c.student_id
    left join public.attendance a on a.session_id = c.session_id and a.student_id = c.student_id
    left join public.scripts sc on sc.session_id = c.session_id and sc.student_id = c.student_id
    left join scans sn on sn.session_id = c.session_id and sn.student_id = c.student_id
  ),
  judged as (
    select b.*, case
        when not b.reg then array['Unregistered candidate', 'high']
        when b.att is null then case when b.live then array['Awaiting attendance', 'pend'] else array['Attendance not marked', 'med'] end
        when b.att = false and (b.phys or b.nscan > 0) then array['Absent but script exists', 'high']
        when b.att = false then array['Absent', 'info']
        when b.bad then array['Integrity failure', 'crit']
        when not b.phys and b.nscan = 0 then case when b.live then array['Script + scan pending', 'pend'] else array['Missing script and scan', 'crit'] end
        when not b.phys then case when b.live then array['Script check-in pending', 'pend'] else array['Missing physical script', 'high'] end
        when b.nscan > 1 then array['Duplicate scan', 'med']
        when b.nscan = 0 then case when b.live then array['Scan pending', 'pend'] else array['Missing scan', 'med'] end
        else array['Complete', 'ok'] end o
    from base b
  )
  select j.session_id, j.student_id, j.reg, j.att, j.phys, j.nscan, j.bad, j.o[1], j.o[2], rs.student_id is not null
  from judged j
  left join public.resolutions rs on rs.session_id = j.session_id and rs.student_id = j.student_id and rs.outcome = j.o[1]
$$;

-- ---------------------------------------------------------------------
-- 5. Who can be graded
--    eligible = session closed, physical script checked in, and the record is Complete or its
--    discrepancy was accepted with an explanation (an escalation is not an acceptance).
-- ---------------------------------------------------------------------
create or replace function public.grade_eligibility(p_sessions uuid[], p_student uuid default null)
returns table (session_id uuid, student_id uuid, script_id uuid, script_code text, custody text, location text,
               present boolean, outcome text, severity text, resolved boolean, eligible boolean, hold_reason text)
language sql stable security definer set search_path = public as $$
  select x.session_id, x.student_id, sc.id, sc.script_code, sc.status::text, sc.location, x.att, x.outcome, x.severity, x.resolved,
    coalesce(es.status = 'closed' and sc.id is not null
      and (x.severity = 'ok' or (x.resolved and rs.action is distinct from 'Escalated to department')), false),
    case
      when es.status <> 'closed' then 'Session not closed yet'
      when sc.id is null and x.severity = 'info' then x.outcome
      when sc.id is null then 'No physical script (' || x.outcome || ')'
      when x.severity = 'ok' then null
      when x.resolved and rs.action is distinct from 'Escalated to department' then null
      when x.resolved then 'Escalated: ' || x.outcome
      else 'Open issue: ' || x.outcome
    end
  from public.recon_set(p_sessions, p_student) x
  join public.exam_sessions es on es.id = x.session_id
  left join public.scripts sc on sc.session_id = x.session_id and sc.student_id = x.student_id
  left join public.resolutions rs on rs.session_id = x.session_id and rs.student_id = x.student_id and rs.outcome = x.outcome
$$;

-- ---------------------------------------------------------------------
-- 6. Officer: grading sheet, grade one, import many, maximum score
-- ---------------------------------------------------------------------
create or replace function public.grading_sheet(p_session uuid)
returns table (student_id uuid, matric_no text, full_name text, script_id uuid, script_code text, custody text,
               present boolean, outcome text, severity text, resolved boolean, eligible boolean, hold_reason text,
               score numeric, graded_by_name text, graded_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.require_role('officer', 'admin');
  return query
  select e.student_id, st.matric_no, st.full_name, e.script_id, e.script_code, e.custody, e.present, e.outcome, e.severity,
         e.resolved, e.eligible, e.hold_reason, g.score, g.graded_by_name, g.graded_at
  from public.grade_eligibility(array[p_session]) e
  join public.students st on st.id = e.student_id
  left join public.script_grades g on g.script_id = e.script_id
  order by st.matric_no;
end $$;

-- Save, change or (p_score null) remove a score. Returns 'saved', 'changed', 'removed' or 'unchanged'.
create or replace function public.grade_script(p_session uuid, p_student uuid, p_score numeric, p_reason text default null)
returns text language plpgsql security definer set search_path = public as $$
declare
  s public.exam_sessions; e record; g public.script_grades; v_name text; v_matric text; v_result text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  perform public.require_role('officer');
  -- shared lock: many grades at once, but never while results are being published or the session reopened
  select * into s from public.exam_sessions where id = p_session for share;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status <> 'closed' then raise exception 'Close the session before grading its scripts'; end if;
  select * into e from public.grade_eligibility(array[p_session], p_student) x limit 1;
  if e.student_id is null then raise exception 'That candidate is not part of this session'; end if;
  if e.script_id is null then raise exception 'No physical script was checked in for this candidate'; end if;
  if length(v_reason) > 300 then raise exception 'Keep the reason under 300 characters'; end if;

  select * into g from public.script_grades where script_id = e.script_id for update;
  if p_score is not null then
    if not e.eligible then raise exception 'This script can''t be graded yet: %', e.hold_reason; end if;
    if p_score < 0 or p_score > s.max_score then raise exception 'Score must be between 0 and %', trim_scale(s.max_score); end if;
    if p_score <> round(p_score, 2) then raise exception 'Use at most two decimal places'; end if;
  end if;
  if (g.script_id is null and p_score is null) or g.score = p_score then return 'unchanged'; end if;
  if s.results_status = 'published' and g.script_id is not null and length(coalesce(v_reason, '')) < 5 then
    raise exception 'Results are published, so say why this score is changing';
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  select matric_no into v_matric from public.students where id = p_student;
  if p_score is null then
    delete from public.script_grades where script_id = e.script_id;
    v_result := 'removed';
  else
    insert into public.script_grades (script_id, session_id, student_id, score, graded_by, graded_by_name)
    values (e.script_id, p_session, p_student, p_score, auth.uid(), v_name)
    on conflict (script_id) do update
      set score = excluded.score, graded_by = excluded.graded_by, graded_by_name = excluded.graded_by_name, graded_at = now();
    v_result := case when g.script_id is null then 'saved' else 'changed' end;
  end if;
  insert into public.grade_history (script_id, session_id, student_id, old_score, new_score, reason, actor_id, actor_name)
  values (e.script_id, p_session, p_student, g.score, p_score, v_reason, auth.uid(), v_name);
  -- custody trail without the mark (invigilators can read custody)
  insert into public.custody_events (script_id, action, location, actor_id, actor_name)
  values (e.script_id, case v_result when 'saved' then 'Graded' when 'changed' then 'Grade changed' else 'Grade removed' end,
          e.location, auth.uid(), v_name);
  perform public.audit('Grade script', e.script_code || ' (' || v_matric || ') — '
    || coalesce(trim_scale(g.score)::text, 'no score') || ' → ' || coalesce(trim_scale(p_score)::text, 'no score')
    || ' of ' || trim_scale(s.max_score)
    || case when s.results_status = 'published' then ' after publishing' else '' end
    || coalesce(' (' || v_reason || ')', ''));
  return v_result;
end $$;

-- Rows: { "script_code": "...", "score": "67" } or { "student_id": "BU/...", "score": "67" }.
-- An empty score is skipped (a file never removes a score). p_reason covers every changed score
-- when results are already published.
create or replace function public.import_grades(p_session uuid, p_rows jsonb, p_reason text default null)
returns table (saved int, changed int, unchanged int, skipped jsonb)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  s public.exam_sessions; r jsonb; v_key text; v_raw text; v_sid uuid; v_res text; v_seen uuid[] := '{}';
  v_saved int := 0; v_changed int := 0; v_same int := 0; v_skip jsonb[] := '{}';
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for share;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status <> 'closed' then raise exception 'Close the session before grading its scripts'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then
      v_skip := v_skip || jsonb_build_object('ref', '', 'reason', 'Not a score row'); continue;
    end if;
    v_key := upper(trim(coalesce(nullif(trim(r ->> 'script_code'), ''), r ->> 'student_id', r ->> 'matric_no', '')));
    v_raw := trim(coalesce(r ->> 'score', ''));
    v_sid := null;
    if v_key <> '' then
      select sc.student_id into v_sid from public.scripts sc where sc.session_id = p_session and upper(sc.script_code) = v_key;
      if v_sid is null then
        select st.id into v_sid from public.students st where st.matric_no = v_key;
      end if;
    end if;
    if v_sid is null then
      v_skip := v_skip || jsonb_build_object('ref', left(v_key, 40), 'reason', 'No such script code or student ID in this session'); continue;
    end if;
    if v_sid = any (v_seen) then
      v_skip := v_skip || jsonb_build_object('ref', left(v_key, 40), 'reason', 'Listed twice: the first score was used'); continue;
    end if;
    v_seen := v_seen || v_sid;
    if v_raw = '' then
      v_skip := v_skip || jsonb_build_object('ref', left(v_key, 40), 'reason', 'No score'); continue;
    end if;
    if v_raw !~ '^[0-9]{1,3}(\.[0-9]{1,2})?$' then
      v_skip := v_skip || jsonb_build_object('ref', left(v_key, 40), 'reason', 'Score is not a number: ' || left(v_raw, 20)); continue;
    end if;
    begin
      v_res := public.grade_script(p_session, v_sid, v_raw::numeric, p_reason);
    exception when others then
      v_skip := v_skip || jsonb_build_object('ref', left(v_key, 40), 'reason', left(sqlerrm, 160)); continue;
    end;
    case v_res when 'saved' then v_saved := v_saved + 1; when 'changed' then v_changed := v_changed + 1; else v_same := v_same + 1; end case;
  end loop;
  perform public.audit('Import grades', s.course_code || ' · ' || s.venue || ' — ' || v_saved || ' graded'
    || case when v_changed > 0 then ', ' || v_changed || ' changed' else '' end
    || case when v_same > 0 then ', ' || v_same || ' unchanged' else '' end
    || case when cardinality(v_skip) > 0 then ', ' || cardinality(v_skip) || ' skipped' else '' end);
  return query select v_saved, v_changed, v_same, to_jsonb(v_skip);
end $$;

create or replace function public.set_max_score(p_session uuid, p_max numeric) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions; v_top numeric;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.results_status = 'published' then raise exception 'Results are published: withdraw them before changing the maximum score'; end if;
  if p_max is null or p_max < 1 or p_max > 999 or p_max <> round(p_max, 2) then raise exception 'The maximum score must be 1 to 999'; end if;
  if p_max = s.max_score then return; end if;
  select max(score) into v_top from public.script_grades where session_id = p_session;
  if v_top > p_max then raise exception 'A script already scored %, which is above %', trim_scale(v_top), trim_scale(p_max); end if;
  update public.exam_sessions set max_score = p_max where id = p_session;
  perform public.audit('Set maximum score', s.course_code || ' · ' || s.venue || ' — ' || trim_scale(s.max_score) || ' → ' || trim_scale(p_max));
end $$;

-- ---------------------------------------------------------------------
-- 7. Publish / withdraw
-- ---------------------------------------------------------------------
create or replace function public.publish_results(p_session uuid)
returns table (graded int, withheld int, notified int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare s public.exam_sessions; v_graded int; v_ungraded int; v_held int; v_sent int;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status <> 'closed' then raise exception 'Close the session first'; end if;
  if s.results_status = 'published' then raise exception 'Results are already published'; end if;

  create temp table if not exists _ge on commit drop as select * from public.grade_eligibility('{}'::uuid[]) with no data;
  truncate _ge;
  insert into _ge select * from public.grade_eligibility(array[p_session]);
  select count(*) filter (where e.eligible and g.script_id is not null),
         count(*) filter (where e.eligible and g.script_id is null),
         count(*) filter (where e.script_id is not null and not e.eligible)
    into v_graded, v_ungraded, v_held
  from _ge e left join public.script_grades g on g.script_id = e.script_id;
  if v_ungraded > 0 then
    raise exception '% gradeable script% still % no score', v_ungraded, case when v_ungraded = 1 then '' else 's' end,
      case when v_ungraded = 1 then 'has' else 'have' end;
  end if;
  if v_graded = 0 then raise exception 'No script has been graded yet'; end if;

  update public.exam_sessions set results_status = 'published', results_published_at = now(), results_published_by = auth.uid()
  where id = p_session;

  -- tell each student whose result is now visible; the email carries no mark
  insert into public.notifications (kind, subject, body, to_email)
  select 'results_published', 'ScripTree: your ' || s.course_code || ' result is out',
         'Your result for ' || s.course_code || ' · ' || s.course_title || ' (exam on ' || to_char(s.exam_date, 'DD Mon YYYY') || ') has been published.'
         || E'\n\n' || 'Sign in to ScripTree with your student ID to see your score.',
         st.email
  from _ge e join public.script_grades g on g.script_id = e.script_id join public.students st on st.id = e.student_id
  where e.eligible and st.email is not null;
  get diagnostics v_sent = row_count;

  perform public.audit('Publish results', s.course_code || ' · ' || s.venue || ' · ' || s.exam_date || ' — ' || v_graded || ' results released'
    || case when v_held > 0 then ', ' || v_held || ' withheld (record under review)' else '' end
    || ', ' || v_sent || ' students emailed');
  return query select v_graded, v_held, v_sent;
end $$;

create or replace function public.unpublish_results(p_session uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions; v_reason text := trim(coalesce(p_reason, ''));
begin
  perform public.require_role('officer');
  if length(v_reason) not between 5 and 300 then raise exception 'Say why the results are being withdrawn'; end if;
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.results_status <> 'published' then raise exception 'Results for this session are not published'; end if;
  update public.exam_sessions set results_status = 'draft', results_published_at = null, results_published_by = null where id = p_session;
  perform public.audit('Withdraw results', s.course_code || ' · ' || s.venue || ' · ' || s.exam_date || ' (' || v_reason || ')');
end $$;

-- reopen_session (as 20261113000000), but not while results are out
create or replace function public.reopen_session(p_session uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.exam_sessions;
begin
  perform public.require_role('officer');
  select * into s from public.exam_sessions where id = p_session for update;
  if s.id is null then raise exception 'No such session'; end if;
  if s.status <> 'closed' then raise exception 'Only a closed session can be reopened'; end if;
  if s.results_status = 'published' then raise exception 'Results for this session are published: withdraw them before reopening'; end if;
  if length(trim(coalesce(p_note, ''))) not between 5 and 300 then raise exception 'Say why the session is being reopened'; end if;
  update public.exam_sessions set status = 'live', closed_at = null where id = p_session;
  perform public.audit('Reopen session', s.course_code || ' · ' || s.venue || ' (' || trim(p_note) || ')');
end $$;

-- ---------------------------------------------------------------------
-- 8. Results views
-- ---------------------------------------------------------------------
-- Officer: every closed session with grading progress.
create or replace function public.results_overview()
returns table (id uuid, course_code text, course_title text, exam_date date, start_time time, venue text,
               max_score numeric, results_status text, results_published_at timestamptz,
               scripts int, eligible int, graded int, ungraded int, withheld int, avg_pct numeric)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_ids uuid[];
begin
  perform public.require_role('officer', 'admin');
  select array_agg(es.id) into v_ids from public.exam_sessions es where es.status = 'closed';
  return query
  with e as (select * from public.grade_eligibility(coalesce(v_ids, '{}'::uuid[]))),
  agg as (
    select e.session_id,
           count(*) filter (where e.script_id is not null)::int n_scripts,
           count(*) filter (where e.eligible)::int n_elig,
           count(*) filter (where e.eligible and g.script_id is not null)::int n_graded,
           count(*) filter (where e.eligible and g.script_id is null)::int n_ungraded,
           count(*) filter (where e.script_id is not null and not e.eligible)::int n_held,
           avg(g.score) filter (where e.eligible) avg_score
    from e left join public.script_grades g on g.script_id = e.script_id
    group by e.session_id)
  select es.id, es.course_code, es.course_title, es.exam_date, es.start_time, es.venue, es.max_score, es.results_status,
         es.results_published_at, coalesce(a.n_scripts, 0), coalesce(a.n_elig, 0), coalesce(a.n_graded, 0),
         coalesce(a.n_ungraded, 0), coalesce(a.n_held, 0), round(a.avg_score / es.max_score * 100, 1)
  from public.exam_sessions es left join agg a on a.session_id = es.id
  where es.status = 'closed'
  order by es.exam_date desc, es.start_time, es.course_code;
end $$;

-- Officer: one student's scores, published or not.
create or replace function public.student_scoreboard(p_student uuid)
returns table (session_id uuid, course_code text, course_title text, exam_date date, venue text,
               session_status public.session_status, results_status text, max_score numeric,
               script_code text, outcome text, severity text, eligible boolean, hold_reason text,
               score numeric, graded_by_name text, graded_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_ids uuid[];
begin
  perform public.require_role('officer', 'admin');
  select array_agg(distinct x.sid) into v_ids from (
    select r.session_id sid from public.registrations r where r.student_id = p_student
    union select sc.session_id from public.scripts sc where sc.student_id = p_student) x;
  return query
  select es.id, es.course_code, es.course_title, es.exam_date, es.venue, es.status, es.results_status, es.max_score,
         e.script_code, e.outcome, e.severity, e.eligible, e.hold_reason, g.score, g.graded_by_name, g.graded_at
  from public.grade_eligibility(coalesce(v_ids, '{}'::uuid[]), p_student) e
  join public.exam_sessions es on es.id = e.session_id
  left join public.script_grades g on g.script_id = e.script_id
  order by es.exam_date desc, es.start_time;
end $$;

-- Student: their closed exams. A score is shown only when results are published and the record is
-- clean right now. state: graded | withheld | awaiting | absent | no_script | not_released
create or replace function public.my_results()
returns table (session_id uuid, course_code text, course_title text, exam_date date, script_code text,
               max_score numeric, score numeric, state text, published_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_student uuid := public.my_student_id(); v_ids uuid[];
begin
  if v_student is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  select array_agg(r.session_id) into v_ids
  from public.registrations r join public.exam_sessions es on es.id = r.session_id
  where r.student_id = v_student and es.status = 'closed';
  return query
  select es.id, es.course_code, es.course_title, es.exam_date, e.script_code, es.max_score,
         case when es.results_status = 'published' and e.eligible then g.score end,
         case
           when es.results_status <> 'published' then 'not_released'
           when e.script_id is null and e.severity = 'info' then 'absent'
           when e.script_id is null then 'no_script'
           when not e.eligible then 'withheld'
           when g.script_id is null then 'awaiting'
           else 'graded' end,
         es.results_published_at
  from public.grade_eligibility(coalesce(v_ids, '{}'::uuid[]), v_student) e
  join public.exam_sessions es on es.id = e.session_id
  left join public.script_grades g on g.script_id = e.script_id
  order by es.exam_date desc, es.course_code;
end $$;

-- Officer: the life of one score.
create or replace function public.script_grade_history(p_script uuid)
returns table (at timestamptz, actor_name text, old_score numeric, new_score numeric, reason text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.require_role('officer', 'admin');
  return query select h.at, h.actor_name, h.old_score, h.new_score, h.reason
  from public.grade_history h where h.script_id = p_script order by h.id desc;
end $$;

-- ---------------------------------------------------------------------
-- 9. Dashboard and alerts
-- ---------------------------------------------------------------------
-- dashboard_stats (as 20261110020000) plus results
create or replace function public.dashboard_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; v_req int;
begin
  perform public.require_role('officer', 'admin');
  select count(*) into v_req from public.doc_types where required;
  select jsonb_build_object(
    'scripts_total', (select count(*) from public.scripts),
    'scripts_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.scripts group by status) t), '{}'::jsonb),
    'scan_files', (select count(*) from public.files where kind = 'script' and active),
    'files_total', (select count(*) from public.files),
    'files_failed', (select count(*) from public.files where last_check_ok = false and active),
    'files_checked', (select count(*) from public.files where last_check_ok is not null),
    'last_check_at', (select max(last_checked_at) from public.files),
    'students_total', (select count(*) from public.students),
    'students_complete', case when v_req = 0 then (select count(*) from public.students) else (
        select count(*) from (
          select d.student_id from public.student_documents d join public.doc_types t on t.id = d.doc_type and t.required
          where d.status = 'verified' group by d.student_id having count(distinct d.doc_type) = v_req) x) end,
    'docs_by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.student_documents group by status) t), '{}'::jsonb),
    'docs_verified_by_type', coalesce((select jsonb_object_agg(doc_type, n) from (
        select doc_type, count(distinct student_id) n from public.student_documents where status = 'verified' group by doc_type) t), '{}'::jsonb),
    'results_draft', (select count(*) from public.exam_sessions where status = 'closed' and results_status = 'draft'),
    'results_published', (select count(*) from public.exam_sessions where status = 'closed' and results_status = 'published'),
    'grades_total', (select count(*) from public.script_grades)
  ) into v;
  return v;
end $$;

-- current_alerts (as 20261110020000) plus "results not published two weeks after the exam"
create or replace function public.current_alerts(p_include_acked boolean default false)
returns table (
  alert_key text, severity text, kind text, title text, detail text,
  session_id uuid, student_id uuid, raised_at timestamptz, acked_by text, acked_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare v_now uuid[]; v_dirty uuid[];
begin
  perform public.require_role('officer', 'admin');
  select array_agg(es.id) into v_now from public.exam_sessions es where es.status = 'live' or (es.status = 'closed' and es.recon_dirty);
  select array_agg(es.id) into v_dirty from public.exam_sessions es where es.status = 'closed' and es.recon_dirty;
  return query
  with c as (
    select * from public.counts_set(v_now)
    union all
    select sr.session_id, sr.registered, sr.present, sr.physical, sr.scanned
    from public.session_recon sr join public.exam_sessions es on es.id = sr.session_id where es.status = 'closed' and not es.recon_dirty),
  issues as (
    select x.session_id, x.student_id, x.outcome, x.severity, x.nscan from public.recon_set(v_dirty) x
    where x.severity in ('crit','high','med') and not x.resolved
    union all
    select si.session_id, si.student_id, si.outcome, si.severity, si.nscan
    from public.session_issues si join public.exam_sessions es on es.id = si.session_id where es.status = 'closed' and not es.recon_dirty),
  a as (
    select es.id || '-live-scan-' || (c.present - c.scanned) || '/' || c.present k, 'high' sev, 'Count mismatch' kind,
           es.course_code || ': ' || (c.present - c.scanned) || ' of ' || c.present || ' present candidates have no scan yet' title,
           'Live session in ' || es.venue || '.' || case when c.present > c.physical then ' ' || (c.present - c.physical) || ' scripts also not yet checked in.' else '' end detail,
           es.id sid, null::uuid stid, now() raised
    from public.exam_sessions es join c on c.session_id = es.id where es.status = 'live' and c.present > c.scanned
    union all
    select es.id || '-hc-' || es.headcount || '/' || c.physical, 'high', 'Headcount mismatch',
           es.course_code || ': headcount ' || es.headcount || ' but ' || c.physical || ' physical scripts received',
           'Hall headcount does not match scripts checked in.', es.id, null, coalesce(es.closed_at, now())
    from public.exam_sessions es join c on c.session_id = es.id where es.status = 'closed' and es.headcount is not null and es.headcount <> c.physical
    union all
    select es.id || '-' || i.student_id || '-' || i.outcome, i.severity, i.outcome, es.course_code || ': ' || i.outcome || ' — ' || st.matric_no,
           st.full_name || '. ' || case i.outcome
             when 'Integrity failure' then 'Stored file hash no longer matches the hash recorded at upload.'
             when 'Duplicate scan' then i.nscan || ' active scans for one candidate.'
             when 'Unregistered candidate' then 'Not on the registered list for this course.'
             when 'Absent but script exists' then 'Marked absent on attendance, yet a script was received.'
             else 'Present at the exam, record incomplete.' end,
           es.id, i.student_id, coalesce(es.closed_at, now())
    from issues i join public.exam_sessions es on es.id = i.session_id join public.students st on st.id = i.student_id
    union all
    -- the newest upload is part of the key: a new document raises the alert again after an acknowledgement
    select 'docs-pending-' || extract(epoch from max(d.created_at))::bigint, 'med', 'Documents awaiting verification',
           count(*) || ' student documents awaiting verification',
           'Uploaded by students; verify or reject with a reason.', null, null, min(d.created_at)
    from public.student_documents d where d.status = 'pending' having count(*) > 0
    union all
    select es.id || '-results-due', 'med', 'Results not published',
           es.course_code || ': results not published ' || (current_date - es.closed_at::date) || ' days after the exam',
           es.venue || ', ' || es.exam_date || '. Grade the scripts and publish from the session''s Grading tab.',
           es.id, null, es.closed_at + interval '14 days'
    from public.exam_sessions es
    where es.status = 'closed' and es.results_status = 'draft' and es.closed_at < now() - interval '14 days')
  select a.k, a.sev, a.kind, a.title, a.detail, a.sid, a.stid, a.raised, k.acked_by_name, k.acked_at
  from a left join public.alert_acks k on k.alert_key = a.k
  where p_include_acked or k.alert_key is null
  order by case a.sev when 'crit' then 0 when 'high' then 1 else 2 end, a.raised desc;
end $$;

-- ---------------------------------------------------------------------
-- 10. Emails to students
-- ---------------------------------------------------------------------
alter table public.notifications add column if not exists to_email text;

-- schedule_jobs (as 20261113000000); the sender also runs for student emails when no office address is set
create or replace function public.schedule_jobs() returns void
language plpgsql security definer set search_path = public as $$
declare t time;
begin
  select nightly_check_at into t from public.settings;
  perform cron.schedule('scriptree-nightly-check',
    extract(minute from t)::int || ' ' || extract(hour from t)::int || ' * * *',
    $cmd$select public.call_edge_function('integrity-check')$cmd$);
  perform cron.schedule('scriptree-integrity-continue', '*/2 * * * *',
    $cmd$select public.call_edge_function('integrity-check', '{"scheduled": true, "continue": true}'::jsonb) where exists (select 1 from public.integrity_runs where finished_at is null)$cmd$);
  perform cron.schedule('scriptree-send-alerts', '*/5 * * * *',
    $cmd$select public.call_edge_function('send-alerts') where exists (select 1 from public.notifications n where n.sent_at is null and n.attempts < 5 and (n.to_email is not null or exists (select 1 from public.settings where alert_email is not null)))$cmd$);
  perform cron.schedule('scriptree-recon-refresh', '* * * * *', $cmd$select public.refresh_dirty_recon()$cmd$);
  perform cron.schedule('scriptree-audit-chain', '47 3 * * *', $cmd$select public.nightly_audit_check()$cmd$);
  perform cron.schedule('scriptree-prune-integrity', '27 4 * * *',
    $cmd$delete from public.integrity_checks where ok and checked_at < now() - interval '90 days'$cmd$);
  perform cron.schedule('scriptree-prune-notifications', '37 4 * * *',
    $cmd$delete from public.notifications where (sent_at is not null and sent_at < now() - interval '180 days') or (sent_at is null and created_at < now() - interval '30 days')$cmd$);
end $$;
select public.schedule_jobs();

-- ---------------------------------------------------------------------
-- 11. Grants (see 20261113000000 §7: repeat the revoke after adding functions)
-- ---------------------------------------------------------------------
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure::text sig,
           has_function_privilege('authenticated', p.oid, 'execute') auth,
           has_function_privilege('service_role', p.oid, 'execute') svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.auth then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if f.svc then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
end $$;

-- database-internal: no role check of their own, so never callable from the browser
revoke execute on function public.recon_set(uuid[], uuid), public.counts_set(uuid[]), public.grade_eligibility(uuid[], uuid),
  public.check_grade_bands(jsonb), public.schedule_jobs(), public.tg_grade_history_immutable() from authenticated;
grant execute on function public.recon_set(uuid[], uuid), public.counts_set(uuid[]), public.grade_eligibility(uuid[], uuid) to service_role;
-- browser-callable (each checks the caller's role itself)
grant execute on function public.grade_bands(), public.grading_sheet(uuid), public.grade_script(uuid, uuid, numeric, text),
  public.import_grades(uuid, jsonb, text), public.set_max_score(uuid, numeric), public.publish_results(uuid),
  public.unpublish_results(uuid, text), public.reopen_session(uuid, text), public.results_overview(),
  public.student_scoreboard(uuid), public.my_results(), public.script_grade_history(uuid),
  public.update_settings(jsonb), public.dashboard_stats(), public.current_alerts(boolean) to authenticated;

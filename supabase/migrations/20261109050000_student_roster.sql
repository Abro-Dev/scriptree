-- Student roster: add students on their own, not only as a side effect of importing exam candidates.
--
-- add_students(rows) is used by Admin → Users (one student, or a CSV of many) and by the exams office.
-- It only creates records. Sign-in accounts are still issued separately by an admin
-- (admin-users → issue_student_passwords), which returns one-time passwords to print.
--
-- A matric number already on record is left unchanged and reported as "existing" (its id is still
-- returned, so the caller can issue that student a password straight away).

create or replace function public.add_students(p_rows jsonb)
returns table (created int, existing int, skipped jsonb, ids uuid[])
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  r jsonb; v_matric text; v_code text; v_name text; v_dept text; v_level text; v_sid uuid; v_other text;
  v_created int := 0; v_existing int := 0; v_skipped jsonb := '[]'::jsonb; v_ids uuid[] := '{}';
begin
  perform public.require_role('admin', 'officer');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'Send at most 5000 rows'; end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_matric := upper(trim(coalesce(r ->> 'matric_no', '')));
    v_code   := upper(trim(coalesce(r ->> 'student_code', '')));
    v_name   := regexp_replace(trim(coalesce(r ->> 'full_name', '')), '\s+', ' ', 'g');
    v_dept   := trim(coalesce(r ->> 'department', ''));
    v_level  := upper(trim(coalesce(r ->> 'level', '')));

    if v_matric !~ '^[A-Z]{2,5}/[0-9]{2}/[0-9]{3,6}$' then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid matric number (e.g. CSC/21/1001)'); continue;
    end if;

    select id into v_sid from public.students where matric_no = v_matric;
    if v_sid is not null then
      v_existing := v_existing + 1; v_ids := v_ids || v_sid; continue;
    end if;

    if v_code !~ '^ST[0-9]{4,10}$' then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Invalid student ID (ST followed by 4–10 digits)'); continue;
    end if;
    if length(v_name) < 2 or length(v_name) > 120 then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Full name missing'); continue;
    end if;
    if v_dept = '' or length(v_dept) > 80 then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Department missing'); continue;
    end if;
    if v_level = '' or length(v_level) > 20 then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Level missing'); continue;
    end if;
    select matric_no into v_other from public.students where student_code = v_code;
    if v_other is not null then
      v_skipped := v_skipped || jsonb_build_object('matric_no', v_matric, 'reason', 'Student ID ' || v_code || ' already belongs to ' || v_other); continue;
    end if;

    insert into public.students (matric_no, student_code, full_name, department, level)
    values (v_matric, v_code, v_name, v_dept, v_level) returning id into v_sid;
    v_created := v_created + 1; v_ids := v_ids || v_sid;
  end loop;

  if v_created > 0 or jsonb_array_length(v_skipped) > 0 then
    perform public.audit('Add students', v_created || ' added'
      || case when v_existing > 0 then ', ' || v_existing || ' already on record' else '' end
      || case when jsonb_array_length(v_skipped) > 0 then ', ' || jsonb_array_length(v_skipped) || ' skipped' else '' end);
  end if;
  return query select v_created, v_existing, v_skipped, v_ids;
end $$;

revoke execute on function public.add_students(jsonb) from public, anon;
grant  execute on function public.add_students(jsonb) to authenticated;

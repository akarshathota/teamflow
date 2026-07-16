-- Closes three RLS gaps found in a fresh audit, all the same class of bug already fixed once in
-- 20260714000005_tighten_insert_checks.sql: a WITH CHECK/policy that only verified "is this a
-- real logged-in user" instead of the actual scope the app relies on client-side.

-- 1) staff_update's WITH CHECK (20260710000000_auth_and_rls.sql) only re-checks is_in_scope() on
-- the row's own id — which is always true for your own row regardless of what you set role/
-- boss_id/department to, since id doesn't change across an UPDATE. That means any signed-in
-- staff member (Teacher included) can run
--   sb.from('staff').update({role:'Administrator'}).eq('id', myOwnId)
-- from the browser console and immediately get org-wide access via is_in_scope's Administrator/
-- Management special-case (20260713000000_admin_role_scope.sql). RLS policies can't compare
-- OLD vs NEW columns directly (WITH CHECK only sees the proposed new row), so this needs a
-- trigger rather than a tighter policy expression.
create or replace function staff_prevent_self_escalation() returns trigger
language plpgsql security definer set search_path = public as $$
declare acting_role text;
begin
  select role into acting_role from staff where id = auth_staff_id();
  if acting_role in ('Administrator','Management') then
    return new; -- promoting/reassigning people is literally their job
  end if;
  if new.role is distinct from old.role
     or new.boss_id is distinct from old.boss_id
     or new.department is distinct from old.department then
    raise exception 'Only an Administrator or Management can change role, boss, or department';
  end if;
  return new;
end;
$$;
create trigger staff_prevent_self_escalation_trg before update on staff
  for each row execute function staff_prevent_self_escalation();

-- 2) staff_write (INSERT) has no role check at all — any authenticated client could insert a
-- staff row directly (role='Administrator', boss_id=null), bypassing the admin-only
-- create-staff-account Edge Function and its admin_activity_log audit trail entirely. The app
-- never inserts staff rows directly (it only calls that Edge Function, which uses the
-- service-role key and so isn't affected by tightening this policy).
drop policy staff_write on staff;
create policy staff_write on staff for insert
  with check (exists (select 1 from staff where id = auth_staff_id() and role in ('Administrator','Management')));

-- 3) log_insert (task_log) and task_activity_notif_insert (task_activity_notifications) both only
-- checked "is this a logged-in user" — neither tied the write to the task's real scope. Any
-- signed-in staff member could insert a task_log row on any task_id in the org (not just their
-- own), or insert a task_activity_notifications row with an arbitrary staff_id (recipient) and
-- actor_staff_id (attributed sender), spoofing who supposedly posted an update.
drop policy log_insert on task_log;
create policy log_insert on task_log for insert
  with check (task_in_scope(task_id, auth_staff_id()) and author_id = auth_staff_id());

drop policy task_activity_notif_insert on task_activity_notifications;
create policy task_activity_notif_insert on task_activity_notifications for insert
  with check (
    actor_staff_id = auth_staff_id()
    and exists (select 1 from task_assignees ta where ta.task_id = task_activity_notifications.task_id and ta.staff_id = auth_staff_id())
    and exists (select 1 from task_assignees ta where ta.task_id = task_activity_notifications.task_id and ta.staff_id = task_activity_notifications.staff_id)
  );

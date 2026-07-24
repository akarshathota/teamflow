-- Security fix (/cso informational finding): server-enforce task-deletion authority.
--
-- The old policy was `for delete using (task_in_scope(id, auth_staff_id()))` — any user whose
-- SCOPE covers a task's assignees (i.e. anyone at/above them in the hierarchy) could DELETE it via a
-- direct /rest/v1/tasks?id=eq.<id> DELETE, regardless of the client's canDeleteTask gate. The client
-- (shared.js) restricts the Delete button to Administrators plus any role explicitly granted delete
-- rights for that department in org_settings.task_permissions (default: admin-only). Nothing enforced
-- that server-side. This makes the DB agree with the client so the button being hidden actually means
-- the action is refused.
--
-- can_delete_task() mirrors shared.js canDeleteTask(t,roleKey) exactly:
--   admin (role='Administrator')  -> always
--   otherwise                     -> caller's role-key must be in
--                                    org_settings.task_permissions[<task's department label>].delete
-- The tasks.department column already stores the department LABEL (the client saves it as
-- BUCKETS[t.bucket]||t.bucket, which is exactly what taskDeptLabel(t) yields for built-in AND custom
-- departments), and task_permissions is keyed by that same label — so we key directly off
-- t.department, no slug mapping needed. Role-key mapping is DB_ROLE_TO_KEY from shared.js. security
-- definer because it reads org_settings + the task row past the caller's own RLS. Scope is still
-- required on top (a delegated role can only delete tasks already in its scope) — the client only ever
-- surfaces in-scope tasks, so this matches the UI.
create or replace function can_delete_task(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when s.role = 'Administrator' then true
    else coalesce(
      (os.task_permissions -> t.department -> 'delete')
      ? (case s.role
           when 'Management'  then 'mgmt'
           when 'Director'    then 'dir'
           when 'Manager'     then 'srm'
           when 'Team Lead'   then 'lead'
           when 'Team Member' then 'jrm'
           when 'Teacher'     then 'worker'
           else s.role end),
      false)
  end
  from tasks t
  cross join (select role from staff where id = auth_staff_id()) s
  left join org_settings os on os.id = true
  where t.id = tid;
$$;

drop policy tasks_delete on tasks;
create policy tasks_delete on tasks for delete
  using (task_in_scope(id, auth_staff_id()) and can_delete_task(id));

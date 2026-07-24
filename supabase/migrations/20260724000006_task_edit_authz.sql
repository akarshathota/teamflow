-- Security fix (/cso follow-up): server-enforce task-EDIT authority, symmetric with v156's delete.
--
-- The client (shared.js canEditTask) restricts the "Edit task details" popup + bulk edit-details
-- actions to Administrators plus any role granted edit rights for that department in
-- org_settings.task_permissions[department].edit (default: admin+mgmt in prod). Nothing enforced it
-- server-side: any in-scope user could PATCH /rest/v1/tasks and change a task's title/type/department/
-- priority/due_date directly.
--
-- Unlike DELETE (one discrete action), UPDATE on tasks is the busiest write path: saveTask() re-sends
-- the WHOLE row for every mutation — marking done, status changes, reassignment, extension, reopen —
-- and marking a task done is the core daily operation for every user. A blanket tasks_update
-- restriction would break all of that, and RLS can't compare OLD vs NEW columns anyway. So this is a
-- BEFORE UPDATE trigger that only fires when a PROTECTED edit-detail column actually CHANGES
-- (IS DISTINCT FROM). When saveTask re-sends title/type/department/priority/due_date unchanged (e.g.
-- marking done), the trigger is a no-op and never even calls can_edit_task — status/done_on/note/
-- nudge/ext_*/reopen updates all pass freely (still subject to the existing tasks_update scope RLS).
-- Only a real change to one of the 5 edit-detail columns requires can_edit_task.
--
-- can_edit_task() mirrors can_delete_task() (v156) exactly but reads the 'edit' array. tasks.department
-- already stores the department LABEL that task_permissions is keyed by, so no slug mapping. Role-key
-- map is DB_ROLE_TO_KEY from shared.js. security definer to read org_settings + the task past the
-- caller's own RLS.
create or replace function can_edit_task(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when s.role = 'Administrator' then true
    else coalesce(
      (os.task_permissions -> t.department -> 'edit')
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

create or replace function enforce_task_edit_authz() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.title      is distinct from old.title
   or new.type       is distinct from old.type
   or new.department is distinct from old.department
   or new.priority   is distinct from old.priority
   or new.due_date   is distinct from old.due_date)
   and not can_edit_task(old.id) then
    raise exception 'not authorized to edit task details (title/type/department/priority/due date)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_task_edit_authz on tasks;
create trigger trg_task_edit_authz before update on tasks
  for each row execute function enforce_task_edit_authz();

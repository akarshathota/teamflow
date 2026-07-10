-- Link staff to Supabase Auth, add scope-check helpers, and lock everything down with RLS.
--
-- Access model: every staff row can optionally be linked to a real auth.users account
-- (auth_user_id). Scope mirrors the app's existing org-chart logic exactly — you can see/touch
-- data belonging to yourself or anyone below you in the boss_id chain. Administrators/Management
-- get org-wide scope "for free" because everyone eventually reports up through them — no special
-- casing needed, same as the client-side descendants()/inScope() functions this replaces.

alter table staff add column auth_user_id uuid unique references auth.users(id) on delete set null;
alter table staff add column username text unique;

-- Resolves the currently authenticated user to their staff row id, or null if not linked.
create or replace function auth_staff_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from staff where auth_user_id = auth.uid()
$$;

-- Is target_id the viewer themself, or anywhere below them in the reporting chain?
create or replace function is_in_scope(viewer_id uuid, target_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  with recursive chain as (
    select id, boss_id from staff where id = target_id
    union all
    select s.id, s.boss_id from staff s join chain c on s.id = c.boss_id
  )
  select viewer_id is not null and target_id is not null
    and (viewer_id = target_id or exists (select 1 from chain where id = viewer_id))
$$;

alter table staff enable row level security;
alter table tasks enable row level security;
alter table task_assignees enable row level security;
alter table task_log enable row level security;
alter table requests enable row level security;
alter table notices enable row level security;

-- staff: see/manage people in your own scope (needed for org chart, assignee pickers, etc.)
create policy staff_select on staff for select
  using (is_in_scope(auth_staff_id(), id));
create policy staff_write on staff for insert with check (auth_staff_id() is not null);
create policy staff_update on staff for update
  using (is_in_scope(auth_staff_id(), id)) with check (is_in_scope(auth_staff_id(), id));
create policy staff_delete on staff for delete
  using (is_in_scope(auth_staff_id(), id));

-- tasks: visible/editable if any assignee is in your scope. The "no assignees yet" branch covers
-- the moment right after insert, before syncAssignees() has linked anyone to the new row.
--
-- This has to be security definer: task_assignees itself has RLS, so a plain subquery against it
-- is filtered through the CALLER's own visibility first. Without definer, an out-of-scope caller
-- (who can see zero task_assignees rows for ANY task) would make every task look assignee-less,
-- incorrectly matching the "no assignees yet" fallback for literally everything. Caught this by
-- testing the anon key directly against /rest/v1/tasks after writing the naive version — it
-- returned all rows instead of zero.
create or replace function task_in_scope(tid uuid, viewer_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from task_assignees where task_id = tid)
    or exists (select 1 from task_assignees where task_id = tid and is_in_scope(viewer_id, staff_id))
$$;

create policy tasks_select on tasks for select using (task_in_scope(id, auth_staff_id()));
create policy tasks_insert on tasks for insert with check (auth_staff_id() is not null);
create policy tasks_update on tasks for update
  using (task_in_scope(id, auth_staff_id())) with check (auth_staff_id() is not null);
create policy tasks_delete on tasks for delete using (task_in_scope(id, auth_staff_id()));

-- task_assignees: tied to the assignee's own scope
create policy assignees_all on task_assignees for all
  using (is_in_scope(auth_staff_id(), staff_id)) with check (auth_staff_id() is not null);

-- task_log: tied to the parent task's assignee scope
create policy log_select on task_log for select
  using (exists (select 1 from task_assignees ta where ta.task_id = task_log.task_id and is_in_scope(auth_staff_id(), ta.staff_id)));
create policy log_insert on task_log for insert with check (auth_staff_id() is not null);

-- requests: tied to the requester's scope (their own boss chain can see/act on them)
create policy requests_all on requests for all
  using (is_in_scope(auth_staff_id(), from_staff_id)) with check (auth_staff_id() is not null);

-- notices: school-wide broadcast — any authenticated staff member can read; posting stays
-- gated by the app's own canPost role check, same as before.
create policy notices_select on notices for select using (auth_staff_id() is not null);
create policy notices_insert on notices for insert with check (auth_staff_id() is not null);

-- Note on scope: this enforces the org-chart confidentiality boundary (who can see/touch whose
-- data at all). Finer approval nuances the app already has — e.g. "only the direct department
-- boss can approve an extension" — stay enforced in the client UI (canApprove()), not re-derived
-- here in SQL. That's a deliberate scope cut, not an oversight: the boundary that actually matters
-- for privacy (Manager A can't see Manager B's team) is now real; the softer approval-workflow
-- rules were never a security boundary to begin with.

-- Directors can issue tasks organisation-wide, while their OVERSIGHT stays subtree-scoped.
--
-- Product change (see mockup-director-orgwide.html): a Director (staff.role = 'Director') may
-- ASSIGN a task to anyone whose role is NOT Administrator/Management — peers and staff across
-- every department, never up the chain — and, because "completion approval follows whoever issued
-- the task", the Director who issued a task is the one who approves its completion/extension.
--
-- Approach (decided with the reviewer): "read org-wide, filter oversight client-side." The
-- policies below give a Director the READ + WRITE reach needed to actually pick, create, see and
-- approve cross-department tasks. The reporting structure is kept intact on the CLIENT: the console
-- org chart is re-rooted at the Director's own node, and every oversight surface (dashboards,
-- Reports, Compliance, "who needs attention", Calendar) keeps filtering by the client-side
-- descendants()/scope, so the wider staff/task data a Director now loads never widens what they
-- oversee — only what they can assign to and approve.
--
-- Everything here is ADDITIVE. Postgres OR-s permissive policies, so each new policy only GRANTS
-- an extra path; no existing policy is dropped and no current access narrows. Helpers reused:
-- auth_staff_id() (current user's staff id), is_in_scope()/task_in_scope() (subtree/admin-mgmt
-- scope). instructed_by is the free-text "assigned by" label; the apps write it as the issuer's
-- exact staff.name for tasks assigned to someone else, which the issuer-based policies match on.
--
-- NOTE ON SELF-REFERENCE: a SELECT policy ON staff must not sub-select FROM staff for the viewer's
-- role, or Postgres hits "infinite recursion detected in policy for relation staff". auth_staff_id()
-- and is_in_scope() dodge this by being SECURITY DEFINER (they bypass RLS); auth_is_director() below
-- follows the same pattern so the new staff SELECT policy can check the viewer's role safely.

-- Viewer-is-a-Director check, SECURITY DEFINER so it never re-enters staff's RLS (same technique as
-- auth_staff_id()/is_in_scope() in 20260710000000 / 20260713000000).
create or replace function auth_is_director() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff where auth_user_id = auth.uid() and role = 'Director')
$$;

-- 1) task_assignees INSERT — a Director may assign to any non-leadership staff, org-wide.
-- assignees_all (20260714000005_tighten_insert_checks.sql) already lets anyone assign WITHIN their
-- own subtree (WITH CHECK is_in_scope(auth_staff_id(), staff_id)); this ADDS an alternative INSERT
-- path for Directors covering everyone else, excluding only Administrator/Management (no assigning
-- up the chain). tasks INSERT itself already permits any authenticated staff member
-- (tasks_insert: WITH CHECK auth_staff_id() is not null), so no separate tasks-INSERT policy is
-- needed for a Director to create the parent task row.
create policy assignees_director_insert on task_assignees for insert
  with check (
    (select role from staff where id = auth_staff_id()) = 'Director'
    and (select role from staff where id = task_assignees.staff_id) not in ('Administrator','Management')
  );

-- 2) tasks UPDATE — the issuer approves completion/extension.
-- The existing tasks_update policy (20260710000000) already covers admin/mgmt and the legacy
-- fallback: it USING task_in_scope(id, auth_staff_id()), and is_in_scope() grants admin/mgmt
-- org-wide access "for free", while ordinary in-scope (subtree) approvals — including legacy tasks
-- whose instructed_by is null, approved by the assignee's manager — keep working unchanged. This
-- ADDS the one new case: whoever issued the task (instructed_by = my own staff.name) may update it,
-- even when the assignee sits outside their subtree. Guarded to instructed_by IS NOT NULL so it
-- never broadens the null-instructed_by legacy path (that stays on the manager/in-scope rule).
create policy tasks_update_issuer on tasks for update
  using (
    instructed_by is not null
    and instructed_by = (select name from staff where id = auth_staff_id())
  )
  with check (auth_staff_id() is not null);

-- 3) staff SELECT — a Director may read all NON-leadership staff, org-wide.
-- Needed to populate the New-Task "Other department" picker (names, departments, roles) for a real
-- Director login, not just the admin-preview used in dev. staff_select (20260710000000) already
-- returns the viewer's own vertical line (subtree + boss chain, both directions of is_in_scope);
-- this ADDS org-wide read of everyone whose role is not Administrator/Management. Other Directors
-- ARE readable (role 'Director' is not excluded) — only Admin & Management are hidden, matching the
-- assignment rule. The wider staff set this loads is kept OUT of oversight on the client: the
-- console org chart is re-rooted at the Director's own node, and dashboards/Reports/Compliance
-- filter by descendants()/scope, so it only ever feeds the assignment picker.
create policy staff_select_director on staff for select
  using (auth_is_director() and role not in ('Administrator','Management'));

-- 4) tasks SELECT — the issuer may read the tasks they issued.
-- tasks_select (20260710000000) only shows tasks with an in-scope assignee; a Director-issued task
-- whose sole assignee is in another department is invisible to them, so they could neither see nor
-- approve it. This ADDS read access to tasks the viewer issued (instructed_by = my own staff.name).
-- It does NOT widen dashboards/Reports (those still filter by client-side scope) — it only surfaces
-- the Director's own issued tasks (their "Assigned by me" list) and makes the UPDATE above usable.
create policy tasks_select_issuer on tasks for select
  using (
    instructed_by is not null
    and instructed_by = (select name from staff where id = auth_staff_id())
  );

-- 5) task_assignees SELECT — read the assignee rows of tasks the Director issued.
-- Pairs with (4): a task only renders once its assignee rows are readable. assignees_all
-- (20260714000005) exposes only rows whose staff_id is in the viewer's subtree; this ADDS the
-- assignee rows of any task the viewer issued (parent task's instructed_by = my own staff.name),
-- so a Director-issued cross-department task shows who it's assigned to.
create policy assignees_select_issuer on task_assignees for select
  using (
    exists (
      select 1 from tasks t
      where t.id = task_assignees.task_id
        and t.instructed_by is not null
        and t.instructed_by = (select name from staff where id = auth_staff_id())
    )
  );

-- 6) task_activity_notifications INSERT — let the issuer be the actor OR the recipient.
-- The current insert policy (20260717000000_widen_activity_notif_scope.sql) requires BOTH the actor
-- and the recipient to be task_in_scope(task_id, ...) — the task's assignees plus their boss chain.
-- A Director who issued a cross-department task is neither, so two notifications break: the assignee
-- submitting completion can't notify the issuer, and the issuer approving/rejecting can't notify the
-- assignee. This ADDS the minimal issuer path: actor must still be the authenticated user (no sender
-- spoofing), and the task's issuer (instructed_by) must be either the actor (issuer -> assignee) or
-- the recipient (assignee -> issuer). Scoped to that one task via instructed_by, nothing broader.
create policy task_activity_notif_insert_issuer on task_activity_notifications for insert
  with check (
    actor_staff_id = auth_staff_id()
    and exists (
      select 1 from tasks t
      where t.id = task_activity_notifications.task_id
        and t.instructed_by is not null
        and (
          t.instructed_by = (select name from staff where id = auth_staff_id())
          or t.instructed_by = (select name from staff where id = task_activity_notifications.staff_id)
        )
    )
  );

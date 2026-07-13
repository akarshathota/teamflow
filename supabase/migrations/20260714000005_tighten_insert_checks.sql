-- Tighten INSERT-time checks that had drifted looser than their own USING clause.
--
-- Postgres only evaluates a policy's USING clause for SELECT/UPDATE/DELETE (and the "existing
-- row" half of UPDATE) — it never runs USING on INSERT, only WITH CHECK. assignees_all and
-- requests_all (20260710000000_auth_and_rls.sql) scope USING to is_in_scope(...) but left
-- WITH CHECK at the much weaker "any authenticated staff member", so any logged-in user could
-- INSERT a task_assignees row naming a staff_id/task_id outside their scope. Since tasks_select
-- grants visibility to anyone who appears as an assignee, that let an out-of-scope user
-- self-assign to a task and read its full contents. Same gap on requests let anyone insert a
-- request/issue row with from_staff_id set to a coworker who never filed it. Dropping and
-- recreating each policy (rather than trying to ALTER just the WITH CHECK clause) to match how
-- earlier migrations in this repo handle policy changes.
drop policy assignees_all on task_assignees;
create policy assignees_all on task_assignees for all
  using (is_in_scope(auth_staff_id(), staff_id))
  with check (is_in_scope(auth_staff_id(), staff_id));

drop policy requests_all on requests;
create policy requests_all on requests for all
  using (is_in_scope(auth_staff_id(), from_staff_id))
  with check (is_in_scope(auth_staff_id(), from_staff_id));

-- notices_insert previously only checked auth_staff_id() is not null, relying entirely on the
-- client (mobile's ROLES.canPost) to keep Teachers from posting school-wide broadcasts — that's
-- a client-side-only restriction with no database backing, so a direct API call from a Teacher
-- account could post anyway. Mobile's ROLES (2026-07-06-teamflow-mobile-react.html) sets
-- canPost:false only for the 'worker' role, which DB_ROLE_TO_KEY (shared.js) maps from
-- staff.role = 'Teacher'; every other role (Administrator, Management, Manager, Team Lead,
-- Team Member) has canPost:true. Mirror that same cut server-side.
drop policy notices_insert on notices;
create policy notices_insert on notices for insert
  with check (exists (select 1 from staff where id = auth_staff_id() and role <> 'Teacher'));

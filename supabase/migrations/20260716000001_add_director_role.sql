-- Adds 'Director' as a new tier between Management and Manager (Sr. Manager) — oversees several
-- Sr. Managers' departments at once. Same reasoning as 20260714000000_org_chart_roles.sql's Team
-- Lead addition: is_in_scope()/descendants()/task_in_scope() are already generic boss_id
-- tree-walks with no role-order assumption, so this needs no RLS change — only the CHECK
-- constraint moves. A Director's scope is computed exactly like any non-admin/mgmt role already
-- is: themselves + everyone in their subtree (the Sr. Managers who report to them, and everyone
-- under those Sr. Managers).
alter table staff drop constraint staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('Administrator','Management','Director','Manager','Team Lead','Team Member','Teacher'));

-- Per-department supply APPROVER + a master ON/OFF toggle for the whole supply-request feature.
--
-- Builds ADDITIVELY on the live v100 supply flow (20260721000003_routing_config.sql). Nothing here
-- drops or replaces existing policies; every statement is create-if-not-exists / add-column /
-- additive-policy so it is safe to run once on top of the current schema.
--
-- WHAT CHANGES
--   1) Supply approval was fixed to the requester's department Sr. Manager (resolved dynamically by
--      the requests_dept_manager_select/update RLS policies). The Administrator can now configure, per
--      department, WHICH staff member approves that department's supply requests. Config lives in the
--      existing routing_rules table as rows with kind='supply_approver', label=<department name>,
--      target_staff_id=<the approver>. No new policy is needed — routing_rules_select/insert/update/
--      delete already cover the whole table (all staff read; Administrator writes).
--   2) requests gains approver_staff_id — the resolved stage-1 approver, STORED on the request at
--      creation (the app resolves it from the supply_approver rule for the requester's department,
--      falling back to the dept Sr. Manager when a department has no rule/target). A new additive RLS
--      pair lets that stored approver SELECT + UPDATE the request so they can approve it.
--   3) org_settings gains supply_requests_enabled (default true) — a master switch. When false the app
--      hides the "Request supplies" tab everywhere; this column is purely a UI feature flag.
--
-- FALLBACK / SAFETY: the existing requests_dept_manager_select/update policies are DELIBERATELY KEPT.
-- They remain the fallback approval path for any department with no configured approver (approver_staff_id
-- null), so nothing breaks for departments the Admin hasn't configured yet, and for any legacy request
-- created before this migration.

-- ---------------------------------------------------------------------------------------------------
-- 1) Master toggle on the single-row org_settings table
-- ---------------------------------------------------------------------------------------------------
alter table org_settings add column if not exists supply_requests_enabled boolean not null default true;

-- Live-propagate toggle changes to every open app (org_settings was not previously published for
-- realtime; the clients subscribe to it for the org name + this flag). Guarded so re-running is safe.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'org_settings'
  ) then
    alter publication supabase_realtime add table org_settings;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------------
-- 2) requests.approver_staff_id — the resolved stage-1 approver, stamped at creation
-- ---------------------------------------------------------------------------------------------------
alter table requests add column if not exists approver_staff_id uuid references staff(id);
create index if not exists requests_approver_staff_idx on requests (approver_staff_id);

-- ---------------------------------------------------------------------------------------------------
-- 2b) Widen routing_rules.kind to allow the new 'supply_approver' rows
-- ---------------------------------------------------------------------------------------------------
-- routing_rules (20260721000003) constrained kind to ('maintenance','supply'). This migration adds a
-- third kind for the per-department supply approver, so the check constraint must be widened first or
-- the seed below fails. Drop-and-recreate (idempotent via IF EXISTS) rather than trying to ALTER it.
alter table routing_rules drop constraint if exists routing_rules_kind_check;
alter table routing_rules add constraint routing_rules_kind_check
  check (kind in ('maintenance','supply','supply_approver'));

-- ---------------------------------------------------------------------------------------------------
-- 3) Seed one supply_approver rule per distinct department, resolved to that dept's Manager
-- ---------------------------------------------------------------------------------------------------
-- Initial behaviour matches today: each department's configured approver starts as its Manager
-- (role='Manager'). Departments with no Manager get a row with a null target (the app then falls back
-- to the dept Sr. Manager path anyway). Skips any department that somehow already has a supply_approver
-- row so re-running does not duplicate.
insert into routing_rules (kind, label, icon, target_staff_id, sort_order)
select 'supply_approver',
       d.department,
       null,
       (select s.id from staff s
         where s.role = 'Manager' and s.department = d.department
         order by s.name limit 1),
       0
from (select distinct department from staff where department is not null) d
where not exists (
  select 1 from routing_rules rr
  where rr.kind = 'supply_approver' and rr.label = d.department
);

-- ---------------------------------------------------------------------------------------------------
-- 4) Additive RLS on requests: the stored/configured approver may SELECT + UPDATE their requests
-- ---------------------------------------------------------------------------------------------------
-- Postgres OR-s permissive policies, so these only GRANT an extra path on top of requests_all and the
-- (kept) requests_dept_manager_* fallback. Guarded to kind='request' so maintenance issues are never
-- widened. WITH CHECK on the update only requires an authenticated staff member (mirrors the existing
-- requests_dept_manager_update / requests_recipient_update style) so the approver can write the
-- stage/target change without being pinned out of their own row.
create policy requests_approver_select on requests for select
  using (
    kind = 'request'
    and approver_staff_id is not null
    and approver_staff_id = auth_staff_id()
  );

create policy requests_approver_update on requests for update
  using (
    kind = 'request'
    and approver_staff_id is not null
    and approver_staff_id = auth_staff_id()
  )
  with check (auth_staff_id() is not null);

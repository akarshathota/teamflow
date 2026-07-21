-- Admin-configurable, recipient-based routing for repair/maintenance reports AND supply requests.
--
-- REPLACES the earlier (never-applied) dept-head approach, which hardcoded Building -> Maintenance
-- head and IT -> IT head by resolving the Manager of a `target_dept` string. The Administrator now
-- configures, in a Settings screen, exactly WHICH staff member receives each kind of report/request
-- — the recipient is any staff member, not derived from a department. Two moving parts:
--
--   1) routing_rules — the config itself. Maintenance categories are rows with kind='maintenance'
--      (seeded Building 🏢 + IT 💻); the single org-wide supply recipient is one row kind='supply'.
--      Every authenticated staff member may SELECT (needed to render the category chooser and resolve
--      who a report/request goes to); only an Administrator may INSERT/UPDATE/DELETE. On realtime so
--      config edits propagate live to every open app.
--
--   2) requests gains: target_staff_id (the resolved recipient — the access key RLS gates on),
--      routing_rule_id (the chosen maintenance category, so the client can live-re-resolve the
--      recipient if the config later changes), and stage (the supply two-stage: 'pending' Sr.-Manager
--      approval -> 'approved' routed to the supply recipient). Issues carry stage = null.
--
-- Supply requests are now two-stage: a request first goes to the Sr. Manager of the REQUESTER's
-- department (role='Manager' AND same department) to approve/decline; on approval it routes to the
-- single configured supply recipient (routing_rules kind='supply') to fulfil.
--
-- Everything here is ADDITIVE. requests_all (20260714000005_tighten_insert_checks.sql) is NOT
-- dropped: Administrator/Management keep org-wide access and the requester's own boss chain keeps
-- its access. Postgres OR-s permissive policies, so each policy below only GRANTS an extra path:
--   (a) the resolved recipient (target_staff_id = me, OR the current recipient of the report's
--       category, OR — for legacy issues with neither — the default 'Building'/first maintenance
--       category's recipient) may SELECT + UPDATE the rows routed to them;
--   (b) the requester's department Sr. Manager may SELECT + UPDATE that department's supply requests
--       (the approval path).
-- auth_staff_id() (current user's staff id) and the role checks reuse the repo's existing helpers.

-- ---------------------------------------------------------------------------------------------------
-- 1) routing_rules: the admin-editable config
-- ---------------------------------------------------------------------------------------------------
create table routing_rules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('maintenance','supply')),
  label text not null,
  icon text,                                            -- emoji, maintenance categories only
  target_staff_id uuid references staff(id) on delete set null,  -- the recipient; null if unresolved
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index routing_rules_kind_idx on routing_rules (kind);

-- Seed defaults by resolving the Manager of the relevant department at seed time. If a department
-- has no Manager yet, the recipient is left null (the app then falls back to admin/mgmt visibility)
-- rather than pointing at nobody or erroring.
insert into routing_rules (kind,label,icon,target_staff_id,sort_order) values
  ('maintenance','Building Maintenance','🏢',
     (select id from staff where role='Manager' and department='Maintenance'   order by name limit 1), 0),
  ('maintenance','IT Maintenance','💻',
     (select id from staff where role='Manager' and department='IT & Systems'  order by name limit 1), 1),
  ('supply','Approved supply requests',null,
     (select id from staff where role='Manager' and department='Accounts'      order by name limit 1), 0);

alter table routing_rules enable row level security;

-- Every authenticated staff member can read the config (needed to render categories + resolve
-- recipients on both the reporting and receiving sides).
create policy routing_rules_select on routing_rules for select
  using (auth_staff_id() is not null);

-- Only an Administrator may change the config.
create policy routing_rules_insert on routing_rules for insert
  with check (exists (select 1 from staff where id = auth_staff_id() and role = 'Administrator'));
create policy routing_rules_update on routing_rules for update
  using (exists (select 1 from staff where id = auth_staff_id() and role = 'Administrator'))
  with check (exists (select 1 from staff where id = auth_staff_id() and role = 'Administrator'));
create policy routing_rules_delete on routing_rules for delete
  using (exists (select 1 from staff where id = auth_staff_id() and role = 'Administrator'));

-- Live-propagate config edits to every open app, same as every other synced table.
alter publication supabase_realtime add table routing_rules;

-- ---------------------------------------------------------------------------------------------------
-- 2) requests: resolved recipient + chosen category + supply stage
-- ---------------------------------------------------------------------------------------------------
alter table requests add column if not exists target_staff_id uuid references staff(id);
alter table requests add column if not exists routing_rule_id  uuid references routing_rules(id);
alter table requests add column if not exists stage text check (stage in ('pending','approved'));

create index if not exists requests_target_staff_idx on requests (target_staff_id);

-- ---------------------------------------------------------------------------------------------------
-- 3) Additive RLS on requests
-- ---------------------------------------------------------------------------------------------------

-- (a) The resolved recipient may SELECT the rows routed to them. Three ways a row resolves to "me":
--   • target_staff_id = me                          — the stored snapshot recipient (issues + approved supply)
--   • the report's category currently points at me  — so re-configuring a category re-routes existing reports
--   • legacy issue (no target_staff_id, no category) — defaults to the first maintenance category's recipient,
--     so pre-feature reports (and reports filed by someone ABOVE the recipient) still land, never strand.
create policy requests_recipient_select on requests for select
  using (
    target_staff_id = auth_staff_id()
    or exists (
      select 1 from routing_rules rr
      where rr.id = requests.routing_rule_id and rr.target_staff_id = auth_staff_id()
    )
    or (
      requests.kind = 'issue'
      and requests.target_staff_id is null
      and requests.routing_rule_id is null
      and exists (
        select 1 from routing_rules rr
        where rr.kind = 'maintenance' and rr.target_staff_id = auth_staff_id()
          and rr.sort_order = (select min(sort_order) from routing_rules where kind = 'maintenance')
      )
    )
  );

-- (a') The resolved recipient may UPDATE the rows routed to them (assign the fixer / mark fulfilled /
-- move a supply request's stage). Same predicate as the SELECT above; WITH CHECK only requires the
-- caller be an authenticated staff member (mirrors requests_all's own WITH CHECK style) so the
-- recipient can write stage/target changes without being pinned out of their own row.
create policy requests_recipient_update on requests for update
  using (
    target_staff_id = auth_staff_id()
    or exists (
      select 1 from routing_rules rr
      where rr.id = requests.routing_rule_id and rr.target_staff_id = auth_staff_id()
    )
    or (
      requests.kind = 'issue'
      and requests.target_staff_id is null
      and requests.routing_rule_id is null
      and exists (
        select 1 from routing_rules rr
        where rr.kind = 'maintenance' and rr.target_staff_id = auth_staff_id()
          and rr.sort_order = (select min(sort_order) from routing_rules where kind = 'maintenance')
      )
    )
  )
  with check (auth_staff_id() is not null);

-- (b) The requester's department Sr. Manager (role='Manager' AND same department as the requester)
-- may SELECT + UPDATE that department's SUPPLY requests — the two-stage approval path. Guarded to
-- kind='request' so it never widens visibility of maintenance issues.
create policy requests_dept_manager_select on requests for select
  using (
    kind = 'request'
    and exists (
      select 1 from staff me, staff req
      where me.id = auth_staff_id()
        and me.role = 'Manager'
        and req.id = requests.from_staff_id
        and req.department = me.department
    )
  );

create policy requests_dept_manager_update on requests for update
  using (
    kind = 'request'
    and exists (
      select 1 from staff me, staff req
      where me.id = auth_staff_id()
        and me.role = 'Manager'
        and req.id = requests.from_staff_id
        and req.department = me.department
    )
  )
  with check (auth_staff_id() is not null);

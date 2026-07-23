-- Removable built-in departments. org_settings.hidden_departments = jsonb array of built-in
-- department labels the org removed in Settings › Departments. On load the department map is rebuilt
-- from the built-in snapshot MINUS these (shared.js applyDeptConfig), so a removed built-in can be
-- restored by adding it back. Additive + idempotent; applied to prod 2026-07-23.
alter table org_settings add column if not exists hidden_departments jsonb not null default '[]'::jsonb;

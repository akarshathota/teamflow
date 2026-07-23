-- Org-configurable departments. org_settings.departments = jsonb array of custom department labels
-- an Administrator adds in Settings › Departments. Merged into the built-in BUCKETS map at load
-- (client-side, see shared.js applyCustomDepts). Additive + idempotent; applied to prod 2026-07-23.
alter table org_settings add column if not exists departments jsonb not null default '[]'::jsonb;

-- Per-department task edit/delete permissions (v122).
-- org_settings.task_permissions jsonb = { "<department label>": { "edit":["mgmt",...], "delete":["mgmt",...] } }
-- where the arrays hold role KEYS (mgmt/dir/srm/lead/jrm/worker) — never 'admin', who is always allowed.
-- A department with no entry ⇒ Administrator-only for BOTH edit and delete (this intentionally tightens
-- the previous v121/v122 gate where Management could edit any unconfigured task).
-- Additive + idempotent. Writes are Administrator-only via the existing org_settings RLS.
alter table org_settings add column if not exists task_permissions jsonb not null default '{}'::jsonb;

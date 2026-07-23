-- Custom role titles (aliases) — display-only.
-- Adds a per-person chosen title (staff.title) and an org-wide pool of alternative names per
-- role (org_settings.role_titles). Purely a display label: the DB `role` and all
-- permissions/routing/scope/approvals are unchanged.
-- Additive + idempotent (safe to re-run). No drops/renames of existing data.

-- Per-person chosen title. NULL = fall back to the role's default label.
alter table public.staff
  add column if not exists title text;

-- Shared alias pool per role: { "<DB role>": ["Alias1","Alias2", …] } (default label NOT included).
alter table public.org_settings
  add column if not exists role_titles jsonb not null default '{}'::jsonb;

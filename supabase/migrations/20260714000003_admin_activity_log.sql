-- Audit trail for the four admin-only Edge Functions (create-staff-account, delete-staff-account,
-- reset-staff-password, update-staff-login), which currently leave no record of who did what to
-- whom. Each function inserts one row here on success, using its existing service_role client
-- (same client verifyAdmin() already hands back), capturing the caller resolved by verifyAdmin and
-- the staff member the action targeted.

create table admin_activity_log (
  id uuid primary key default gen_random_uuid(),
  actor_staff_id uuid references staff(id) on delete set null,
  action text not null,
  target_staff_id uuid references staff(id) on delete set null,
  target_name text,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index admin_activity_log_created_idx on admin_activity_log (created_at desc);

alter table admin_activity_log enable row level security;

-- Only Administrator/Management can read it — mirrors the ADMIN_TIER check the Edge Functions
-- themselves use (see supabase/functions/_shared/helpers.ts). No insert policy for authenticated
-- users on purpose: rows are only ever written by the four admin Edge Functions via the
-- service_role key, which bypasses RLS entirely — same pattern as task_notifications.
create policy admin_activity_log_select on admin_activity_log for select
  using (exists (select 1 from staff where id = auth_staff_id() and role in ('Administrator','Management')));

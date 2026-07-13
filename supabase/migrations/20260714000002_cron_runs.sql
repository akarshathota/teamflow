-- Low-effort "is the daily cron actually running?" health signal for Akarsh, without needing to
-- check Supabase function logs.
--
-- Considered the simpler no-new-table option first (surface the latest task_notifications.created_at
-- the admin can already see) but rejected it: task_notifications' RLS is `staff_id = auth_staff_id()`
-- with no admin/mgmt bypass (see 20260713000002_task_notifications.sql — "Only the recipient can see
-- or mark their own notifications read"), and it's populated per-assignee, not per-admin. On any day
-- with zero flagged tasks assigned to the admin's own staff row specifically (the common case — an
-- Administrator/Management account rarely has overdue tasks of their own), that signal would be
-- empty even though the cron ran fine and correctly found nothing to flag. That's indistinguishable
-- from the cron not running at all, which defeats the purpose. A dedicated row-per-run table doesn't
-- have that blind spot.

create table cron_runs (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  overdue_count int not null default 0,
  due_today_count int not null default 0,
  notified_count int not null default 0
);

alter table cron_runs enable row level security;

-- Same visibility tier as admin_activity_log: only Administrator/Management should see operational
-- internals. No insert policy for authenticated users — check-due-tasks writes this with the
-- service_role key (bypasses RLS), same pattern as task_notifications.
create policy cron_runs_select on cron_runs for select
  using (exists (select 1 from staff where id = auth_staff_id() and role in ('Administrator','Management')));

-- Per-assignee in-app notifications for overdue/due-today tasks, populated by the check-due-tasks
-- cron job. Kept separate from `notices` (school-wide broadcast, everyone can read) since these are
-- targeted at a single recipient and track individual read state.
--
-- unique(staff_id, task_id, kind, for_date) makes the daily cron upsert idempotent: re-running the
-- same day for a still-overdue task does nothing (already inserted), and a task that's overdue for
-- 5 days gets exactly one 'overdue' row per day, not one that grows stale from day 1.

create table task_notifications (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  kind text not null check (kind in ('overdue','due_today')),
  for_date date not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (staff_id, task_id, kind, for_date)
);

alter table task_notifications enable row level security;

-- Only the recipient can see or mark their own notifications read. No insert/delete policy for
-- authenticated users on purpose — rows are only ever written by the check-due-tasks Edge
-- Function, which uses the service_role key and bypasses RLS entirely.
create policy notif_select on task_notifications for select using (staff_id = auth_staff_id());
create policy notif_update on task_notifications for update
  using (staff_id = auth_staff_id()) with check (staff_id = auth_staff_id());

alter publication supabase_realtime add table task_notifications;

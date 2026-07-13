-- Per-recipient in-app notifications for job-log ("Activity") entries: when someone adds a
-- task_log row, every OTHER assignee of that task gets one notification for it.
--
-- Deliberately NOT folded into task_notifications: that table's `kind` CHECK
-- ('overdue','due_today') and unique(staff_id, task_id, kind, for_date) constraint exist
-- specifically for the check-due-tasks cron job's once-per-day-per-task upsert dedup. Activity
-- notifications are a different shape (one row per log entry per recipient, no day-based dedup —
-- a task legitimately gets many log entries in a single day, each a fresh notification) and are
-- written by the client, not the cron job. Reusing the table would mean either loosening the
-- CHECK/unique constraint (risking the already-working cron upsert) or cramming activity rows
-- into for_date/kind semantics they don't fit.

create table task_activity_notifications (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,       -- the recipient
  task_id uuid not null references tasks(id) on delete cascade,
  task_log_id uuid not null references task_log(id) on delete cascade, -- which log entry this is about
  actor_staff_id uuid references staff(id) on delete set null,         -- who posted the update
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index task_activity_notifications_staff_idx on task_activity_notifications (staff_id);

alter table task_activity_notifications enable row level security;

-- Recipient can see/mark-read only their own rows — same pattern as task_notifications'
-- notif_select/notif_update policies.
create policy task_activity_notif_select on task_activity_notifications for select
  using (staff_id = auth_staff_id());
create policy task_activity_notif_update on task_activity_notifications for update
  using (staff_id = auth_staff_id()) with check (staff_id = auth_staff_id());

-- Unlike task_notifications (service_role/cron-only writes), this one is written directly by the
-- authenticated poster right after their task_log insert — same trust level already used for
-- task_log's own log_insert policy and requests_all. The client already knows the task's real
-- assignee list (it just loaded/wrote task_assignees to compute who to notify), so there's no
-- privilege-escalation risk in letting the poster insert notification rows for their task's
-- co-assignees.
create policy task_activity_notif_insert on task_activity_notifications for insert
  with check (auth_staff_id() is not null);

alter publication supabase_realtime add table task_activity_notifications;

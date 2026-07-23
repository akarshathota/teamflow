-- Track when an overdue task was last nudged, so the "Nudge all" bulk action can skip tasks already
-- reminded recently (no duplicate-notification spam) and the UI can show "nudged 2h ago".
--
-- Set by the client each time a nudge fires (task_activity_notifications already records the individual
-- reminders per assignee; this single per-task timestamp is just for de-dup + display). Nullable,
-- additive, safe to run once. RLS unchanged — the same policies that allow updating a task's other
-- columns cover this one.

alter table tasks add column if not exists last_nudged_at timestamptz;

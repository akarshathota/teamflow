-- Preserve the original request date across the request→task hand-off.
--
-- When a manager actions a maintenance report / supply request it becomes a `tasks` row and the
-- `requests` row (which held the real report date) is deleted. Like ticket_no, the request date must
-- ride along so the tracker can show "Requested <date>" even after assignment. Existing origin-tasks
-- are backfilled from their created_at (the closest available proxy — the true request row is gone).
-- Nullable, additive, RLS unchanged.

alter table tasks add column if not exists requested_at timestamptz;
update tasks set requested_at = created_at
  where origin in ('issue','request') and requested_at is null;

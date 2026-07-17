-- daily_reports had insert + select policies only — no update policy at all, so RLS silently
-- denied every UPDATE (0 rows affected, no error) once the client started trying to update an
-- existing same-day report instead of always inserting a new one (dedupe fix, same day this
-- migration was added). Mirrors report_issues_update's self-scoped shape: only the creator can
-- update their own row, and only to a row that's still theirs after the update.
create policy daily_reports_update on daily_reports for update
  using (created_by = auth_staff_id())
  with check (created_by = auth_staff_id());

-- Lets a job-log entry's original author edit its text, but only within 2 minutes of posting it.
-- Real server-side enforcement, not just a client-side timer: a client that ignores the UI cutoff
-- and calls the API directly must still be rejected by Postgres once the window closes.
--
-- Scoped deliberately narrower than log_select/log_insert (20260710000000_auth_and_rls.sql:79-81):
-- author_id = auth_staff_id() only — not task_in_scope/is_in_scope like every other policy here.
-- A boss/admin/manager with full visibility+write access to the task is NOT allowed to edit
-- someone else's log entry. That's the product requirement, not an oversight.
create policy log_update on task_log for update
  using (author_id = auth_staff_id() and now() - created_at < interval '2 minutes')
  with check (author_id = auth_staff_id() and now() - created_at < interval '2 minutes');

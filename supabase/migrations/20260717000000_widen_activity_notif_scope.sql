-- The task_activity_notif_insert policy tightened in 20260716000000_close_rls_gaps.sql requires
-- BOTH the actor and the recipient to be literal task_assignees rows on the task. That's too
-- narrow for what's being built next: every meaningful task event (status change, extension
-- request/approve/reject, reopen, completion submit/approve/reject, reassignment — not just job
-- log entries) should notify "concerned people", which includes the instructor/boss approving or
-- being kept informed — someone who is almost never themselves a task_assignees row.
--
-- task_in_scope(task_id, viewer_id) already covers exactly the right set: the task's assignees
-- themselves, AND everyone above them in the real boss_id chain (which is who instructedBy
-- resolves to in the overwhelming common case — see console/mobile's notifyConcerned). Swapping
-- the literal task_assignees check for task_in_scope keeps the same trust bar (you must already
-- be able to see/act on this task to post about it, or to be notified about it) without the
-- artificial "must literally be assigned" restriction.
drop policy task_activity_notif_insert on task_activity_notifications;
create policy task_activity_notif_insert on task_activity_notifications for insert
  with check (
    actor_staff_id = auth_staff_id()
    and task_in_scope(task_id, auth_staff_id())
    and task_in_scope(task_id, staff_id)
  );

-- Widening the notified events beyond job-log entries (status changes, extension request/
-- approve/reject, completion submit/approve/reject, reassignment) hits a real modeling problem:
-- those events already render as their own synthesized line in the drawer's Activity timeline
-- (derived live from t.status/t.extReq/t.reopened/etc, not from a task_log row). If notifying
-- about them also required a real task_log insert (the previous NOT NULL task_log_id), the same
-- event would show up twice once task_log refetches — once as the synthesized state line, once
-- as a quoted log entry. Making task_log_id nullable and adding `label` (a short system-written
-- description, e.g. "approved the extension") gives non-log-entry events their own lightweight
-- notification row that never touches task_log, so the timeline stays exactly as it is today.
alter table task_activity_notifications alter column task_log_id drop not null;
alter table task_activity_notifications add column label text;
alter table task_activity_notifications add constraint task_activity_notifications_shape_chk
  check (task_log_id is not null or label is not null);

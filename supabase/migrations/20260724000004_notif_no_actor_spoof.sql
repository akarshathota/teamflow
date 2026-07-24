-- Security fix (/cso finding #2): stop notification sender-spoofing.
--
-- The task_activity_notifications INSERT policy (20260717000000) only checked `auth_staff_id() is not
-- null`, so any authenticated user could POST a notification row with actor_staff_id set to ANYONE
-- (e.g. the Administrator) addressed to any staff_id — in-app impersonation / phishing. Bind the
-- sender to the caller so a notification can never claim to come from someone else. The client already
-- always sets actor = the current user (viewer.id / r.id), so no app change is needed.
--
-- The recipient (staff_id) is intentionally left unconstrained: legitimate recipients are the task's
-- assignees OR its instructor (concernedFor = assignees + instructed_by, which is a NAME not an id),
-- and a strict assignee-membership WITH CHECK would (a) drop instructor notifications and (b) race the
-- async task_assignees rewrite that reassignment performs just before notifyEvent fires. Binding the
-- actor removes the impersonation lever, which is the actual risk; a notification can now only be
-- attributed to the person who really sent it.
drop policy task_activity_notif_insert on task_activity_notifications;
create policy task_activity_notif_insert on task_activity_notifications for insert
  with check (actor_staff_id = auth_staff_id());

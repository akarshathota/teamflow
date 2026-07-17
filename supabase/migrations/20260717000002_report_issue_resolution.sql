-- Daily Report follow-up, two changes bundled since both are additive columns feeding the same
-- print/export rework:
--
-- 1. "Resolve here" today just flips report_issues.status to 'resolved' with no record of how.
-- Give it two real resolution paths — issue a real task, or write down what was done — and a place
-- to land either one:
--   resolution_note      — free text. Manual path stores the user's own words; the issue-a-task
--                          path auto-fills "Converted to task: <title>" so every resolved row ends
--                          up with something human-readable here, never blank.
--   resolved_task_id      — set only for the issue-a-task path; nullable, references the task it
--                          spawned so a printed report can show "resolved via task: <title>".
-- Both columns are deliberately absent from report_issues_set_authority()'s (20260716000002_
-- report_issues.sql) UPDATE pin-back list — that trigger only pins created_by/issue/remarks/
-- priority/files/created_at back to OLD; everything else the client sends on an UPDATE, including
-- these two new columns, passes through untouched. Checked against the trigger body directly
-- rather than assumed: the resolved-branch (new.status='resolved' and old.status='open') sets
-- resolved_by/resolved_at/etc but never touches resolution_note/resolved_task_id, and the final
-- pin-back block doesn't mention them either — so the client's UPDATE payload for a resolve action
-- reaches the row exactly as sent.
alter table report_issues add column resolution_note text;
alter table report_issues add column resolved_task_id uuid references tasks(id);

-- 2. daily_reports today only freezes three aggregate counts (completed/overdue/pending), not the
-- actual task list that was on screen at submit time — so a printed report can show "5 completed"
-- but not which 5. task_snapshot freezes the full list (title/assignee/department/due/status) the
-- same "compute once, trust the frozen value forever" way completed_count etc. already do (see
-- this table's own header comment in 20260717000001_daily_reports.sql) — not a live join back to
-- `tasks` later, which would answer "how do things stand now" rather than "what did this report
-- actually show". not null default '[]' so older rows (submitted before this column existed) read
-- back as an empty list rather than null.
alter table daily_reports add column task_snapshot jsonb not null default '[]';

-- Guardrail: staff.department and tasks.department are free-text columns with no DB constraint.
-- Both apps silently bucket any unrecognized value into "Management" (LABEL_TO_BUCKET[x]||'administration'
-- in shared.js), so a typo or a stale value just quietly miscategorizes someone/something instead of
-- erroring anywhere visible. Restrict both columns to the exact label set in BUCKETS (shared.js):
-- Academic, Maintenance, Construction, HR, Accounts, Management, Transport, "IT & Systems".
--
-- The console's own "Add employee"/"Add department" and task-bucket pickers already only ever write
-- these exact BUCKETS label strings (see availDepts/renameOpts in the console file and the bucket
-- chip picker on the task composer) — so anything created or edited through the app today already
-- satisfies this constraint. The risk is historical data: the very first seed migration
-- (20260709000000_init_schema.sql) inserted staff with department values that do NOT match this set
-- ('Administration', 'Academics', 'Housekeeping', 'Operations' — vs. the current 'Management',
-- 'Academic', and no Housekeeping/Operations bucket at all). Those specific demo rows are believed to
-- have since been renamed to real staff (the org chart has moved on to real people/departments per
-- later migrations/comments), but this pass has no live DB access to confirm that directly.
--
-- Run this manually in the SQL Editor BEFORE validating the constraint, to see what (if anything)
-- would violate it:
--
--   select id, name, department from staff
--     where department not in ('Academic','Maintenance','Construction','HR','Accounts','Management','Transport','IT & Systems');
--   select id, title, department from tasks
--     where department not in ('Academic','Maintenance','Construction','HR','Accounts','Management','Transport','IT & Systems');
--
-- Added NOT VALID for exactly this reason: it applies to all NEW/UPDATED rows immediately, but does
-- NOT scan/enforce against existing rows at migration time, so it can't fail the deploy or break
-- anything that's already there. Once the two SELECTs above come back empty (or the offending rows
-- are fixed/renamed), run:
--
--   alter table staff validate constraint staff_department_guardrail;
--   alter table tasks validate constraint tasks_department_guardrail;
--
-- to fully enforce it going forward, including against pre-existing rows.

alter table staff add constraint staff_department_guardrail
  check (department in ('Academic','Maintenance','Construction','HR','Accounts','Management','Transport','IT & Systems'))
  not valid;

alter table tasks add constraint tasks_department_guardrail
  check (department in ('Academic','Maintenance','Construction','HR','Accounts','Management','Transport','IT & Systems'))
  not valid;

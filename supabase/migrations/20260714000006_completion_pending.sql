-- Task-completion approval, modeled directly on the existing extension-request pattern
-- (ext_new_date/ext_reason, 20260709000000_init_schema.sql): rather than adding a new value to
-- the status CHECK constraint (which would touch every place both apps branch on status —
-- filters, badges, dashboard counts, delivery-stats), status stays whatever it currently is
-- (bumped to 'inprogress' client-side if it was still 'open') while completion_pending is true,
-- and only flips to 'done' once the assigner's boss (or someone above them) approves. See
-- console's submitOrComplete/approveCompletion/rejectCompletion and mobile's UpdateSheet save()
-- + acts.approveCompletion/rejectCompletion.
alter table tasks add column completion_pending boolean not null default false;

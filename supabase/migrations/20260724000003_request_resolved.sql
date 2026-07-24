-- Terminal "Closed / Resolved" state for reports & requests (distinct from Declined).
--
-- Management can close an open report/request straight from the tracker without assigning it a task —
-- e.g. it was handled outside the system, was a duplicate, or no longer needs action. Mirrors the
-- existing declined_at/declined_by pattern: the row stays in the tracker for the record, but is
-- excluded from the live action queue (viewerSeesReq). Nullable, additive, RLS unchanged.

alter table requests add column if not exists resolved_at timestamptz;
alter table requests add column if not exists resolved_by uuid;

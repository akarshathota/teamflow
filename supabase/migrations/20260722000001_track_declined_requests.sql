-- Track DECLINED reports/requests instead of hard-deleting them.
--
-- Builds ADDITIVELY on the live requests table. Before this, declineReq (both apps) hard-deleted the
-- request row, so a declined item vanished with no record of who declined it or when. The new
-- "Reports & requests" tracker (Management & Admin) needs declined items to remain visible, so decline
-- now KEEPS the row and stamps these two columns instead of deleting.
--
-- WHAT CHANGES
--   * requests.declined_at  — when the item was declined (null for everything not declined).
--   * requests.declined_by  — the staff member who declined it (FK to staff).
-- The app treats "declined_at IS NOT NULL" as the declined state: such rows are EXCLUDED from the
-- normal action queue (console viewerSeesReq / mobile approvalQueue) and shown only in the tracker.
--
-- NO NEW RLS NEEDED. Reads are already covered:
--   * requests_all + the Management/Admin org-wide scope let oversight see every request (tracker reads).
--   * the decliner is, by definition, someone who already had SELECT+UPDATE on the row (an approver /
--     issue recipient / mgmt / admin via the existing requests_* policies), so the UPDATE that stamps
--     declined_at/declined_by is permitted by policies that already exist.
-- Purely additive add-column statements; safe to run once on top of the current schema.

alter table requests add column if not exists declined_at timestamptz;
alter table requests add column if not exists declined_by uuid references staff(id);

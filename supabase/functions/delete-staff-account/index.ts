// Deletes a staff row AND its linked auth.users account together. A plain client-side
// `staff` delete (RLS allows it for anyone in scope) leaves the auth account orphaned — it still
// exists, still has an email/password, and can later collide with a NEW hire's auto-generated
// {username}@teamflow.demo address ("email already registered"), which is exactly what happened
// promoting someone into a vacated Sr. Manager slot and creating a same-named replacement right
// after. Auth deletion needs the service_role key, so it has to happen here, not in the client.
//
// It also clears EVERY table that references staff(id) before deleting the row, so removing someone
// never FK-violates. Some references the DB already handles on delete (ON DELETE CASCADE / SET
// NULL); the ones declared NO ACTION do not, and used to surface one at a time as whack-a-mole
// ("...violates foreign key constraint task_log_author_id_fkey", then the next table, then the
// next). The full set below was introspected from pg_constraint (contype='f', confrelid=staff) on
// 2026-07-22 — 27 FKs across 13 tables. IF A NEW FK TO staff(id) IS ADDED, add it to the right
// group here (or rely on it being CASCADE/SET NULL) or the delete will FK-violate again.
//
// reassignTo (optional): the absorber/handover staff id. Ownership rows the departing person leaves
// behind (their reports' boss_id, task_assignees, requests, routing rules, checklist duties, daily
// reports…) are reassigned to them so work/routing survives the removal. When it's absent, those
// references are instead NULLed (nullable columns) or deleted (NOT NULL columns) — and NOT NULL
// references the DB already CASCADEs are simply left for the cascade to remove.
//
// Self-contained: inlines its own CORS/json/verifyAdmin instead of importing
// ../_shared/helpers.ts, so it works standalone if pasted alone into the Supabase Dashboard's
// function editor (how it's actually deployed — see supabase/OPERATIONS.md). _shared/helpers.ts
// still holds the canonical copies.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_TIER = ["Administrator", "Management"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// Verifies the caller's session and that they're Administrator/Management. On success returns a
// service_role client (bypasses RLS for the rest of the handler) plus the caller's own staff
// id/name (so the handler can record who did this in admin_activity_log); on failure returns the
// Response to return immediately.
async function verifyAdmin(
  req: Request,
  action: string,
): Promise<{ admin: ReturnType<typeof createClient>; actorId: string; actorName: string } | { error: Response }> {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return { error: json({ error: "Missing Authorization" }, 401) };

  const url = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
  const { data: { user }, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !user) return { error: json({ error: "Invalid session" }, 401) };

  const admin = createClient(url, serviceKey);
  const { data: callerStaff } = await admin.from("staff").select("id, name, role").eq("auth_user_id", user.id).maybeSingle();
  if (!callerStaff || !ADMIN_TIER.includes(callerStaff.role)) {
    return { error: json({ error: `Only Administrator or Management can ${action}` }, 403) };
  }
  return { admin, actorId: callerStaff.id, actorName: callerStaff.name };
}

// (1) Authored-by / audit references that are NO ACTION on delete and nullable — always detach
//     (set NULL). These name who did a past action; they're never reassigned to the absorber (we
//     don't want to claim the absorber escalated/declined/authored something they didn't). The
//     equivalent SET NULL references (task_log has NO ACTION; admin_activity_log.actor/target,
//     checklist_absences.marked_by, checklist_items.last_edited_by, task_activity_notifications
//     .actor_staff_id are already SET NULL) are handled by the DB and intentionally omitted.
const NULL_ON_DELETE: [string, string][] = [
  ["notices", "posted_by"],
  ["report_issues", "escalated_to"],
  ["report_issues", "resolved_by"],
  ["report_issues", "last_escalated_by"],
  ["requests", "declined_by"],
  ["task_log", "author_id"],
  ["tasks", "reopened_by"],
];

// (2) Ownership references. Reassign to the absorber when we have one. Without an absorber: NULL it
//     if the column is nullable and NO ACTION; delete the rows if NOT NULL and NO ACTION; do
//     nothing if the DB already clears it on delete (dbAuto = CASCADE or SET NULL).
//     dedupBy: a column that, together with the reassigned column, has a UNIQUE/PK constraint — the
//     absorber's own rows would collide, so drop the departing person's colliding rows before the
//     reassign (this is the same task_assignees_pkey duplicate-key the client de-dupes, plus
//     daily_reports' one-report-per-person-per-day unique).
type Reassign = { table: string; col: string; nullable: boolean; dbAuto: boolean; dedupBy?: string };
const REASSIGN: Reassign[] = [
  { table: "staff",                col: "boss_id",           nullable: true,  dbAuto: false },
  { table: "requests",             col: "from_staff_id",     nullable: false, dbAuto: false },
  { table: "requests",             col: "target_staff_id",   nullable: true,  dbAuto: false },
  { table: "requests",             col: "approver_staff_id", nullable: true,  dbAuto: false },
  { table: "routing_rules",        col: "target_staff_id",   nullable: true,  dbAuto: true  }, // SET NULL
  { table: "report_issues",        col: "created_by",        nullable: false, dbAuto: false },
  { table: "daily_reports",        col: "created_by",        nullable: false, dbAuto: false, dedupBy: "report_date" },
  { table: "checklist_items",      col: "staff_id",          nullable: false, dbAuto: true  }, // CASCADE — reassign duties instead of losing them
  { table: "checklist_completions", col: "staff_id",         nullable: false, dbAuto: true  }, // CASCADE — unique(item_id,occ_date), collision-free
  { table: "task_assignees",       col: "staff_id",          nullable: false, dbAuto: true,  dedupBy: "task_id" }, // CASCADE — pk(task_id,staff_id)
];
// Everything else referencing staff(id) is a per-person transient the DB removes on delete via
// CASCADE (task_notifications, task_activity_notifications.staff_id, checklist_notifications
// .staff_id/subject_id, checklist_absences.staff_id) — no action needed here.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const verified = await verifyAdmin(req, "remove staff");
    if ("error" in verified) return verified.error;
    const { admin, actorId } = verified;

    const body = await req.json().catch(() => ({}));
    const staffId = body.staffId;
    if (!staffId) return json({ error: "staffId is required" }, 400);

    const { data: target } = await admin.from("staff").select("name, auth_user_id").eq("id", staffId).maybeSingle();
    if (!target) return json({ error: "Staff member not found" }, 404);

    // Validate the absorber: must be a real, different staff row, else a reassign would itself
    // FK-violate. A bad/self id degrades gracefully to the no-absorber path (NULL / delete).
    let reassignTo: string | null = body.reassignTo || null;
    if (reassignTo === staffId) reassignTo = null;
    if (reassignTo) {
      const { data: rt } = await admin.from("staff").select("id").eq("id", reassignTo).maybeSingle();
      if (!rt) reassignTo = null;
    }

    // ---- clear every staff(id) reference BEFORE deleting the row ----
    for (const [table, col] of NULL_ON_DELETE) {
      const { error } = await admin.from(table).update({ [col]: null }).eq(col, staffId);
      if (error) return json({ error: `Could not clear ${table}.${col}: ${error.message}` }, 500);
    }
    for (const r of REASSIGN) {
      if (reassignTo) {
        if (r.dedupBy) {
          // drop the departing person's rows that would collide with the absorber's existing rows
          const { data: existing, error: eScan } = await admin.from(r.table).select(r.dedupBy).eq(r.col, reassignTo);
          if (eScan) return json({ error: `Could not scan ${r.table}: ${eScan.message}` }, 500);
          const keys = [...new Set((existing || []).map((row: Record<string, unknown>) => row[r.dedupBy!]).filter((v) => v != null))];
          if (keys.length) {
            const { error: eDel } = await admin.from(r.table).delete().eq(r.col, staffId).in(r.dedupBy, keys);
            if (eDel) return json({ error: `Could not de-dupe ${r.table}.${r.col}: ${eDel.message}` }, 500);
          }
        }
        const { error } = await admin.from(r.table).update({ [r.col]: reassignTo }).eq(r.col, staffId);
        if (error) return json({ error: `Could not reassign ${r.table}.${r.col}: ${error.message}` }, 500);
      } else if (!r.dbAuto) {
        // no absorber and the DB won't auto-clear this NO ACTION reference — clear it ourselves
        if (r.nullable) {
          const { error } = await admin.from(r.table).update({ [r.col]: null }).eq(r.col, staffId);
          if (error) return json({ error: `Could not clear ${r.table}.${r.col}: ${error.message}` }, 500);
        } else {
          const { error } = await admin.from(r.table).delete().eq(r.col, staffId);
          if (error) return json({ error: `Could not purge ${r.table} by ${r.col}: ${error.message}` }, 500);
        }
      } // else dbAuto && no absorber → CASCADE/SET NULL removes it on the staff delete below
    }

    const { error: delStaffErr } = await admin.from("staff").delete().eq("id", staffId);
    if (delStaffErr) return json({ error: "Could not delete staff record: " + delStaffErr.message }, 500);

    let authWarning: string | undefined;
    if (target.auth_user_id) {
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(target.auth_user_id);
      // staff row is already gone at this point — surface the problem rather than hide it, but
      // don't treat it as a hard failure since the more important half (removing them from the
      // org chart) already succeeded.
      if (delAuthErr) authWarning = delAuthErr.message;
    }

    // Best-effort audit trail — awaited so it's guaranteed to run before the function returns
    // (Edge Function background work isn't guaranteed to survive past the response), but a
    // logging failure shouldn't turn a successful deletion into an error response. target_staff_id
    // is left null: the staff row is already gone by the time we log (the FK references staff(id),
    // which would reject a dangling id), so target_name is the only durable record of who it was.
    const { error: logErr } = await admin.from("admin_activity_log").insert({
      actor_staff_id: actorId, action: "delete_staff", target_staff_id: null,
      target_name: target.name, detail: { deletedStaffId: staffId, ...(reassignTo ? { reassignedTo: reassignTo } : {}), ...(authWarning ? { authWarning } : {}) },
    });
    if (logErr) console.error("[delete-staff-account] admin_activity_log insert failed:", logErr.message);

    return authWarning ? json({ name: target.name, authWarning }) : json({ name: target.name });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

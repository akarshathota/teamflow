// Deletes a staff row AND its linked auth.users account together. A plain client-side
// `staff` delete (RLS allows it for anyone in scope) leaves the auth account orphaned — it still
// exists, still has an email/password, and can later collide with a NEW hire's auto-generated
// {username}@teamflow.demo address ("email already registered"), which is exactly what happened
// promoting someone into a vacated Sr. Manager slot and creating a same-named replacement right
// after. Auth deletion needs the service_role key, so it has to happen here, not in the client.
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
      target_name: target.name, detail: { deletedStaffId: staffId, ...(authWarning ? { authWarning } : {}) },
    });
    if (logErr) console.error("[delete-staff-account] admin_activity_log insert failed:", logErr.message);

    return authWarning ? json({ name: target.name, authWarning }) : json({ name: target.name });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

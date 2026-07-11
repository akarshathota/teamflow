// Deletes a staff row AND its linked auth.users account together. A plain client-side
// `staff` delete (RLS allows it for anyone in scope) leaves the auth account orphaned — it still
// exists, still has an email/password, and can later collide with a NEW hire's auto-generated
// {username}@teamflow.demo address ("email already registered"), which is exactly what happened
// promoting someone into a vacated Sr. Manager slot and creating a same-named replacement right
// after. Auth deletion needs the service_role key, so it has to happen here, not in the client.

import { CORS, json, verifyAdmin } from "../_shared/helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const verified = await verifyAdmin(req, "remove staff");
    if ("error" in verified) return verified.error;
    const { admin } = verified;

    const body = await req.json().catch(() => ({}));
    const staffId = body.staffId;
    if (!staffId) return json({ error: "staffId is required" }, 400);

    const { data: target } = await admin.from("staff").select("name, auth_user_id").eq("id", staffId).maybeSingle();
    if (!target) return json({ error: "Staff member not found" }, 404);

    const { error: delStaffErr } = await admin.from("staff").delete().eq("id", staffId);
    if (delStaffErr) return json({ error: "Could not delete staff record: " + delStaffErr.message }, 500);

    if (target.auth_user_id) {
      const { error: delAuthErr } = await admin.auth.admin.deleteUser(target.auth_user_id);
      // staff row is already gone at this point — surface the problem rather than hide it, but
      // don't treat it as a hard failure since the more important half (removing them from the
      // org chart) already succeeded.
      if (delAuthErr) return json({ name: target.name, authWarning: delAuthErr.message });
    }

    return json({ name: target.name });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

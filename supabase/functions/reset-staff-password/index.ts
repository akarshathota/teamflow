// Lets an Administrator or Management user force-reset another staff member's password.
// Exists because most accounts log in with a synthetic {username}@teamflow.demo address that
// can't receive email, so Supabase's normal "email me a reset link" flow only works for the
// real-email Administrator/Management accounts (see LoginScreen's "Forgot password?" for that
// path). Everyone else needs an admin to generate a new password and relay it — same shape as
// create-staff-account's "shown once" credential handoff.

import { CORS, json, randomPassword, verifyAdmin } from "../_shared/helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const verified = await verifyAdmin(req, "reset passwords");
    if ("error" in verified) return verified.error;
    const { admin } = verified;

    const body = await req.json().catch(() => ({}));
    const staffId = body.staffId;
    if (!staffId) return json({ error: "staffId is required" }, 400);

    const { data: target } = await admin.from("staff").select("name, username, auth_user_id").eq("id", staffId).maybeSingle();
    if (!target) return json({ error: "Staff member not found" }, 404);
    if (!target.auth_user_id) return json({ error: target.name + " doesn't have a login yet — use Add employee instead" }, 400);

    const password = randomPassword();
    const { error: updErr } = await admin.auth.admin.updateUserById(target.auth_user_id, { password });
    if (updErr) return json({ error: "Could not reset password: " + updErr.message }, 500);

    const { data: authUser } = await admin.auth.admin.getUserById(target.auth_user_id);

    return json({
      name: target.name,
      login: authUser?.user?.email || null,
      username: target.username || null,
      password,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

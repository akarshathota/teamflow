// Lets an Administrator or Management user correct another staff member's login identifier —
// the real email for Administrator/Management accounts (e.g. fixing a typo'd address), or the
// {username}@teamflow.demo username for everyone else. Same shape as reset-staff-password:
// applies instantly via the Auth Admin API (email_confirm skips Supabase's double-opt-in
// confirmation flow, since half these accounts use synthetic addresses that can't receive it
// anyway, and this is already an authorized admin action, not a self-service one).

import { CORS, json, verifyAdmin, ADMIN_TIER } from "../_shared/helpers.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const verified = await verifyAdmin(req, "change login details");
    if ("error" in verified) return verified.error;
    const { admin } = verified;

    const body = await req.json().catch(() => ({}));
    const staffId = body.staffId;
    if (!staffId) return json({ error: "staffId is required" }, 400);

    const { data: target } = await admin.from("staff").select("id, name, role, username, auth_user_id").eq("id", staffId).maybeSingle();
    if (!target) return json({ error: "Staff member not found" }, 404);
    if (!target.auth_user_id) return json({ error: target.name + " doesn't have a login yet — use Add employee instead" }, 400);

    let newEmail: string;
    let newUsername: string | null = target.username;

    if (ADMIN_TIER.includes(target.role)) {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter a valid email address" }, 400);
      newEmail = email;
    } else {
      const username = String(body.username || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!username) return json({ error: "Enter a username" }, 400);
      const { data: others } = await admin.from("staff").select("username").neq("id", staffId);
      if ((others || []).some((r: any) => r.username === username)) {
        return json({ error: "That username is already taken" }, 409);
      }
      newUsername = username;
      newEmail = `${username}@teamflow.demo`;
    }

    const { error: updErr } = await admin.auth.admin.updateUserById(target.auth_user_id, { email: newEmail, email_confirm: true });
    if (updErr) return json({ error: "Could not update login: " + updErr.message }, 500);

    if (newUsername !== target.username) {
      await admin.from("staff").update({ username: newUsername }).eq("id", staffId);
    }

    return json({ name: target.name, login: newEmail, username: ADMIN_TIER.includes(target.role) ? null : newUsername });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

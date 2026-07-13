// Lets an Administrator or Management user force-reset another staff member's password.
// Exists because most accounts log in with a synthetic {username}@teamflow.demo address that
// can't receive email, so Supabase's normal "email me a reset link" flow only works for the
// real-email Administrator/Management accounts (see LoginScreen's "Forgot password?" for that
// path). Everyone else needs an admin to generate a new password and relay it — same shape as
// create-staff-account's "shown once" credential handoff.
//
// Self-contained: inlines its own CORS/json/randomPassword/verifyAdmin instead of importing
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

function randomPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
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
    const verified = await verifyAdmin(req, "reset passwords");
    if ("error" in verified) return verified.error;
    const { admin, actorId } = verified;

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

    // Best-effort audit trail — never the password itself, just that a reset happened.
    const { error: logErr } = await admin.from("admin_activity_log").insert({
      actor_staff_id: actorId, action: "reset_password", target_staff_id: staffId, target_name: target.name, detail: {},
    });
    if (logErr) console.error("[reset-staff-password] admin_activity_log insert failed:", logErr.message);

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

// Lets an Administrator or Management user force-reset another staff member's password.
// Exists because most accounts log in with a synthetic {username}@teamflow.demo address that
// can't receive email, so Supabase's normal "email me a reset link" flow only works for the
// real-email Administrator/Management accounts (see LoginScreen's "Forgot password?" for that
// path). Everyone else needs an admin to generate a new password and relay it — same shape as
// create-staff-account's "shown once" credential handoff.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_TIER = ["Administrator", "Management"];
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function randomPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: { user }, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !user) return json({ error: "Invalid session" }, 401);

    // Everything past this point runs as service_role, bypassing RLS — needed to touch
    // another user's Auth record at all.
    const admin = createClient(url, serviceKey);

    const { data: callerStaff } = await admin.from("staff").select("role").eq("auth_user_id", user.id).maybeSingle();
    if (!callerStaff || !ADMIN_TIER.includes(callerStaff.role)) {
      return json({ error: "Only Administrator or Management can reset passwords" }, 403);
    }

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

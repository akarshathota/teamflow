// Lets an Administrator or Management user create a real login for a new (or existing,
// unlinked) staff member. Runs server-side because it needs the service_role key to call
// the Auth Admin API — that key must never reach client JS, so this can't be done from the
// browser directly the way every other write in this app is.
//
// Administrator/Management accounts log in with a real email (required in the request).
// Everyone else gets a generated username @teamflow.demo and a generated password, both
// returned once in the response for the calling admin to relay to the new person.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CONSOLE_ROLES = ["Administrator", "Management", "Manager", "Team Member", "Teacher"];
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

    // Verify the caller's own session first (rejects garbage/expired tokens cheaply).
    const asCaller = createClient(url, anonKey, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: { user }, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !user) return json({ error: "Invalid session" }, 401);

    // Everything past this point runs as service_role, bypassing RLS — that's the point of
    // this function existing server-side at all.
    const admin = createClient(url, serviceKey);

    const { data: callerStaff } = await admin.from("staff").select("role").eq("auth_user_id", user.id).maybeSingle();
    if (!callerStaff || !ADMIN_TIER.includes(callerStaff.role)) {
      return json({ error: "Only Administrator or Management can create accounts" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const role = body.role;
    const department = String(body.department || "").trim();
    const bossName = body.boss || null;
    const phone = body.phone || null;
    const email = String(body.email || "").trim().toLowerCase();

    if (!name || !CONSOLE_ROLES.includes(role) || !department) {
      return json({ error: "name, a valid role, and department are required" }, 400);
    }
    if (ADMIN_TIER.includes(role) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "A real email is required for Administrator/Management accounts" }, 400);
    }

    const { data: existing } = await admin.from("staff").select("id").eq("name", name).maybeSingle();
    if (existing) return json({ error: "That name is already in the team" }, 409);

    let bossId: string | null = null;
    if (bossName) {
      const { data: bossRow } = await admin.from("staff").select("id").eq("name", bossName).maybeSingle();
      bossId = bossRow ? bossRow.id : null;
    }

    const parts = name.split(/\s+/);
    const initials = parts.map((p: string) => p[0]).join("").slice(0, 2).toUpperCase();

    const { data: allStaff } = await admin.from("staff").select("short_name, username");
    const takenShort = new Set((allStaff || []).map((r: any) => r.short_name));
    const takenUser = new Set((allStaff || []).map((r: any) => r.username).filter(Boolean));
    let shortName = parts[0], i = 2;
    while (takenShort.has(shortName)) shortName = parts[0] + (parts[1] ? parts[1][0] : "") + i++;
    let username = shortName.toLowerCase(), j = 2;
    while (takenUser.has(username)) username = shortName.toLowerCase() + j++;

    const loginEmail = ADMIN_TIER.includes(role) ? email : `${username}@teamflow.demo`;
    const password = randomPassword();

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email: loginEmail,
      password,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      return json({ error: "Could not create login: " + (createErr?.message || "unknown error") }, 500);
    }

    const { data: staffRow, error: staffErr } = await admin.from("staff").insert({
      name,
      short_name: shortName,
      initials,
      role,
      department,
      boss_id: bossId,
      phone,
      auth_user_id: created.user.id,
      username: ADMIN_TIER.includes(role) ? null : username,
    }).select().single();

    if (staffErr) {
      await admin.auth.admin.deleteUser(created.user.id); // don't leave an orphaned login with no staff row
      return json({ error: "Could not create staff record: " + staffErr.message }, 500);
    }

    return json({
      id: staffRow.id,
      name,
      short_name: shortName,
      login: loginEmail,
      username: ADMIN_TIER.includes(role) ? null : username,
      password,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// Lets an Administrator or Management user create a real login for a new (or existing,
// unlinked) staff member. Runs server-side because it needs the service_role key to call
// the Auth Admin API — that key must never reach client JS, so this can't be done from the
// browser directly the way every other write in this app is.
//
// Administrator/Management accounts log in with a real email (required in the request).
// Everyone else gets a generated username @teamflow.demo and a generated password, both
// returned once in the response for the calling admin to relay to the new person.
//
// Self-contained: inlines its own CORS/json/randomPassword/verifyAdmin instead of importing
// ../_shared/helpers.ts, so it works standalone if pasted alone into the Supabase Dashboard's
// function editor (how it's actually deployed — see supabase/OPERATIONS.md). _shared/helpers.ts
// still holds the canonical copies.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CONSOLE_ROLES = ["Administrator", "Management", "Manager", "Team Lead", "Team Member", "Teacher"];
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
    const verified = await verifyAdmin(req, "create accounts");
    if ("error" in verified) return verified.error;
    const { admin, actorId } = verified;

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const role = body.role;
    const department = String(body.department || "").trim();
    const subDept = body.subDept ? String(body.subDept).trim() || null : null;
    const bossName = body.boss || null;
    const phone = body.phone || null;
    const email = String(body.email || "").trim().toLowerCase();

    if (!name || !CONSOLE_ROLES.includes(role) || !department) {
      return json({ error: "name, a valid role, and department are required" }, 400);
    }
    if (ADMIN_TIER.includes(role) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: "A real email is required for Administrator/Management accounts" }, 400);
    }

    // "existing, unlinked" = a staff row seeded (e.g. via migration or bulk import) without ever
    // getting a login — link this call to that row instead of rejecting it as a duplicate name.
    // A row that already has auth_user_id is a real duplicate, though.
    const { data: existing } = await admin.from("staff").select("id, auth_user_id, short_name, initials").eq("name", name).maybeSingle();
    if (existing?.auth_user_id) return json({ error: "That name is already in the team" }, 409);

    let bossId: string | null = null;
    if (bossName) {
      const { data: bossRow } = await admin.from("staff").select("id").eq("name", bossName).maybeSingle();
      bossId = bossRow ? bossRow.id : null;
    }

    const { data: allStaff } = await admin.from("staff").select("short_name, username");
    const takenShort = new Set((allStaff || []).map((r: any) => r.short_name));
    const takenUser = new Set((allStaff || []).map((r: any) => r.username).filter(Boolean));

    // Linking keeps the existing short_name — it's already referenced by this person's tasks/logs,
    // so minting a new one would orphan that history instead of attaching a login to it.
    let shortName: string, initials: string;
    if (existing) {
      shortName = existing.short_name;
      initials = existing.initials;
    } else {
      const parts = name.split(/\s+/);
      initials = parts.map((p: string) => p[0]).join("").slice(0, 2).toUpperCase();
      shortName = parts[0];
      let i = 2;
      while (takenShort.has(shortName)) shortName = parts[0] + (parts[1] ? parts[1][0] : "") + i++;
    }
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

    const staffFields = {
      role,
      department,
      sub_dept: subDept,
      boss_id: bossId,
      phone,
      auth_user_id: created.user.id,
      username: ADMIN_TIER.includes(role) ? null : username,
    };
    const { data: staffRow, error: staffErr } = existing
      ? await admin.from("staff").update(staffFields).eq("id", existing.id).select().single()
      : await admin.from("staff").insert({ name, short_name: shortName, initials, ...staffFields }).select().single();

    if (staffErr) {
      await admin.auth.admin.deleteUser(created.user.id); // don't leave an orphaned login with no staff row
      return json({ error: "Could not create staff record: " + staffErr.message }, 500);
    }

    // Best-effort audit trail — a logging failure shouldn't turn a successful account creation
    // into an error response for the admin who just did it.
    const { error: logErr } = await admin.from("admin_activity_log").insert({
      actor_staff_id: actorId,
      action: "create_staff",
      target_staff_id: staffRow.id,
      target_name: name,
      detail: { role, department, subDept, login: loginEmail, linkedExisting: !!existing },
    });
    if (logErr) console.error("[create-staff-account] admin_activity_log insert failed:", logErr.message);

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

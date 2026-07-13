// Lets an Administrator or Management user correct another staff member's login identifier —
// the real email for Administrator/Management accounts (e.g. fixing a typo'd address), or the
// {username}@teamflow.demo username for everyone else. Same shape as reset-staff-password:
// applies instantly via the Auth Admin API (email_confirm skips Supabase's double-opt-in
// confirmation flow, since half these accounts use synthetic addresses that can't receive it
// anyway, and this is already an authorized admin action, not a self-service one).
//
// Self-contained: inlines its own CORS/json/verifyAdmin/ADMIN_TIER instead of importing
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
    const verified = await verifyAdmin(req, "change login details");
    if ("error" in verified) return verified.error;
    const { admin, actorId } = verified;

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

    // Best-effort audit trail — a logging failure shouldn't turn a successful login change into an
    // error response.
    const { error: logErr } = await admin.from("admin_activity_log").insert({
      actor_staff_id: actorId, action: "update_login", target_staff_id: staffId, target_name: target.name,
      detail: { newLogin: newEmail },
    });
    if (logErr) console.error("[update-staff-login] admin_activity_log insert failed:", logErr.message);

    return json({ name: target.name, login: newEmail, username: ADMIN_TIER.includes(target.role) ? null : newUsername });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

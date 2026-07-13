// Canonical reference copy of the logic shared by every admin-only Edge Function in this project
// (create/delete staff, reset password, update login). As of 2026-07-14 every function in
// supabase/functions/*/index.ts inlines its own copy of this instead of importing from here —
// they're deployed via the Supabase Dashboard's browser code editor, which needs each file to be
// self-contained/paste-able on its own (see supabase/OPERATIONS.md). This file is no longer
// imported by anything, but is kept as the one place that documents the canonical shape; if you
// change the logic here, copy the change into each function's inlined version too.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const ADMIN_TIER = ["Administrator", "Management"];

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

export function randomPassword(len = 14) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => chars[n % chars.length]).join("");
}

// Verifies the caller's session and that they're Administrator/Management. On success returns a
// service_role client (bypasses RLS for the rest of the handler) plus the caller's own staff
// id/name (used to record who did it in admin_activity_log); on failure returns the Response to
// return immediately. `action` only fills in the one word that differs per caller ("create
// accounts" / "remove staff" / "reset passwords" / "change login details").
export async function verifyAdmin(
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

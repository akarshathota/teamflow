// End-of-day cron: nudges anyone who hasn't filed today's daily report. Enqueues a WhatsApp
// `daily_report_reminder` per missing person into whatsapp_outbox; whatsapp-dispatch resolves each
// recipient's phone + opt-in, so only people who consented are actually messaged. Runs independent of
// anyone having the app open (see the daily-report-reminder cron in migrations).
//
// "Expected to submit" = staff with a login (auth_user_id) who aren't an Administrator (admins review
// reports, they don't file them). Mirrors the app's "X of Y submitted" set closely enough for a nudge;
// the opt-in gate at dispatch is the real filter.
//
// Self-contained (inlines CORS/json) so it pastes standalone into the Dashboard function editor.
// Secrets: CRON_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-cron-secret",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // The school runs on IST — "today" must be today in IST, not wherever this executes.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const todayLabel = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(today));

  const { data: subs, error: subErr } = await admin.from("daily_reports").select("created_by").eq("report_date", today);
  if (subErr) return json({ error: subErr.message }, 500);
  const submitted = new Set((subs || []).map((s) => s.created_by));

  const { data: staff, error: staffErr } = await admin
    .from("staff")
    .select("id, name")
    .not("auth_user_id", "is", null)
    .neq("role", "Administrator");
  if (staffErr) return json({ error: staffErr.message }, 500);

  const missing = (staff || []).filter((s) => !submitted.has(s.id));

  if (missing.length) {
    const rows = missing.map((s) => ({
      recipient_staff_id: s.id,
      template: "daily_report_reminder",
      variables: [String(s.name || "").split(" ")[0] || "there", todayLabel],
    }));
    const { error: waErr } = await admin.from("whatsapp_outbox").insert(rows);
    if (waErr) return json({ error: waErr.message }, 500);
  }

  console.log(`[daily-report-reminder] ${today}: ${(staff || []).length} expected, ${submitted.size} submitted, ${missing.length} reminded`);
  return json({ today, expected: (staff || []).length, submitted: submitted.size, reminded: missing.length });
});

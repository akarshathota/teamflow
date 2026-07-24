// Runs on a schedule (see the check-due-tasks-daily cron job in migrations), not by a logged-in
// user — so it checks Postgres/Deno's own clock for what's overdue or due today, and works even if
// nobody has the app open. Writes one row per assignee into task_notifications (in-app only for
// now — the client shows these as a bell/badge; no email/push is wired in yet).
//
// Self-contained: inlines its own CORS/json instead of importing ../_shared/helpers.ts, so it works
// standalone if pasted alone into the Supabase Dashboard's function editor (how it's actually
// deployed — see supabase/OPERATIONS.md). _shared/helpers.ts still holds the canonical copies.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Called by pg_cron via pg_net, not a user session — gate with a shared secret instead of a JWT.
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // The school runs on IST; a task due "today" should mean today in IST, not in whatever timezone
  // this function happens to execute in.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

  const { data, error } = await admin
    .from("tasks")
    .select("id, title, due_date")
    .neq("status", "done")
    .eq("completion_pending", false)
    .lte("due_date", today);
  if (error) return json({ error: error.message }, 500);

  const overdue = (data || []).filter((t) => t.due_date < today);
  const dueToday = (data || []).filter((t) => t.due_date === today);

  console.log(`[check-due-tasks] ${today}: ${overdue.length} overdue, ${dueToday.length} due today`);

  const flagged = [...overdue.map((t) => ({ t, kind: "overdue" })), ...dueToday.map((t) => ({ t, kind: "due_today" }))];
  let notified = 0;
  if (flagged.length) {
    const { data: assignRows, error: assignErr } = await admin
      .from("task_assignees")
      .select("task_id, staff_id")
      .in("task_id", flagged.map((f) => f.t.id));
    if (assignErr) return json({ error: assignErr.message }, 500);

    const staffByTask: Record<string, string[]> = {};
    for (const a of assignRows || []) (staffByTask[a.task_id] ||= []).push(a.staff_id);

    const rows = flagged.flatMap((f) =>
      (staffByTask[f.t.id] || []).map((staff_id) => ({
        staff_id,
        task_id: f.t.id,
        kind: f.kind,
        for_date: today,
      }))
    );
    if (rows.length) {
      const { error: upErr } = await admin
        .from("task_notifications")
        .upsert(rows, { onConflict: "staff_id,task_id,kind,for_date", ignoreDuplicates: true });
      if (upErr) return json({ error: upErr.message }, 500);
      notified = rows.length;
    }

    // Also enqueue a WhatsApp `task_reminder` per flagged assignee (whatsapp-dispatch resolves phone +
    // opt-in and skips anyone without them). Needs the recipient's first name for {{1}}.
    const staffIds = [...new Set(rows.map((r) => r.staff_id))];
    if (staffIds.length) {
      const { data: staff } = await admin.from("staff").select("id, name").in("id", staffIds);
      const firstName: Record<string, string> = {};
      for (const s of staff || []) firstName[s.id] = String(s.name || "").split(" ")[0];
      const titleById: Record<string, string> = {};
      const dueById: Record<string, string> = {};
      for (const f of flagged) {
        titleById[f.t.id] = f.t.title;
        dueById[f.t.id] = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(f.t.due_date));
      }
      const waRows = rows.map((r) => ({
        recipient_staff_id: r.staff_id,
        template: "task_reminder",
        variables: [firstName[r.staff_id] || "there", r.kind === "overdue" ? "overdue" : "due today", titleById[r.task_id], dueById[r.task_id]],
      }));
      const { error: waErr } = await admin.from("whatsapp_outbox").insert(waRows);
      if (waErr) console.error("[check-due-tasks] whatsapp_outbox insert failed:", waErr.message);
    }
  }

  // Health signal for console's "last cron run" indicator (see the cron_runs migration for why a
  // dedicated table exists instead of reading task_notifications directly — that table's RLS is
  // scoped per-recipient with no admin bypass, so it'd often look empty on a day the cron ran fine
  // and correctly found nothing to flag). Best-effort — a failure to record the run shouldn't turn
  // an otherwise-successful cron run into an error response.
  const { error: cronLogErr } = await admin
    .from("cron_runs")
    .insert({ overdue_count: overdue.length, due_today_count: dueToday.length, notified_count: notified });
  if (cronLogErr) console.error("[check-due-tasks] cron_runs insert failed:", cronLogErr.message);

  return json({ today, overdue: overdue.length, dueToday: dueToday.length, notified });
});

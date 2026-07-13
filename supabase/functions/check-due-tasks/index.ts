// Runs on a schedule (see the check-due-tasks-daily cron job in migrations), not by a logged-in
// user — so it checks Postgres/Deno's own clock for what's overdue or due today, and works even if
// nobody has the app open. Writes one row per assignee into task_notifications (in-app only for
// now — the client shows these as a bell/badge; no email/push is wired in yet).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS, json } from "../_shared/helpers.ts";

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
  }

  return json({ today, overdue: overdue.length, dueToday: dueToday.length, notified });
});

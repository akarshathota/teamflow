// Runs on a schedule (see the check-due-tasks-daily cron job in migrations), not by a logged-in
// user — so it checks Postgres/Deno's own clock for what's overdue or due today, and works even if
// nobody has the app open. Detection only for now: no email/push is wired in yet, so it logs a
// summary (visible in the function's logs in the Supabase dashboard). The TODO below marks where a
// real send call plugs in once a delivery channel (email first, per the plan) is chosen.

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

  // TODO: send the actual notification here (email first) once a delivery channel is chosen —
  // for now this just proves the schedule fires and the overdue/due-today query is correct.
  console.log(`[check-due-tasks] ${today}: ${overdue.length} overdue, ${dueToday.length} due today`);
  overdue.forEach((t) => console.log(`  overdue: ${t.title} (was due ${t.due_date})`));
  dueToday.forEach((t) => console.log(`  due today: ${t.title}`));

  return json({ today, overdue: overdue.length, dueToday: dueToday.length });
});

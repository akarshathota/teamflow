// Morning checklist reminders. Same shape as check-due-tasks: cron hits this with x-cron-secret,
// we compute with the service_role key and upsert into checklist_notifications (in-app only).
//   checklist_today  -> the owner: "you have N items today" (start-of-day nudge)
//   checklist_missed -> the boss:  "<person> left yesterday's checklist incomplete" (and wasn't absent)
// Idempotent via the table's unique(staff_id, subject_id, kind, for_date).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-cron-secret",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// item due on a given YYYY-MM-DD (UTC-anchored, so the calendar weekday/day is stable regardless of runtime TZ)
function dueOn(it: any, isoD: string): boolean {
  const d = new Date(isoD + "T00:00:00Z");
  if (it.freq === "daily") return true;
  if (it.freq === "weekly") return ((d.getUTCDay() + 6) % 7) === it.dow;
  const dom = d.getUTCDate();
  const lastM = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (it.freq === "monthly") return dom === Math.min(it.dom, lastM);
  const lastY = new Date(Date.UTC(d.getUTCFullYear(), it.y_mon, 0)).getUTCDate();
  return (d.getUTCMonth() + 1) === it.y_mon && dom === Math.min(it.y_day, lastY);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== Deno.env.get("CRON_SECRET")) return json({ error: "Unauthorized" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
  const today = fmt.format(new Date());
  const yesterday = fmt.format(new Date(Date.now() - 86400000));

  const [{ data: items, error: iErr }, { data: staff }, { data: comps }, { data: abss }] = await Promise.all([
    admin.from("checklist_items").select("id,staff_id,freq,dow,dom,y_day,y_mon").eq("archived", false),
    admin.from("staff").select("id,boss_id"),
    admin.from("checklist_completions").select("item_id,staff_id,occ_date").in("occ_date", [today, yesterday]),
    admin.from("checklist_absences").select("staff_id,absent_date").in("absent_date", [today, yesterday]),
  ]);
  if (iErr) return json({ error: iErr.message }, 500);

  const bossOf: Record<string, string | null> = {};
  for (const s of staff || []) bossOf[s.id] = s.boss_id;
  const doneKey = new Set((comps || []).map((c) => `${c.staff_id}|${c.occ_date}|${c.item_id}`));
  const absentKey = new Set((abss || []).map((a) => `${a.staff_id}|${a.absent_date}`));
  const byStaff: Record<string, any[]> = {};
  for (const it of items || []) (byStaff[it.staff_id] ||= []).push(it);

  const rows: any[] = [];
  for (const [sid, its] of Object.entries(byStaff)) {
    // today: start-of-day nudge to the owner
    const dueT = its.filter((it) => dueOn(it, today));
    if (dueT.length && !absentKey.has(`${sid}|${today}`)) {
      const doneT = dueT.filter((it) => doneKey.has(`${sid}|${today}|${it.id}`)).length;
      rows.push({ staff_id: sid, subject_id: sid, kind: "checklist_today", for_date: today, done_count: doneT, total_count: dueT.length });
    }
    // yesterday: alert the boss if it was left incomplete (and the person wasn't absent)
    const dueY = its.filter((it) => dueOn(it, yesterday));
    const boss = bossOf[sid];
    if (dueY.length && boss && !absentKey.has(`${sid}|${yesterday}`)) {
      const doneY = dueY.filter((it) => doneKey.has(`${sid}|${yesterday}|${it.id}`)).length;
      if (doneY < dueY.length) {
        rows.push({ staff_id: boss, subject_id: sid, kind: "checklist_missed", for_date: yesterday, done_count: doneY, total_count: dueY.length });
      }
    }
  }

  let notified = 0;
  if (rows.length) {
    const { error: upErr } = await admin
      .from("checklist_notifications")
      .upsert(rows, { onConflict: "staff_id,subject_id,kind,for_date", ignoreDuplicates: true });
    if (upErr) return json({ error: upErr.message }, 500);
    notified = rows.length;
  }
  console.log(`[check-checklists] ${today}: ${rows.length} notifications`);
  return json({ today, yesterday, notified });
});

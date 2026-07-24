// Drains the whatsapp_outbox queue and sends each row via the Meta WhatsApp Cloud API. The app
// enqueues structured sends (recipient + approved template + variables) from wherever it raises an
// in-app notification (see shared.js waEnqueue); this function — run on a schedule — turns those into
// actual WhatsApp messages, resolving each recipient's phone + opt-in at send time.
//
// Run it on a cron (pg_cron + pg_net, same pattern as check-due-tasks — see whatsapp/README.md).
// Sends are best-effort: a row with no phone / no consent is marked done-with-reason so it leaves the
// queue; a Cloud API failure bumps `attempts` and is retried next run.
//
// Self-contained (inlines CORS/json) so it pastes standalone into the Dashboard editor.
//
// Secrets: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION (default v21.0), CRON_SECRET,
//          SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-cron-secret",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const digits = (s: string) => String(s || "").replace(/[^\d]/g, "");

const MAX_ATTEMPTS = 5;
const BATCH = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }

  const token = Deno.env.get("WHATSAPP_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const apiVersion = Deno.env.get("WHATSAPP_API_VERSION") || "v21.0";
  if (!token || !phoneId) return json({ error: "WhatsApp secrets not configured" }, 500);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: rows, error } = await admin
    .from("whatsapp_outbox")
    .select("id, recipient_staff_id, template, variables, attempts")
    .is("sent_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) return json({ error: error.message }, 500);
  if (!rows || !rows.length) return json({ drained: 0, sent: 0, skipped: 0, failed: 0 });

  // Resolve recipients' phone + consent in one query.
  const ids = [...new Set(rows.map((r) => r.recipient_staff_id).filter(Boolean))];
  const { data: staff } = await admin.from("staff").select("id, phone, wa_opt_in").in("id", ids);
  const byId: Record<string, { phone: string | null; wa_opt_in: boolean }> = {};
  for (const s of staff || []) byId[s.id] = { phone: s.phone, wa_opt_in: s.wa_opt_in };

  let sent = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const who = row.recipient_staff_id ? byId[row.recipient_staff_id] : null;
    const to = digits(who?.phone || "");

    // No phone or no consent → drop from the queue (won't ever be sendable) with a reason.
    if (!who || !who.wa_opt_in || !to) {
      await admin.from("whatsapp_outbox").update({
        sent_at: new Date().toISOString(),
        last_error: !who ? "recipient not found" : !who.wa_opt_in ? "not opted in" : "no phone",
      }).eq("id", row.id);
      skipped++;
      continue;
    }

    const vars: unknown[] = Array.isArray(row.variables) ? row.variables : [];
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: row.template,
        language: { code: "en_US" },
        ...(vars.length
          ? { components: [{ type: "body", parameters: vars.map((v) => ({ type: "text", text: String(v) })) }] }
          : {}),
      },
    };

    try {
      const resp = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(result?.error?.message || `HTTP ${resp.status}`);

      const waId = result?.messages?.[0]?.id || null;
      await admin.from("whatsapp_outbox").update({ sent_at: new Date().toISOString(), wa_message_id: waId }).eq("id", row.id);
      await admin.from("whatsapp_log").insert({ to, template: row.template, wa_message_id: waId });
      sent++;
    } catch (e) {
      await admin.from("whatsapp_outbox").update({
        attempts: (row.attempts || 0) + 1,
        last_error: String((e as Error)?.message || e),
      }).eq("id", row.id);
      failed++;
    }
  }

  console.log(`[whatsapp-dispatch] drained ${rows.length}: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  return json({ drained: rows.length, sent, skipped, failed });
});

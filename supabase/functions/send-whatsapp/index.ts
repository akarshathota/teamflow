// Sends a pre-approved WhatsApp template message via the Meta WhatsApp Cloud API.
//
// Templates live in whatsapp/templates.json and must be APPROVED in your Meta WhatsApp Business
// account before they can be sent (see whatsapp/README.md). This function just fills a template's
// {{1}}, {{2}}… variables and posts it to the Cloud API — it does not create/approve templates.
//
// Self-contained (inlines CORS/json like the other functions) so it pastes standalone into the
// Supabase Dashboard function editor — see supabase/OPERATIONS.md.
//
// Secrets to set (Dashboard → Edge Functions → Secrets, or `supabase secrets set`):
//   WHATSAPP_TOKEN            - a permanent System-User access token with whatsapp_business_messaging
//   WHATSAPP_PHONE_NUMBER_ID  - the Phone Number ID of your WABA sender
//   WHATSAPP_API_VERSION      - optional, defaults to v21.0
//   WA_SEND_SECRET            - shared secret; callers must send it as the x-wa-secret header
//                              (so a leaked anon key alone can't trigger business-initiated messages)
//
// Request (POST, JSON):
//   { "to": "+919876543210",          // recipient in E.164 (or without +, digits only)
//     "template": "task_assigned",     // must match an approved template name
//     "language": "en_US",             // optional, defaults to en_US
//     "variables": ["Ravi","Chandu","Fix projector","High","25 Jul 2026"],  // body {{1}}..{{n}} in order
//     "buttonUrlParam": "task/123" }   // optional, only for templates whose URL button is dynamic

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-wa-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// digits-only E.164 (Cloud API wants no "+", no spaces/dashes)
function normalizePhone(raw: string): string {
  return String(raw || "").replace(/[^\d]/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Gate: require the shared send-secret. This function initiates outbound messages, so it must not
  // be callable with just a public anon key. (A cron/other function passes the same header.)
  const secret = req.headers.get("x-wa-secret");
  if (!secret || secret !== Deno.env.get("WA_SEND_SECRET")) {
    return json({ error: "Unauthorized" }, 401);
  }

  const token = Deno.env.get("WHATSAPP_TOKEN");
  const phoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const apiVersion = Deno.env.get("WHATSAPP_API_VERSION") || "v21.0";
  if (!token || !phoneId) return json({ error: "WhatsApp secrets not configured" }, 500);

  let body: {
    to?: string;
    template?: string;
    language?: string;
    variables?: (string | number)[];
    buttonUrlParam?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const to = normalizePhone(body.to || "");
  const template = (body.template || "").trim();
  if (!to || !template) return json({ error: "`to` and `template` are required" }, 400);

  const components: unknown[] = [];
  const vars = body.variables || [];
  if (vars.length) {
    components.push({
      type: "body",
      parameters: vars.map((v) => ({ type: "text", text: String(v) })),
    });
  }
  // Only for templates whose URL button carries a variable (the sample templates use static URLs and
  // don't need this).
  if (body.buttonUrlParam) {
    components.push({
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: String(body.buttonUrlParam) }],
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: body.language || "en_US" },
      ...(components.length ? { components } : {}),
    },
  };

  const resp = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    console.error("[send-whatsapp] Cloud API error:", JSON.stringify(result));
    return json({ error: "WhatsApp send failed", details: result }, resp.status);
  }
  // Optional: record the send for auditing. Kept best-effort so a logging failure doesn't fail the send.
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    await admin.from("whatsapp_log").insert({
      to,
      template,
      wa_message_id: result?.messages?.[0]?.id || null,
    });
  } catch (_e) { /* whatsapp_log table is optional — ignore if it doesn't exist */ }

  return json({ ok: true, to, template, wa_message_id: result?.messages?.[0]?.id || null });
});

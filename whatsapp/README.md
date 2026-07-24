# TeamFlow — WhatsApp notification templates

Pre-approved WhatsApp Business templates for TeamFlow's notification events, plus a Supabase Edge
Function to send them via the Meta **WhatsApp Cloud API**.

- `templates.json` — 12 templates in Cloud API *creation* format, ready to submit for approval.
- `../supabase/functions/send-whatsapp/index.ts` — sends an approved template to a recipient.

> **Flow:** you (1) submit each template to Meta and wait for approval, (2) set the secrets, (3) deploy
> the function, (4) call it from the app / a cron when an event fires. Templates **must be approved
> before they can be sent.**

---

## The templates

All are **UTILITY** (transactional) — the category that approves fastest and can be sent outside the
24-hour customer-service window. Each `{{n}}` is filled at send time from TeamFlow data.

| Template | Fires when… | `variables` (in order) → TeamFlow data |
|---|---|---|
| `task_assigned` | a task is assigned to someone (New task / reassign) | assignee first name, assigner name, task title (`t.t`), priority label, due date (`dmy(t.date)`) |
| `task_reminder` | overdue/due nudge (the `check-due-tasks` cron, or a manual Remind) | name, state (`"overdue"` / `"due today"`), task title, due date |
| `report_received` | a repair report / supply request is submitted | requester first name, `"maintenance report"`/`"supply request"`, ticket # (`ticket_no`), title |
| `report_assigned` | a report/request is routed/assigned to a fixer | fixer first name, ticket #, kind, title, target date |
| `ticket_closed` | management closes a ticket (v153/v165) | requester first name, ticket #, closer (`"the management team"`), title |
| `supply_request_approved` | a supply request is approved for procurement | requester first name, ticket #, item |
| `completion_approval_needed` | an assignee marks a task done & it needs approval | approver first name, who completed it, task title |
| `extension_requested` | an assignee requests a due-date extension | approver first name, requester, task title, new date, reason |
| `extension_decision` | approver approves/rejects an extension | assignee first name, task title, `"approved"`/`"rejected"`, due date |
| `daily_report_reminder` | end-of-day nudge to submit the daily report | name, date |
| `escalation_notice` | a daily-report issue is escalated up the chain | recipient first name, escalator (name + dept), issue, priority |
| `account_welcome` | a new staff account is created | name, org name (`orgName()`), username. **No password is ever sent** — the user sets it via "Forgot password". |

---

## 1. Submit the templates for approval

Two ways:

**A. Meta WhatsApp Manager UI** (no code) — Business Settings → WhatsApp Manager → Message Templates →
Create, and re-type each template from `templates.json`. Slower but visual.

**B. Cloud API** (bulk) — POST each object to the Business Account's `message_templates` endpoint:

```bash
WABA_ID=...            # your WhatsApp Business Account ID
TOKEN=...              # a token with whatsapp_business_management

jq -c '.[]' whatsapp/templates.json | while read -r tpl; do
  curl -s -X POST "https://graph.facebook.com/v21.0/${WABA_ID}/message_templates" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    -d "${tpl}" | jq '{name: .name, id: .id, status: .status, error: .error.message}'
done
```

Approval is usually minutes to a few hours. Check status in WhatsApp Manager; only `APPROVED`
templates can be sent.

## 2. Set the function secrets

```bash
supabase secrets set \
  WHATSAPP_TOKEN=<system-user token with whatsapp_business_messaging> \
  WHATSAPP_PHONE_NUMBER_ID=<your sender's Phone Number ID> \
  WA_SEND_SECRET=<any long random string you invent>
# optional: WHATSAPP_API_VERSION=v21.0
```

`WA_SEND_SECRET` gates the function so a leaked public anon key alone can't fire off messages —
every caller must send it as the `x-wa-secret` header.

## 3. Deploy the function

`supabase functions deploy send-whatsapp` — or paste `index.ts` into the Dashboard function editor
(the way the other functions here are deployed; see `../supabase/OPERATIONS.md`).

## 4. Send

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/send-whatsapp" \
  -H "Content-Type: application/json" \
  -H "x-wa-secret: <WA_SEND_SECRET>" \
  -d '{
    "to": "+919876543210",
    "template": "task_assigned",
    "variables": ["Ravi", "Chandu", "Fix the 2nd-floor projector", "High", "25 Jul 2026"]
  }'
```

To wire it into the app, call this from wherever TeamFlow already raises an in-app notification
(e.g. `notifyEvent` on the client, or the `check-due-tasks` cron for reminders) — look up the
recipient's phone from `staff`, then POST `{to, template, variables}`. You'll need a `staff.phone`
column (E.164) to have someone to message.

---

## Optional: log sends for auditing

The function best-effort-inserts into a `whatsapp_log` table if it exists (silently skips it if not):

```sql
create table if not exists whatsapp_log (
  id uuid primary key default gen_random_uuid(),
  "to" text not null,
  template text not null,
  wa_message_id text,
  sent_at timestamptz not null default now()
);
alter table whatsapp_log enable row level security;
-- writes come only from the service_role inside the Edge Function; no client policy needed.
```

---

## Compliance notes (important)

- **Opt-in is required.** Meta requires each recipient to have opted in to receive business-initiated
  messages from you. Capture consent (e.g. a checkbox when adding staff) and store it before sending.
- **UTILITY vs MARKETING.** These are all transactional (UTILITY). Don't add promotional copy — that
  reclassifies a template as MARKETING, which needs opt-in and is rate-limited.
- **No secrets in messages.** `account_welcome` deliberately never sends a password; the user sets it
  via the app. Keep it that way.
- **Phone format.** Send E.164 (`+91…`); the function strips non-digits before calling the API.
- **Editing a template** re-triggers Meta review. Changing variable *count/order* means updating the
  matching `variables` array in whatever calls the function.

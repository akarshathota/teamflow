# TeamFlow — WhatsApp notification templates

Pre-approved WhatsApp Business templates for TeamFlow's notification events, plus a Supabase Edge
Function to send them via the Meta **WhatsApp Cloud API**.

- `templates.json` — 12 templates in Cloud API *creation* format, ready to submit for approval.
- `../supabase/functions/send-whatsapp/index.ts` — ad-hoc sender (send one template to one number; for testing / one-offs).
- `../supabase/functions/whatsapp-dispatch/index.ts` — **the cron dispatcher**: drains the `whatsapp_outbox` queue the app writes to, and sends each row. This is what the app actually uses.
- migration `20260724000007_whatsapp_wiring.sql` — adds `staff.phone` + `staff.wa_opt_in`, the `whatsapp_outbox` queue, and the `whatsapp_log` audit table.

> **Flow:** you (1) submit each template to Meta and wait for approval, (2) set the secrets, (3) deploy
> the functions, (4) schedule the dispatcher cron. Once that's done the app sends automatically —
> see **“How it's wired into the app”** below. Templates **must be approved before they can be sent.**

## How it's wired into the app (v166)

The app never holds the WhatsApp token. Instead, when an event fires it **enqueues** a structured send
and a server-side cron **dispatches** it:

```
app event ──► waEnqueue(recipientStaffId, template, [vars])   (shared.js — a plain RLS-gated INSERT)
          └─► whatsapp_outbox row
                        │  (every minute, or your chosen interval)
   whatsapp-dispatch ◄──┘  reads unsent rows, looks up the recipient's phone + wa_opt_in,
          └─► Meta Cloud API   sends only if they have a number AND opted in; marks the row done.
```

- **Consent + contact** live on `staff` (`phone`, `wa_opt_in`). Set them in the console: open a person
  in **People & roles → 💬 WhatsApp notifications** (number + an opt-in checkbox). Nothing sends
  without the checkbox ticked.
- **Enqueue is best-effort** — `waEnqueue` never throws and never blocks the in-app notification, so
  WhatsApp is purely additive.
- **Events wired (v166–v167):** all 11 templates fire from the app now, via `waNotify(person, template,
  restVars)` (shared.js) — every template's `{{1}}` is the recipient's own first name, so callers pass
  only `{{2}}…`:
  - `task_assigned` — task created/reassigned (console + mobile) → each assignee
  - `task_reminder` — the `check-due-tasks` cron → each overdue/due-today assignee
  - `report_received` — report/supply submitted (console + mobile) → the requester
  - `report_assigned` — maintenance report assigned (console + mobile) → the fixer
  - `supply_request_approved` — supply approved (console + mobile) → the requester
  - `ticket_closed` — management closes a ticket (console + mobile) → the requester
  - `completion_approval_needed` — task submitted for approval (console + mobile) → the approver (`approverOf` = instructor, else assignee's boss)
  - `extension_requested` — extension requested (console + mobile) → the approver
  - `extension_decision` — extension approved/rejected (console + mobile) → the assignee
  - `escalation_notice` — daily-report issue escalated (console + mobile) → the escalator's boss
  - `account_welcome` — `create-staff-account` edge fn → the new staff (fires only if consent was captured)
  - `daily_report_reminder` — the `daily-report-reminder` cron → everyone with a login (non-admin) who
    hasn't filed today's report by evening

### Schedule the dispatcher

Same pg_cron + pg_net pattern as `check-due-tasks`. Runs every minute; sends only when there's
something queued:

```sql
select cron.schedule('whatsapp-dispatch', '* * * * *', $$
  select net.http_post(
    url    := 'https://<project-ref>.functions.supabase.co/whatsapp-dispatch',
    headers:= jsonb_build_object('Content-Type','application/json','x-cron-secret','<CRON_SECRET>')
  );
$$);
```

Adding a new event later is one `waNotify(recipientPerson, template, restVars)` call at the point the
app raises the matching in-app notification — the variable order is in the template table below.

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

## 3. Deploy the functions

`supabase functions deploy whatsapp-dispatch` (the one the app uses), `supabase functions deploy
daily-report-reminder` (the evening nudge cron), and, if you want the ad-hoc sender too,
`supabase functions deploy send-whatsapp` — or paste each `index.ts` into the Dashboard function
editor (the way the other functions here are deployed; see `../supabase/OPERATIONS.md`). Also redeploy
`check-due-tasks` and `create-staff-account` (they now enqueue `task_reminder` / `account_welcome`).
Schedule the `daily-report-reminder` cron too — see
`../supabase/migrations/20260724000008_daily_report_reminder_cron.sql`.
The `staff.phone` / `wa_opt_in` columns and the `whatsapp_outbox` / `whatsapp_log` tables are already
created by migration `20260724000007_whatsapp_wiring.sql`.

Then schedule the dispatcher cron (see *How it's wired into the app → Schedule the dispatcher* above).

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

## Auditing

Every successful send is logged to `whatsapp_log` (`to`, `template`, `wa_message_id`, `sent_at`),
created by the migration. The `whatsapp_outbox` row also keeps its own `sent_at` / `attempts` /
`last_error` — a row with `last_error = 'not opted in'` / `'no phone'` was correctly skipped, not
failed. Both tables are service-role-only (no client can read the queue back out).

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

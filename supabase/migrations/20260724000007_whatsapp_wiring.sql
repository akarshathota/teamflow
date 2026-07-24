-- WhatsApp notification wiring (phase 1): recipient contact + consent, an outbox queue the client
-- enqueues into (no secret in the browser), and a send log. The whatsapp-dispatch Edge Function
-- (cron) drains the outbox → Meta Cloud API; see whatsapp/README.md. Sends are additive + best-effort;
-- the app's in-app notifications are unchanged.

-- Per-staff contact + explicit opt-in. Consent is required before any business-initiated WhatsApp.
alter table staff add column if not exists phone     text;
alter table staff add column if not exists wa_opt_in boolean not null default false;

-- Outbox: the app inserts one structured row per WhatsApp it wants sent (recipient + approved template
-- name + ordered variables). The dispatcher resolves the phone/opt-in at send time and marks it sent.
create table if not exists whatsapp_outbox (
  id                 uuid primary key default gen_random_uuid(),
  recipient_staff_id uuid references staff(id) on delete cascade,
  template           text not null,
  variables          jsonb not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz,
  attempts           int not null default 0,
  last_error         text,
  wa_message_id      text
);
create index if not exists whatsapp_outbox_unsent on whatsapp_outbox (created_at) where sent_at is null;

alter table whatsapp_outbox enable row level security;
-- Any authenticated staff may enqueue (they're acting inside the app when an event fires). There is no
-- client SELECT/UPDATE/DELETE policy, so the queue is drained only by the service_role dispatcher —
-- clients can write a send request but can't read the queue or others' recipients back out.
create policy wa_outbox_insert on whatsapp_outbox for insert with check (auth_staff_id() is not null);

-- Audit log of actual sends (written by the dispatcher, service_role only).
create table if not exists whatsapp_log (
  id            uuid primary key default gen_random_uuid(),
  "to"          text not null,
  template      text not null,
  wa_message_id text,
  sent_at       timestamptz not null default now()
);
alter table whatsapp_log enable row level security;

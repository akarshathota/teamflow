-- Security hardening (WhatsApp pipeline review): make every client-enqueued WhatsApp attributable.
--
-- The old whatsapp_outbox INSERT policy was `with check (auth_staff_id() is not null)` — any
-- authenticated user could POST a row with ANY recipient, template and variables, so a staff member
-- could anonymously spam colleagues or social-engineer them (the {{n}} variable slots are
-- attacker-controlled and the message arrives as a legit "TeamFlow" WhatsApp). Bind each row to the
-- person who created it so a send can never be anonymous or forged onto someone else — the same lever
-- the v155 notification actor-spoof fix removed.
--
-- enqueued_by defaults to auth_staff_id() (the caller) and the policy requires it to equal
-- auth_staff_id(), so a client can neither omit it nor set it to somebody else. Edge functions insert
-- via service_role (RLS bypassed), leaving enqueued_by NULL = a system/server send.
alter table whatsapp_outbox add column if not exists enqueued_by uuid references staff(id) default auth_staff_id();

drop policy wa_outbox_insert on whatsapp_outbox;
create policy wa_outbox_insert on whatsapp_outbox for insert
  with check (auth_staff_id() is not null and enqueued_by = auth_staff_id());

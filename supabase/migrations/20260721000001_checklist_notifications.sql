-- Checklist reminders / nudges. Mirrors task_notifications: per-recipient in-app rows, written only
-- by the check-checklists Edge Function (service_role, bypasses RLS), read/marked-read by the
-- recipient. Runs each morning (IST) and produces two kinds:
--   checklist_today  -> to the OWNER: "you have N checklist items today" (start-of-day nudge)
--   checklist_missed -> to the BOSS:  "<person> left yesterday's checklist incomplete" (was not absent)
-- Idempotent via unique(staff_id, subject_id, kind, for_date) so re-running the same day is a no-op.

create table if not exists checklist_notifications (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,   -- recipient
  subject_id uuid references staff(id) on delete cascade,          -- whose checklist (= staff_id for self-nudge)
  kind text not null check (kind in ('checklist_today','checklist_missed')),
  for_date date not null,
  done_count int,
  total_count int,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (staff_id, subject_id, kind, for_date)
);

alter table checklist_notifications enable row level security;
-- recipient can see / mark-read their own; no client insert/delete (service_role writes only)
drop policy if exists cl_notif_select on checklist_notifications;
create policy cl_notif_select on checklist_notifications for select using (staff_id = auth_staff_id());
drop policy if exists cl_notif_update on checklist_notifications;
create policy cl_notif_update on checklist_notifications for update
  using (staff_id = auth_staff_id()) with check (staff_id = auth_staff_id());

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='checklist_notifications')
    then alter publication supabase_realtime add table checklist_notifications; end if;
end $$;

-- morning run, just after the task cron (03:00 UTC = 08:30 IST); reuses the same CRON_SECRET
select cron.schedule(
  'check-checklists-daily',
  '0 3 * * *',
  $$
  select net.http_post(
    url := 'https://fumggrcamegejihenkhb.supabase.co/functions/v1/check-checklists',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret','66576647335fe0b63db71e50ac201d995121abb49bec9c0b'),
    body := '{}'::jsonb
  );
  $$
);

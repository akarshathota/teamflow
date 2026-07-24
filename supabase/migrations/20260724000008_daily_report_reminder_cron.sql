-- Schedules the daily-report-reminder Edge Function to run once each evening, so anyone who hasn't
-- filed their daily report gets a WhatsApp nudge before the day closes (whatsapp-dispatch only
-- actually messages people who have a phone AND opted in). Independent of anyone having the app open.
--
-- REPLACE_WITH_CRON_SECRET below before running this in the SQL Editor: use the SAME value you set as
-- the Edge Functions' CRON_SECRET secret (`supabase secrets set CRON_SECRET=<value>`). Don't commit
-- the real value — substitute it only in the SQL Editor, not in this tracked file.
--
-- Requires the whatsapp-dispatch cron to also be scheduled (see whatsapp/README.md) so the rows this
-- enqueues actually get sent.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'daily-report-reminder',
  '0 13 * * *', -- 13:00 UTC = 18:30 IST (evening nudge; adjust to your end-of-day)
  $$
  select net.http_post(
    url := 'https://fumggrcamegejihenkhb.supabase.co/functions/v1/daily-report-reminder',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'REPLACE_WITH_CRON_SECRET'),
    body := '{}'::jsonb
  );
  $$
);

-- Schedules the check-due-tasks Edge Function to run daily, independent of anyone opening the
-- app, so overdue/due-today detection (and eventually notifications) doesn't depend on a browser
-- being open. Detection only for now — see the function for the TODO on wiring up actual sends.
--
-- REPLACE_WITH_CRON_SECRET below before running this in the SQL Editor: generate a random value
-- (e.g. `openssl rand -hex 24`), set it as the Edge Function's CRON_SECRET secret
-- (`supabase secrets set CRON_SECRET=<value>`), and paste the same value here. Don't commit the
-- real value to git — edit this substitution only in the SQL Editor, not in the tracked file.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'check-due-tasks-daily',
  '30 2 * * *', -- 02:30 UTC = 08:00 IST
  $$
  select net.http_post(
    url := 'https://fumggrcamegejihenkhb.supabase.co/functions/v1/check-due-tasks',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'REPLACE_WITH_CRON_SECRET'),
    body := '{}'::jsonb
  );
  $$
);

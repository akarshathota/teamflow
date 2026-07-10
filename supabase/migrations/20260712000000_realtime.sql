-- Enable Realtime (postgres_changes) on the tables both apps need to stay in sync on.
-- Change events are filtered by each subscriber's own RLS SELECT policy automatically —
-- a client only receives events for rows it could already SELECT, same boundary as every
-- other read in this app, no separate realtime-specific access control needed.

alter publication supabase_realtime add table staff, tasks, task_assignees, task_log, requests, notices;

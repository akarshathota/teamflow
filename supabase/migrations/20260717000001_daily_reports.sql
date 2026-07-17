-- Daily Report today is UI-only: submitting it shows a toast and persists nothing except any
-- issue/incident raised alongside it (report_issues). There is no way to answer "did person X
-- submit a report on date Y" or browse past submissions. This table gives the report itself a
-- row, freezing the task-completion snapshot that was actually on screen at submit time — same
-- "compute once, trust the frozen value forever" philosophy report_issues already uses for
-- escalated_to/hop_count, rather than recomputing live from `tasks` later (which would answer "how
-- do things stand now", not "what did submitting this report actually show that day").
--
-- report_date is client-supplied (the same iso(TODAY) local-date string every other date field in
-- this app already uses — task due dates, calendar, etc.), not a server-side current_date default.
-- This project's Postgres session runs in UTC while the org is not, so current_date would silently
-- misfile any report submitted late evening local time under the wrong calendar day, which is
-- exactly the value the "N of M submitted today" indicator compares against. Client-local is also
-- what every other date comparison in both apps already assumes — a server default would've been
-- the odd one out, not the consistent choice.
create table daily_reports (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references staff(id),
  report_date date not null,
  completed_count int not null default 0,
  overdue_count int not null default 0,
  pending_count int not null default 0,
  created_at timestamptz not null default now()
);

create index daily_reports_created_by_idx on daily_reports (created_by);
create index daily_reports_report_date_idx on daily_reports (report_date);

alter table daily_reports enable row level security;

create policy daily_reports_insert on daily_reports for insert
  with check (auth_staff_id() is not null and created_by = auth_staff_id());

-- Same shape as report_issues_select's is_in_scope reads: is_in_scope(viewer,target) is already
-- true for viewer=target (self) and for Administrator/Management org-wide, so this one clause
-- covers "see your own past reports" and "see everyone below you" both.
create policy daily_reports_select on daily_reports for select
  using (is_in_scope(auth_staff_id(), created_by));

-- Keep both apps' live subscriptions in sync with everything else (20260712000000_realtime.sql).
alter publication supabase_realtime add table daily_reports;

-- Links an issue/incident raised during a Daily Report submission back to that submission, so
-- reviewing a report in the console can show "raised alongside this" instead of guessing from
-- created_by + timestamp proximity. Nullable: report_issues rows raised outside a Daily Report
-- (there's no other path today, but nothing enforces that) simply have no report to point at.
-- Deliberately not part of any RLS check — report_issues_insert/select already gate on
-- created_by/escalated_to/is_in_scope exactly as before; this column is display linkage only.
alter table report_issues add column daily_report_id uuid references daily_reports(id);
create index report_issues_daily_report_id_idx on report_issues (daily_report_id);

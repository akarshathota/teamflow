-- One report per person per day, enforced in the schema instead of client code.
-- v53's client-side dedupe (select existing row, then branch insert/update) still had a
-- check-then-write race: two rapid submits could both pass the lookup and insert twice.
-- With this constraint the client collapses to a single upsert(onConflict) and the race
-- is closed at the database, not papered over in JS. Verified no existing duplicate
-- (created_by, report_date) pairs before adding (the one historical dupe was merged Jul 18).
alter table daily_reports add constraint daily_reports_one_per_day unique (created_by, report_date);

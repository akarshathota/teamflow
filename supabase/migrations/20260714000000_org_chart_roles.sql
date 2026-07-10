-- Adds 'Team Lead' as a real tier between 'Team Member' (Jr Manager) and 'Teacher' (Staff), for
-- the People & roles org-chart view. is_in_scope()/descendants() already walk boss_id generically
-- with no role-order assumption, so this needs no RLS change — only the CHECK constraint moves.
--
-- Also adds temporary-cover tracking for the "promote temporarily, revert later" flow: a person
-- covering a vacant position keeps their own row, but their pre-promotion role/department/boss
-- and the set of reports that were originally theirs (vs. inherited from the vacated position)
-- need to be remembered somewhere durable so a later revert can rebuild both sides correctly.

alter table staff drop constraint staff_role_check;
alter table staff add constraint staff_role_check
  check (role in ('Administrator','Management','Manager','Team Lead','Team Member','Teacher'));

alter table staff add column temp_covering boolean not null default false;
alter table staff add column temp_cover_snapshot jsonb;
comment on column staff.temp_cover_snapshot is
  'When temp_covering, holds {home_role, home_department, home_boss_id, home_team_ids} captured at
   promotion time — home_team_ids is the set of staff.id that were this person''s own reports
   before covering, so revert can tell those apart from reports inherited from the vacated role.';

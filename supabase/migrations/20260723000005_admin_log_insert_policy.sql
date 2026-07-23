-- Let admins log their in-app actions to admin_activity_log from the client (the edge functions
-- already log staff-account events via service_role; this covers task delete, promote/demote,
-- permission changes, etc.). Any authenticated user may insert a row ONLY for themselves
-- (actor_staff_id = auth_staff_id()), so the actor can't be forged; the table stays admin/mgmt-read.
-- Applied to prod 2026-07-23.
do $$ begin
  if not exists (select 1 from pg_policies where tablename='admin_activity_log' and policyname='admin_activity_log_insert') then
    create policy admin_activity_log_insert on admin_activity_log for insert to authenticated
      with check (actor_staff_id = auth_staff_id());
  end if;
end $$;

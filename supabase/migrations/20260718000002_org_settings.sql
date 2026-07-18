-- Organisation display name, editable in-app instead of hardcoded ("Greenwood School" was a
-- string literal in the mobile file; console never showed one at all). Single-row table via the
-- boolean-primary-key trick: id is always true, so a second row is impossible and the client
-- can address the row as eq('id', true) without ever knowing a UUID.
create table org_settings (
  id boolean primary key default true check (id),
  name text not null
);
insert into org_settings (id, name) values (true, 'JHPS');

alter table org_settings enable row level security;
-- every signed-in staff member sees the org name (it's on every screen);
-- only the Administrator can change it — checked against the real staff row, not client claims.
create policy org_settings_select on org_settings for select
  using (auth_staff_id() is not null);
create policy org_settings_update on org_settings for update
  using (exists (select 1 from staff where id = auth_staff_id() and role = 'Administrator'))
  with check (exists (select 1 from staff where id = auth_staff_id() and role = 'Administrator'));

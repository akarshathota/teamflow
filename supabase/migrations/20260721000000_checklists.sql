-- Checklists: a recurring per-person checklist, curated by any manager ABOVE the person,
-- ticked off by the person themselves. Completion is stored per occurrence date, so "reset"
-- is implicit (a new day simply has no completion rows yet) — no cron needed, unlike tasks.
--
-- Reuses is_in_scope(viewer, target) (auth_and_rls + admin_role_scope): true when the viewer is
-- Administrator/Management, is the target, or is an ancestor of the target in the boss_id chain.
-- So "a manager above the person (or admin/mgmt)" = is_in_scope(viewer, target) AND viewer <> target.

-- ---- tables ----
create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,   -- whose checklist this is
  body text not null,
  freq text not null check (freq in ('daily','weekly','monthly','yearly')),
  dow smallint check (dow between 0 and 6),         -- weekly: 0=Mon .. 6=Sun
  dom smallint check (dom between 1 and 31),          -- monthly day-of-month
  y_day smallint check (y_day between 1 and 31),      -- yearly day
  y_mon smallint check (y_mon between 1 and 12),      -- yearly month
  sort_order int not null default 0,
  archived boolean not null default false,            -- soft delete (keeps completion history intact)
  created_at timestamptz not null default now(),
  last_edited_by uuid references staff(id) on delete set null,
  last_edited_at timestamptz not null default now()
);
create index if not exists checklist_items_staff_idx on checklist_items(staff_id) where not archived;

-- one row = an item completed on a given occurrence date (absence of row = not done)
create table if not exists checklist_completions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references checklist_items(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,    -- denormalised owner (RLS + queries)
  occ_date date not null,
  done_at timestamptz not null default now(),
  unique (item_id, occ_date)
);
create index if not exists checklist_completions_staff_date_idx on checklist_completions(staff_id, occ_date);

-- a manager-marked leave day (the day's checklist is then excused)
create table if not exists checklist_absences (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  absent_date date not null,
  marked_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (staff_id, absent_date)
);

-- the daily report freezes the day's checklist status at submit time (mirrors task_snapshot)
alter table daily_reports add column if not exists checklist_snapshot jsonb;

-- ---- stamp the real editor on every item write (client can't spoof it) ----
create or replace function checklist_stamp_editor() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.last_edited_by := auth_staff_id();
  new.last_edited_at := now();
  return new;
end $$;
drop trigger if exists checklist_items_stamp on checklist_items;
create trigger checklist_items_stamp before insert or update on checklist_items
  for each row execute function checklist_stamp_editor();

-- ---- RLS ----
alter table checklist_items enable row level security;
alter table checklist_completions enable row level security;
alter table checklist_absences enable row level security;

-- items: read anyone in your scope (yourself / below you / admin-mgmt);
--        edit only a manager ABOVE the person (or admin/mgmt) — never your own list.
drop policy if exists checklist_items_select on checklist_items;
create policy checklist_items_select on checklist_items for select
  using (is_in_scope(auth_staff_id(), staff_id));
drop policy if exists checklist_items_insert on checklist_items;
create policy checklist_items_insert on checklist_items for insert
  with check (is_in_scope(auth_staff_id(), staff_id) and auth_staff_id() <> staff_id);
drop policy if exists checklist_items_update on checklist_items;
create policy checklist_items_update on checklist_items for update
  using (is_in_scope(auth_staff_id(), staff_id) and auth_staff_id() <> staff_id)
  with check (is_in_scope(auth_staff_id(), staff_id) and auth_staff_id() <> staff_id);
drop policy if exists checklist_items_delete on checklist_items;
create policy checklist_items_delete on checklist_items for delete
  using (is_in_scope(auth_staff_id(), staff_id) and auth_staff_id() <> staff_id);

-- completions: readable up the chain; only the owner ticks their own items (tick = insert, untick = delete)
drop policy if exists checklist_completions_select on checklist_completions;
create policy checklist_completions_select on checklist_completions for select
  using (is_in_scope(auth_staff_id(), staff_id));
drop policy if exists checklist_completions_insert on checklist_completions;
create policy checklist_completions_insert on checklist_completions for insert
  with check (staff_id = auth_staff_id()
    and exists (select 1 from checklist_items i where i.id = item_id and i.staff_id = auth_staff_id()));
drop policy if exists checklist_completions_delete on checklist_completions;
create policy checklist_completions_delete on checklist_completions for delete
  using (staff_id = auth_staff_id());

-- absences: readable up the chain; a manager above (or admin/mgmt) marks/clears leave
drop policy if exists checklist_absences_select on checklist_absences;
create policy checklist_absences_select on checklist_absences for select
  using (is_in_scope(auth_staff_id(), staff_id));
drop policy if exists checklist_absences_insert on checklist_absences;
create policy checklist_absences_insert on checklist_absences for insert
  with check (is_in_scope(auth_staff_id(), staff_id) and auth_staff_id() <> staff_id
    and marked_by = auth_staff_id());
drop policy if exists checklist_absences_delete on checklist_absences;
create policy checklist_absences_delete on checklist_absences for delete
  using (is_in_scope(auth_staff_id(), staff_id) and auth_staff_id() <> staff_id);

-- ---- realtime (idempotent) ----
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='checklist_items')
    then alter publication supabase_realtime add table checklist_items; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='checklist_completions')
    then alter publication supabase_realtime add table checklist_completions; end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='checklist_absences')
    then alter publication supabase_realtime add table checklist_absences; end if;
end $$;

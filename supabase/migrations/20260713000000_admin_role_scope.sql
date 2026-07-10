-- is_in_scope() gave Administrator/Management org-wide visibility "for free" purely because the
-- original 5 demo accounts (Priya, Rajesh) happened to sit at/near the root of the boss_id tree —
-- the migration that introduced it said so explicitly, no role check, just position. That breaks
-- silently (not an error, just far fewer rows returned) the moment an Administrator/Management
-- account is created anywhere else in the tree: caught this by creating a second Administrator
-- (reporting to a Manager, as any realistically-hired admin might) and watching their staff/task
-- counts collapse to just their own boss chain instead of the whole org.
--
-- Fix: check the role directly instead of relying on tree position. Same intent as the original
-- comment, actually implemented rather than coincidental.
create or replace function is_in_scope(viewer_id uuid, target_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  with recursive chain as (
    select id, boss_id from staff where id = target_id
    union all
    select s.id, s.boss_id from staff s join chain c on s.id = c.boss_id
  )
  select viewer_id is not null and target_id is not null
    and (
      (select role in ('Administrator','Management') from staff where id = viewer_id)
      or viewer_id = target_id
      or exists (select 1 from chain where id = viewer_id)
    )
$$;

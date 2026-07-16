-- Daily Report feature: issues/incidents raised as part of a Daily Report, escalated up the
-- exact same boss_id chain the rest of the app already walks. One field carries the authority:
-- escalated_to — whoever currently holds the issue. Raising one points it at your own boss;
-- escalating moves that pointer one hop further up. Both are computed server-side by trigger,
-- never trusted from the client — same reasoning as staff_prevent_self_escalation_trg
-- (20260716000000_close_rls_gaps.sql): RLS policies can't compute a value from the caller's own
-- boss_id, only validate one, so this needs a trigger rather than a tighter policy expression.
--
-- Deliberately separate from `requests` (the existing maintenance-issue flow): that one has a
-- single fixed destination (the Maintenance department head) and is about broken things. This is
-- about operational/managerial concerns that climb the reporting chain, one hop at a time, and
-- can be escalated further or resolved locally by whoever currently holds them.
--
-- Attachments reuse the existing private `attachments` storage bucket (20260711000000_storage.sql)
-- via the client's uploadFile()/FileChip — no bucket change needed. Stored as a jsonb array, same
-- shape as requests.files, to allow more than one file per issue even though today's UI only adds one.

create table report_issues (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references staff(id),      -- original raiser, never changes
  escalated_to uuid references staff(id),               -- current holder; whoever it's "in the inbox of"
  last_escalated_by uuid references staff(id),          -- most recent person who forwarded it (null if never)
  hop_count int not null default 0,                     -- for "N levels down" display
  issue text not null,
  remarks text,
  priority text not null check (priority in ('High','Medium','Low')),
  files jsonb not null default '[]',
  status text not null default 'open' check (status in ('open','resolved')),
  resolved_by uuid references staff(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create index report_issues_escalated_to_idx on report_issues (escalated_to);
create index report_issues_created_by_idx on report_issues (created_by);

alter table report_issues enable row level security;

-- Visible to: the original raiser (read-only once it's moved on from them), the current holder
-- (actionable), anyone above the current holder in the chain, anyone above the raiser, or
-- Administrator/Management org-wide (via is_in_scope's role special-case).
create policy report_issues_select on report_issues for select
  using (
    auth_staff_id() = created_by
    or auth_staff_id() = escalated_to
    or is_in_scope(auth_staff_id(), escalated_to)
    or is_in_scope(auth_staff_id(), created_by)
  );

create policy report_issues_insert on report_issues for insert
  with check (auth_staff_id() is not null and created_by = auth_staff_id());

create policy report_issues_update on report_issues for update
  using (auth_staff_id() = escalated_to) with check (auth_staff_id() is not null);

-- Computes escalated_to server-side on every insert/update instead of trusting the client.
-- INSERT: escalated_to becomes the raiser's own boss_id, or the raiser themself if they have no
-- boss (Administrator/Management raising their own issue) — that keeps "auth_staff_id() =
-- escalated_to" true for them too, so they can still resolve their own top-of-chain issue under
-- the same update policy, just with nowhere further to escalate.
-- UPDATE: caller must be the current holder (enforced again here, belt-and-braces with the RLS
-- policy). Exactly two moves are allowed — resolve, or escalate to the holder's own boss — every
-- other column is pinned back to its old value regardless of what the client sent.
create or replace function report_issues_set_authority() returns trigger
language plpgsql security definer set search_path = public as $$
declare acting_boss uuid;
begin
  if tg_op = 'INSERT' then
    select boss_id into acting_boss from staff where id = new.created_by;
    new.escalated_to := coalesce(acting_boss, new.created_by);
    new.last_escalated_by := null;
    new.hop_count := 0;
    new.status := 'open';
    new.resolved_by := null;
    new.resolved_at := null;
    return new;
  end if;

  if auth_staff_id() is distinct from old.escalated_to then
    raise exception 'Only the current holder can act on this issue';
  end if;

  if new.status = 'resolved' and old.status = 'open' then
    new.resolved_by := auth_staff_id();
    new.resolved_at := now();
    new.escalated_to := old.escalated_to;
    new.last_escalated_by := old.last_escalated_by;
    new.hop_count := old.hop_count;
  elsif new.escalated_to is distinct from old.escalated_to then
    select boss_id into acting_boss from staff where id = auth_staff_id();
    if acting_boss is null then
      raise exception 'Nowhere left to escalate — resolve it instead';
    end if;
    new.escalated_to := acting_boss;
    new.last_escalated_by := auth_staff_id();
    new.hop_count := old.hop_count + 1;
    new.status := 'open';
    new.resolved_by := null;
    new.resolved_at := null;
  else
    raise exception 'Only escalate or resolve are allowed';
  end if;

  new.created_by := old.created_by;
  new.issue := old.issue;
  new.remarks := old.remarks;
  new.priority := old.priority;
  new.files := old.files;
  new.created_at := old.created_at;
  return new;
end;
$$;

create trigger report_issues_authority_trg before insert or update on report_issues
  for each row execute function report_issues_set_authority();

-- Keep both apps' live subscriptions in sync with everything else (20260712000000_realtime.sql).
alter publication supabase_realtime add table report_issues;

-- Storage for task/issue photo attachments — currently just local blob: URLs client-side,
-- which vanish on reload. Private bucket, not public: files are only reachable by someone
-- with a valid TeamFlow login, not the whole internet.
--
-- Scope note: access is "any authenticated staff member", not scoped per-task the way
-- tasks/requests are. Building the same path-scoped RLS for storage.objects that tasks got
-- would mean threading task_in_scope() through storage paths — real work for content that's
-- rarely sensitive (a photo of a broken fan, proof a repair was done). Mirrors how `notices`
-- is already school-wide-readable rather than scoped. Revisit if attachments start carrying
-- anything actually confidential.

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

create policy attachments_read on storage.objects for select
  using (bucket_id = 'attachments' and auth_staff_id() is not null);
create policy attachments_write on storage.objects for insert
  with check (bucket_id = 'attachments' and auth_staff_id() is not null);

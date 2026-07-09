-- TeamFlow schema, derived from the mock data hardcoded in the two prototypes
-- (STAFF/tasks/requests in the console file, MEMBERS/tasks/pendingReqs/pendingIssues/notices in mobile).

create table staff (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  short_name text not null,
  initials text not null,
  role text not null check (role in ('Administrator','Management','Manager','Team Member','Teacher')),
  department text not null,
  boss_id uuid references staff(id),
  phone text
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null default 'work' check (type in ('work','purchase','repair','maint','other')),
  department text not null,
  priority text not null default 'med' check (priority in ('high','med','low')),
  status text not null default 'open' check (status in ('open','inprogress','partial','done')),
  due_date date,
  due_time time,
  note text,
  recur text check (recur in ('daily','weekly','monthly','yearly')),
  recur_on jsonb,               -- weekday int | day-of-month int | {d,m} for yearly, shape depends on recur
  self_assigned boolean not null default false,
  instructed_by text,           -- free-text label, e.g. "Anita (Manager)" — not an FK, mirrors the mock's BOSS_LABEL strings
  origin text check (origin in ('issue','request')),
  files jsonb not null default '[]',
  done_on date,
  ext_new_date date,
  ext_reason text,
  reopened_by uuid references staff(id),
  reopened_comment text,
  created_at timestamptz not null default now()
);

-- primary + joint assignees; done_at tracks per-person completion on joint tasks
create table task_assignees (
  task_id uuid not null references tasks(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,
  is_primary boolean not null default false,
  done_at timestamptz,
  primary key (task_id, staff_id)
);

-- job log: free-text updates added over a task's life
create table task_log (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id) on delete cascade,
  author_id uuid references staff(id),
  body text not null,
  created_at timestamptz not null default now()
);

-- supply requests & reported maintenance issues
create table requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('issue','request')),
  title text not null,
  from_staff_id uuid not null references staff(id),
  note text,
  files jsonb not null default '[]',
  created_at timestamptz not null default now()
);

-- broadcast notices (mobile "Notices" tab)
create table notices (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  posted_by uuid references staff(id),
  created_at timestamptz not null default now()
);

create index tasks_status_idx on tasks (status);
create index tasks_due_date_idx on tasks (due_date);
create index task_assignees_staff_idx on task_assignees (staff_id);
create index staff_boss_idx on staff (boss_id);

-- seed: org chart (insert order matters — boss must exist before report)
insert into staff (name, short_name, initials, role, department, boss_id) values
  ('Priya Nair', 'Priya', 'P', 'Administrator', 'Administration', null);
insert into staff (name, short_name, initials, role, department, boss_id) values
  ('Rajesh Menon', 'Rajesh', 'R', 'Management', 'Administration', (select id from staff where name = 'Priya Nair'));
insert into staff (name, short_name, initials, role, department, boss_id) values
  ('Anita Desai', 'Anita', 'A', 'Manager', 'Academics', (select id from staff where name = 'Rajesh Menon'));
insert into staff (name, short_name, initials, role, department, boss_id) values
  ('Vikram Rao', 'Vikram', 'V', 'Team Member', 'Maintenance', (select id from staff where name = 'Anita Desai'));
insert into staff (name, short_name, initials, role, department, boss_id) values
  ('Meena Rao', 'Meena', 'M', 'Teacher', 'Academics', (select id from staff where name = 'Anita Desai')),
  ('Kavya Nair', 'Kavya', 'K', 'Teacher', 'Academics', (select id from staff where name = 'Anita Desai')),
  ('Ravi Kumar', 'Ravi', 'R', 'Teacher', 'Administration', (select id from staff where name = 'Anita Desai')),
  ('Hari Charan', 'Hari', 'H', 'Teacher', 'Maintenance', (select id from staff where name = 'Vikram Rao')),
  ('Suresh Kumar', 'Suresh', 'S', 'Teacher', 'Maintenance', (select id from staff where name = 'Vikram Rao')),
  ('Latha M.', 'Latha', 'L', 'Teacher', 'Housekeeping', (select id from staff where name = 'Vikram Rao')),
  ('Arjun Menon', 'Arjun', 'A', 'Teacher', 'Operations', (select id from staff where name = 'Rajesh Menon')),
  ('Deepa Iyer', 'Deepa', 'D', 'Teacher', 'Operations', (select id from staff where name = 'Rajesh Menon'));

-- seed: tasks
with t as (
  insert into tasks (title, type, department, priority, status, due_date, note, ext_new_date, ext_reason)
  values ('Check classroom networking points & panels', 'repair', 'IT & Systems', 'high', 'open', '2026-07-02', '', '2026-07-08', 'Replacement network switch arrives Monday')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Hari Charan';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note, self_assigned, instructed_by, recur, recur_on)
  values ('Re-check fire extinguishers in Block B', 'maint', 'Maintenance', 'med', 'inprogress', '2026-07-06', 'Blocks A & B done, C pending', true, 'Anita (Manager)', 'monthly', '6')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Hari Charan';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, due_time, note)
  values ('Complete the academic work review', 'work', 'Academic', 'med', 'open', '2026-07-06', '15:00', '')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Meena Rao';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note)
  values ('Prepare term-2 exam timetable', 'work', 'Academic', 'high', 'partial', '2026-07-07', 'Draft ready, awaiting approval')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, x.is_primary from t, (values
  ('Kavya Nair', true), ('Meena Rao', false)
) as x(name, is_primary) join staff s on s.name = x.name;

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note)
  values ('Order science-lab supplies for term 2', 'purchase', 'Accounts', 'med', 'open', '2026-07-10', '')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Ravi Kumar';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note)
  values ('Service the water purifiers', 'maint', 'Maintenance', 'low', 'open', '2026-07-04', '')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Suresh Kumar';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note)
  values ('Deep-clean the assembly hall', 'maint', 'Maintenance', 'med', 'open', '2026-07-07', '')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Latha M.';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note)
  values ('Arrange bus for the science-fair trip', 'work', 'Transport', 'med', 'open', '2026-07-08', '')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Deepa Iyer';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note)
  values ('Update visitor-gate register process', 'work', 'Administration', 'low', 'open', '2026-07-11', '')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Arjun Menon';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note)
  values ('Shortlist candidates for PE teacher role', 'work', 'HR', 'med', 'open', '2026-07-12', '')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Deepa Iyer';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note, done_on)
  values ('Reconcile last month''s petty cash', 'work', 'Accounts', 'med', 'done', '2026-07-03', 'Filed with accounts', '2026-07-02')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Ravi Kumar';

with t as (
  insert into tasks (title, type, department, priority, status, due_date, note, done_on)
  values ('Repair the library AC unit', 'repair', 'Maintenance', 'med', 'done', '2026-06-29', 'Spare part arrived late', '2026-07-01')
  returning id
)
insert into task_assignees (task_id, staff_id, is_primary)
select t.id, s.id, true from t, staff s where s.name = 'Suresh Kumar';

-- seed: requests
insert into requests (kind, title, from_staff_id, note)
select 'issue', 'Ceiling fan in Class 7B making loud noise', id, 'Started yesterday, students distracted' from staff where name = 'Meena Rao';
insert into requests (kind, title, from_staff_id, note)
select 'request', '2 boxes of whiteboard markers + dusters', id, 'For the term-2 classrooms' from staff where name = 'Kavya Nair';
insert into requests (kind, title, from_staff_id, note)
select 'issue', 'Leaking tap in the staff washroom', id, '' from staff where name = 'Latha M.';

-- seed: notices
insert into notices (title, body) values
  ('PTM rescheduled to Saturday', 'Parent-teacher meeting moves to Sat 10 AM.');

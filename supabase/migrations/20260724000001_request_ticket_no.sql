-- Ticket numbers for maintenance reports + supply requests.
--
-- Every row in `requests` gets a running ticket number (a single shared sequence, displayed as "#1042").
-- When a manager actions a request it becomes a `tasks` row (origin='issue'|'request') and the request
-- row is removed, so the ticket must ride along — hence tasks also gets a ticket_no, copied from the
-- request at hand-off. Existing rows are backfilled chronologically (requests first, then already-
-- assigned origin-tasks) so historical items show tickets too. RLS unchanged (same columns/policies).

create sequence if not exists request_ticket_seq;
alter table requests add column if not exists ticket_no bigint;
alter table tasks    add column if not exists ticket_no bigint;

-- backfill existing requests in creation order
with o as (select id, row_number() over (order by created_at, id) rn from requests where ticket_no is null)
update requests r set ticket_no = o.rn from o where r.id = o.id;

-- backfill already-assigned request/issue tasks, continuing after the requests' max
with o as (select id, row_number() over (order by created_at, id) rn
           from tasks where origin in ('issue','request') and ticket_no is null)
update tasks t set ticket_no = (select coalesce(max(ticket_no),0) from requests) + o.rn
from o where t.id = o.id;

-- advance the sequence past everything, then make it the default for new requests
select setval('request_ticket_seq',
  greatest((select coalesce(max(ticket_no),0) from requests),
           (select coalesce(max(ticket_no),0) from tasks)), true);
alter table requests alter column ticket_no set default nextval('request_ticket_seq');

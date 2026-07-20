# Checklists — Build Plan (console + mobile + Supabase)

Wires the approved `mockup-checklists.html` concept into the live TeamFlow apps.
Grounded in the existing architecture: React-in-HTML (no build step), `shared.js`/`shared.css`,
Supabase backend (ref `fumggrcamegejihenkhb`), RLS via `auth_staff_id()`/scope helpers,
realtime `postgres_changes` + coarse `loadAll()` refetch, Vercel auto-deploy on push, version tags per release.

---

## 1. Feature recap (what we're building)

- Every staff member has a **checklist** — a set of recurring items curated by a boss.
- Items carry a **frequency + schedule anchor**: Daily · Weekly (weekday) · Monthly (day-of-month) · Yearly (day+month).
- **Any manager above** a person can edit their list (add/rename/reorder/delete/change schedule). Each list records **last edited by / on**.
- Staff **tick** their own items. Completion is **per occurrence date**; items reset implicitly (a daily item is unchecked again the next day; weekly on its weekday; etc.).
- Boss can **look back at any past date** (read-only history) and tick an **Absent** checkbox for a leave day (excuses the incomplete list).
- Completion **feeds the daily report**.
- Management gets **department + name filters** over everyone below them.

---

## 2. Data model (new tables)

Soft-delete via `archived` so completion history never orphans.

```sql
-- the recurring template, one row per checklist item per person
create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,  -- whose checklist
  body text not null,
  freq text not null check (freq in ('daily','weekly','monthly','yearly')),
  dow smallint check (dow between 0 and 6),        -- weekly: 0=Mon .. 6=Sun
  dom smallint check (dom between 1 and 31),        -- monthly day-of-month
  y_day smallint check (y_day between 1 and 31),    -- yearly day
  y_mon smallint check (y_mon between 1 and 12),    -- yearly month
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  last_edited_by uuid references staff(id),
  last_edited_at timestamptz not null default now()
);
create index checklist_items_staff_idx on checklist_items(staff_id) where not archived;

-- one row = item done on a given occurrence date (absence of row = not done)
create table checklist_completions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references checklist_items(id) on delete cascade,
  staff_id uuid not null references staff(id) on delete cascade,   -- denormalised owner (RLS/queries)
  occ_date date not null,
  done_at timestamptz not null default now(),
  unique (item_id, occ_date)
);
create index checklist_completions_staff_date_idx on checklist_completions(staff_id, occ_date);

-- boss-marked leave days (excuses the day's checklist)
create table checklist_absences (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  absent_date date not null,
  marked_by uuid references staff(id),
  created_at timestamptz not null default now(),
  unique (staff_id, absent_date)
);
```

**No cron/reset job needed.** "Reset" is implicit: completion is keyed by `occ_date`, so a new day
simply has no completion rows yet. This is simpler than the tasks' `check-due-tasks` cron.

---

## 3. RLS & helper functions

```sql
-- is _viewer somewhere up _target's boss chain?
create or replace function is_ancestor(_viewer uuid, _target uuid)
returns boolean language sql stable as $$
  with recursive anc as (
    select boss_id as id from staff where id = _target
    union all
    select s.boss_id from staff s join anc a on s.id = a.id where s.boss_id is not null
  )
  select exists (select 1 from anc where id = _viewer);
$$;

create or replace function is_admin_mgmt()
returns boolean language sql stable as $$
  select exists (select 1 from staff
    where id = auth_staff_id() and role in ('Administrator','Management'));
$$;
```

Policies (enable RLS on all three):

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `checklist_items` | owner (`staff_id = auth_staff_id()`) **or** `is_ancestor(auth_staff_id(), staff_id)` **or** `is_admin_mgmt()` | `is_ancestor(...)` **or** `is_admin_mgmt()` — **not the owner** (you can't edit your own list) |
| `checklist_completions` | owner **or** ancestor **or** admin/mgmt (read) | **owner only** (you tick your own; boss view is read-only) |
| `checklist_absences` | owner **or** ancestor **or** admin/mgmt | `is_ancestor(...)` **or** `is_admin_mgmt()` (boss marks leave) |

Mirrors the existing model where admin/Management get org-wide reach and scope is boss-chain based.
Verify with real tokens the way prior access-control work was verified (anon sees nothing; a staffer
can't UPDATE their own `checklist_items`; a manager can't touch a peer's subtree).

---

## 4. Derived logic (shared.js)

Pure, shared by both apps — no server compute needed.

```js
const CL_DOW=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const CL_MON=['Jan',...,'Dec'];
const lastDom=d=>new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
function clDueOn(item, isoDate){            // is this item due on that date?
  const d=new Date(isoDate+'T00:00:00'), dow=(d.getDay()+6)%7;   // Mon=0
  if(item.freq==='daily')   return true;
  if(item.freq==='weekly')  return dow===item.dow;
  if(item.freq==='monthly') return d.getDate()===Math.min(item.dom, lastDom(d));   // clamp 31→28/30
  if(item.freq==='yearly'){ const day=Math.min(item.y_day, lastDom(new Date(d.getFullYear(), item.y_mon-1, 1)));
                            return (d.getMonth()+1)===item.y_mon && d.getDate()===day; }   // clamp Feb 29
}
function clSchedLabel(item){ /* "Daily" | "Every Fri" | "Monthly · 5th" | "Yearly · 15 Jul" */ }
```

- **Today's checklist** for a person = non-archived items where `clDueOn(item, today)`, grouped by freq.
- **Done state** for a date = `checklist_completions` rows with that `occ_date`.
- **Month-end / leap-day** items clamp to the last valid day (documented above).

---

## 5. Console integration (`2026-07-06-teamflow-console-react.html`)

1. **Sidebar nav** — insert **Checklists** between Tasks and Calendar (shift the keyboard hints / indices).
2. **`loadAll()`** — fetch `checklist_items` (scope), `checklist_completions` (recent window, e.g. last 60 days), `checklist_absences`; map into `ctx`.
3. **New `ChecklistsView`** component, two tabs (reuse the mockup structure):
   - **My checklist** — today's due items grouped by frequency, tickable → insert/delete `checklist_completions` for `(item, today)`. Read-only structure.
   - **My team** — `descendants(viewer)` list (already have `descendants()`), **dept + name filter** when the list is large; select a person → their checklist with **date picker**, **Absent** checkbox, and **Edit list** mode (add/rename/reorder/delete/freq+anchor → writes `checklist_items`, stamps `last_edited_by`/`last_edited_at`).
4. **Realtime** — subscribe to the three tables; on change, `loadAll()` + bump `syncTick` (same coarse pattern as tasks/daily_reports).
5. **Snapshot** — a "📄 Snapshot" action in the team-detail header producing the weekly/monthly compliance grid (see §8).
6. Reuse: `byShort`, `descendants()`, role gating, `dmy`/`dmyTs`, avatar/color helpers.

## 6. Mobile integration (`2026-07-06-teamflow-mobile-react.html`)

- Add **Checklists** entry (main nav if room, else under **More**).
- **My checklist** (all staff): today's grouped items, tap to tick. This is the primary mobile surface.
- **My team** (managers): **Phase 1** = read-only status + **Absent** checkbox + date look-back; **Phase 2** = full edit + snapshot on mobile. (Editing the template + snapshot are console-first — see decisions.)
- Reuse mobile's `descendantsM()`, `findMember`, `ALL_PEOPLE`.

## 7. Daily-report integration

Mirror the `task_snapshot` pattern: add **`checklist_snapshot jsonb`** to `daily_reports`, frozen at submit —
`[{body, freq, sched, done}]` for items due that `report_date`, plus an `absent` flag. Then surface a
**Checklist** section (e.g. "Checklist · Daily 5/6 · Weekly 1/1 · …") in the three report renderers:
`printDailyReports` + `exportDailyReports` (console) and `downloadDailyReportPdf` (shared.js).

---

## 8. Weekly / monthly snapshot (print & download)

A boss can print or download a **compliance grid** for anyone below them — checklist items down the
side (grouped by frequency, with each item's schedule), days across the top. Cell states:
**✓** done · **·** missed · **A** absent · **–** not due · blank = future. Toggle **Weekly** (7 cols, Mon–Sun)
or **Monthly** (full month). Header carries the org name (JHPS), employee, period; a summary line shows
`% completed · X/Y due done · N days absent`; footer notes generated date + last-edited-by.

- **Generation:** add `downloadChecklistSnapshot(staffId, mode, anchorISO)` to `shared.js`, built on the
  existing **jsPDF + autoTable** pipeline (same as `downloadDailyReportPdf`) so it's a true one-click PDF
  with the org header (`orgHeadHtml`/org name) — **landscape** for the monthly grid. A "Print" option can
  additionally use the `#print-report` HTML path for an in-browser print.
- **Data:** query `checklist_items` (non-archived) + `checklist_completions` + `checklist_absences` for the
  person over the period; compute each cell from `clDueOn(item, date)` + completion presence + absence.
  Summary = done/due % and distinct absent days. Same source as the date look-back.
- **Placement:** a **Snapshot** action in the boss team-detail header (console). Mobile = Phase 2. Optionally
  let a staff member print their own.
- **Notes:** monthly grid is wide → landscape / horizontal scroll on screen; clamp month-end & leap-day the
  same way `clDueOn` does; the period anchors to the currently-viewed date, so any past week/month prints.

## 9. Migration & deploy sequence

1. Write one migration (`supabase/migrations/2026…_checklists.sql`): tables, indexes, `is_ancestor`/`is_admin_mgmt`, RLS policies, and `alter publication supabase_realtime add table …` for the three tables.
2. **Apply** via the Management-API SQL endpoint (or hand the SQL to you for the Dashboard SQL editor if the CLI isn't on the machine — same path used for recent schema changes).
3. **Verify RLS** with real login tokens before any UI work (anon = 0 rows; owner can't edit own list; ancestor can; out-of-scope can't).
4. Build shared.js helpers → console view → mobile view → daily-report section.
5. **Babel transpile check** + live browser test **with real accounts** across roles.
6. Commit, **annotated tag `vNN`**, push → Vercel deploys. Publish the release note when you ask.

## 10. Verification checklist

- **Staff**: My checklist shows only items due today, grouped; ticking persists across reload; a weekly item appears only on its weekday; can't edit; can't self-mark absent.
- **Manager**: edits a report's list (all ops), `last edited by … on …` updates; date look-back shows that day's history; Absent check/uncheck works; **cannot** edit outside their subtree.
- **Management**: sees all descendants; dept + name filters narrow the list.
- **Reset**: a completion on day D is gone on day D+1 (fresh list).
- **Daily report**: shows the checklist section; PDF/CSV include it.
- Clean up all test rows afterward and confirm with a follow-up SELECT.

## 11. Phasing

- **Phase 1 (MVP):** schema + RLS; console full feature incl. **weekly/monthly snapshot PDF**; mobile *My checklist* (tick) for all staff; daily-report checklist section.
- **Phase 2:** mobile team management (edit/absent/look-back/snapshot on mobile); reminders/nudges (remind staff, alert boss on incomplete by EOD); compliance analytics (streaks, %); optional leave/attendance module feeding `checklist_absences` automatically.

---

## 12. Decisions to confirm before build

1. **Mobile scope for v1** — staff *My checklist* only (managers manage on console), or full parity on mobile? *(Recommend staff-first; console for management.)*
2. **Daily report** — freeze a `checklist_snapshot` at submit (consistent with tasks), or compute live each view? *(Recommend freeze.)*
3. **Missed recurring items** — show only on the due date with no carry-over/backlog (history reflects misses)? *(Recommend yes, no carry-over.)*
4. **Absent authority** — boss + admin/Management only (per mockup), or also let a person self-mark? *(Recommend boss-only for now.)*
5. **Reminders/notifications** — in v1 or Phase 2? *(Recommend Phase 2.)*
6. **Absent source** — keep the standalone checklist mark, or plan to source it from a future leave/attendance feature so it's not double-entered?
7. **Retention** — how far back should completion history be queryable in-app (affects the `loadAll` window)? e.g. 60/90 days live, older on demand.
8. **Snapshot access** — boss-only, or can a staff member also print their own weekly/monthly snapshot? *(Recommend boss + self.)*

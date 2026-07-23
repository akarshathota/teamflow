-- Sr. Manager can head multiple departments.
-- staff.head_departments: the jsonb array of department names a Sr. Manager (role='Manager') fully
-- heads. Additive + idempotent; already applied to prod via the Management API on 2026-07-23.
-- staff.department is kept as-is (a person's own department membership + display fallback); the
-- head_departments array is the source of truth for "which departments this Manager heads".

alter table staff add column if not exists head_departments jsonb not null default '[]'::jsonb;

-- Backfill existing single-department managers so their chip shows their department (not "no
-- department"): only touch managers whose array is still empty/null.
update staff
   set head_departments = jsonb_build_array(department)
 where role = 'Manager'
   and department is not null
   and (head_departments is null or head_departments = '[]'::jsonb);

# TeamFlow — Operations notes

Facts that are true in the live Supabase project but invisible in this git repo, because they live
in Dashboard settings or were applied by hand in the SQL Editor rather than through a tracked
migration file. Read this before touching cron, Edge Function auth settings, or secrets.

## 1. `check-due-tasks` has "Verify JWT with legacy secret" turned OFF

In the Supabase Dashboard, under **Edge Functions → check-due-tasks → Settings**, JWT verification
is disabled for this function.

**Why:** `check-due-tasks` isn't called by a logged-in user with a Supabase session — it's called
once a day by `pg_cron` via `pg_net`'s `net.http_post()` (see
`supabase/migrations/20260713000001_due_task_cron.sql`). That call carries a custom
`x-cron-secret` header, not an `Authorization: Bearer <user JWT>` header. The function checks that
header itself (`req.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET")`) — see
`supabase/functions/check-due-tasks/index.ts`. If Supabase's platform-level JWT verification is ON,
it rejects the request with 401 *before the function's own code ever runs*, because there's no
valid user JWT to verify.

**Warning:** if this setting is ever re-enabled (e.g. during a Dashboard UI change, a "reset to
defaults", or by someone unfamiliar with why it's off), the daily cron job will start silently
failing — pg_cron will report the HTTP call "succeeded" (net.http_post itself doesn't know or care
what the response body/status was) while the function never actually executes and no tasks ever get
checked. There is no error visible anywhere in the app when this happens; the only signs are (a) the
Edge Function's own logs showing 401s, and (b) after this session's item #6, console's "last cron
run" indicator (Topbar, admin/mgmt only) going stale/never updating. Check that indicator periodically.

The other four Edge Functions (`create-staff-account`, `delete-staff-account`,
`reset-staff-password`, `update-staff-login`) are the opposite: they're called by a real logged-in
admin from the console app and DO need JWT verification ON, since they parse the caller's own
session token themselves (`verifyAdmin()`) to confirm the caller is Administrator/Management.

## 2. `CRON_SECRET` must match in two places, only one of which is in git

The `check-due-tasks` Edge Function reads `CRON_SECRET` from its own environment (an Edge Function
secret, set via the Dashboard). The `pg_cron` job that calls it sends that same value in the
`x-cron-secret` header, set inside the `net.http_post()` call.

The **tracked** migration file (`supabase/migrations/20260713000001_due_task_cron.sql`) has a
placeholder — `REPLACE_WITH_CRON_SECRET` — on purpose, so the real secret never lands in git. The
**real** value only exists in two places:
- the Edge Function's `CRON_SECRET` secret (Dashboard → Edge Functions → check-due-tasks → Secrets,
  or project-wide secrets — whichever scope was used when it was set), and
- the actual `cron.schedule(...)` call as it was run in the SQL Editor (with the real value pasted
  in place of the placeholder) — that run is what's live in Postgres now, not the tracked file.

**To rotate it safely** (e.g. if it's ever suspected to have leaked):
1. Generate a new value, e.g. `openssl rand -hex 24`.
2. Update the Edge Function's `CRON_SECRET` secret in the Dashboard to the new value. Existing
   deployed function code doesn't need to change — it just reads `Deno.env.get("CRON_SECRET")`
   at call time.
3. In the SQL Editor, unschedule and re-create the cron job with the new secret in its header:
   ```sql
   select cron.unschedule('check-due-tasks-daily');
   -- then re-run the select cron.schedule(...) block from the migration file, substituting the
   -- new secret for REPLACE_WITH_CRON_SECRET
   ```
   (Or, if `pg_cron` exposes an update path in the installed version, use that instead of
   unschedule+recreate — check `cron.job` first.)
4. Verify the next scheduled run succeeds (check Edge Function logs, or console's "last cron run"
   indicator) before considering the rotation complete.
Do the Edge Function secret update and the SQL Editor update together — if only one side changes,
the cron job starts getting 401s until the other side is updated too.

## 3. Edge Function deploy method: Dashboard browser editor, not the CLI

There is **no Supabase CLI installed in this environment**. All five Edge Functions
(`check-due-tasks`, `create-staff-account`, `delete-staff-account`, `reset-staff-password`,
`update-staff-login`) are deployed by pasting their `index.ts` source directly into the Supabase
Dashboard's browser-based function code editor (Edge Functions → [function name] → Code), not via
`supabase functions deploy`.

This is confirmed true for `check-due-tasks` and `update-staff-login` (deployed that way in the
same session this note was written). The same is assumed — but not directly confirmed — for
`create-staff-account`, `delete-staff-account`, and `reset-staff-password`, since they predate that
session.

Because of this deploy method, every function file under `supabase/functions/*/index.ts` (except
`_shared/helpers.ts` itself) is written to be **fully self-contained** — each inlines its own copies
of `CORS`, `json`, `verifyAdmin`, `ADMIN_TIER`, and `randomPassword` (only where it actually uses
them) instead of importing from `../_shared/helpers.ts`. A relative import like
`../_shared/helpers.ts` has no meaning when a single file is pasted into the Dashboard editor in
isolation — there's no second file alongside it for the import to resolve against. `_shared/helpers.ts`
is kept in the repo anyway as the canonical reference copy of that shared logic (see the comment at
the top of that file) — if you change the logic there, copy the same change into every function's
inlined copy, since nothing enforces they stay in sync automatically.

**When redeploying any of these functions:** copy the *entire* contents of that function's
`index.ts` — including its own inlined helper functions at the top — into the Dashboard editor.
Copying only the `Deno.serve(...)` block (as you might if you were used to the shared-import
version) will fail to compile, since `CORS`/`json`/etc. won't be defined.

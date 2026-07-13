# TeamFlow — smoke-test checklist for role/scoping changes

Run this manually any time a role tier is added or changed, or a scoping/permission rule (who can
see or approve what) is touched. It's short on purpose — the goal is to catch the specific class of
bug this project has actually hit, not to be a full regression suite.

This checklist exists because of two concrete failures found in one review pass:

- **Team Lead breaking mobile entirely.** `DB_ROLE_TO_KEY` (shared.js) mapped `'Team Lead':'lead'`,
  and console had a working `lead` role key — but mobile's `ROLES` config had no `lead` entry. A
  real Team Lead logging into mobile hit `ROLES[role]` being `undefined` and the app broke. This
  wasn't caught because "Preview As" in console (which *did* have `lead` wired) made it look fixed
  everywhere — nobody tested an actual Team Lead login on the mobile app specifically.
- **Hardcoded name-based permission gates.** Console's `canAssignIssue` checked
  `viewer.n===MAINT_HEAD` where `MAINT_HEAD="Vikram Rao"` was a hardcoded string; mobile's
  `canApproveFrom` checked a `BOSS_ROLE` map of ~10 original demo first names. Both silently stopped
  granting the right people permission the moment the real org changed — new hires (Chandu in
  Construction, Prashant in IT & Systems) or role changes weren't in the hardcoded list/map, so the
  checks just failed for them with no error, no crash, nothing — the button/action was simply
  unavailable and nothing said why. This is worse than a crash because it's invisible in normal use.

## Checklist

1. **Create a real test staff account** at the new/changed role tier — not just "Preview As" in
   console. Preview As only proves the *simulation* path works; it can't catch bugs in the real
   login path (like the Team Lead one above) because it doesn't go through `ROLES[role]`/role-key
   lookups the same way a real signed-in session does. Use the console's People & Roles → Add flow,
   or `create-staff-account`, to make a real account. Delete it when done (step 6).

2. **Log into console** (if that role has console access) **and mobile** — separately, as that real
   test account, not as an admin previewing it. Some bugs (like the Team Lead one) only show up in
   one app and not the other, precisely because console and mobile duplicate this logic
   independently (see the top comment in `shared.js` for why that duplication is deliberate).

3. **Check every tab/view loads** without a blank screen, a stuck loading spinner, or a JS error in
   the browser console (`window.onerror` shows a "Runtime error" overlay in the console app if
   something throws — don't dismiss it without reading what it says). Click through every tab this
   role tier has access to per its `tabs` array (mobile `ROLES`) / the sidebar nav (console).

4. **Check Preview As** (if you're logged in as admin) correctly represents this role — the name/
   department/team it shows should resolve to a real person at that tier (via `roleRep()` in
   console, the equivalent lookup in mobile), not a stale hardcoded demo persona. If nobody real
   holds that tier yet, it should fail gracefully (fall back sensibly), not crash.

5. **Check task/request visibility and approval scope** matches this role's actual position in the
   org chart:
   - Can they see the tasks/requests they should be able to see, and *not* see ones outside their
     scope (their own + reports, per `boss`/`boss_id` chain — see `descendants()`/`descendantsM()`)?
   - If this role can approve things (extensions, requests, issues), test it with someone who is
     genuinely NOT the direct boss/department head and confirm they're correctly denied — not just
     that the intended approver is correctly allowed. A hardcoded gate that always says "yes" for
     admins and "no" for everyone else can look like it's working in the happy path while still
     being broken for the actual person who should be allowed.
   - If this role/change involves a "department head" or similar single-person concept (like
     maintenance-issue assignment), verify it resolves to whoever *currently* holds that position —
     test after reassigning that position to someone else and confirm the check follows them,
     rather than staying pinned to whoever it was at the time the code was written.

6. **Delete the test account** when done (console People & Roles → Remove, or
   `delete-staff-account`) — don't leave real login credentials sitting around for a throwaway test
   identity.

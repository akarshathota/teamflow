-- Administrator-chosen sidebar icon overrides.
--
-- The sidebar items "Reports & requests" and "Settings" now default to clean monochrome line icons
-- (matching the rest of the menu). The Administrator can OPTIONALLY override each with an emoji, via
-- an admin-only picker in Settings → Sidebar icons. Those choices are stored here and apply org-wide.
--
-- nav_icons is a jsonb map of { navKey: emoji }, e.g. {"tracker":"🗂️","settings":"⚙️"}. An absent key
-- means "use the default line icon". org_settings is a single-row table already read on load and
-- already published for realtime (20260722000000), so the override propagates live to every open app.
-- RLS is unchanged: all staff read org_settings; only the Administrator updates it (existing policies).
-- Purely additive, safe to run once.

alter table org_settings add column if not exists nav_icons jsonb not null default '{}'::jsonb;

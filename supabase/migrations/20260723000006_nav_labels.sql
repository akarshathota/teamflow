-- Administrator-chosen sidebar menu-item name overrides.
--
-- Alongside the emoji overrides (nav_icons), the Administrator can now RENAME any sidebar item via the
-- admin-only picker in Settings → Sidebar menu (e.g. call "Reports & requests" just "Inbox"). Those
-- choices are stored here and apply org-wide.
--
-- nav_labels is a jsonb map of { navKey: label }, e.g. {"tracker":"Inbox","settings":"Admin"}. An absent
-- key (or a value equal to the built-in default) means "use the default word". org_settings is a
-- single-row table already read on load and published for realtime, so the override propagates live.
-- RLS is unchanged: all staff read org_settings; only the Administrator updates it. Additive, run once.

alter table org_settings add column if not exists nav_labels jsonb not null default '{}'::jsonb;

-- Every Site has the built-in "Site analytics" Dashboard; Sites made since get it with the Site
-- (`addSiteAnalyticsDashboard`, packages/core/src/dashboards/built-in.ts). This gives one to each Site
-- made before, with the same Widgets in the same places, shown to Staff and Owners. Keep the two in step.
INSERT INTO "dashboards" ("workspace_id", "site_id", "name", "range", "shared_with_everyone", "widgets", "built_in", "created_at", "updated_at")
SELECT
	s."workspace_id",
	s."id",
	'Site analytics',
	'{"preset":"last30Days"}'::jsonb,
	false,
	jsonb_build_array(
		jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'site-analytics:totals', 'title', NULL, 'x', 0, 'y', 0, 'w', 12, 'h', 2, 'range', NULL, 'filters', '{}'::jsonb, 'settings', '{"measures":["pageviews","visitors","visits","events"]}'::jsonb, 'rows', 10),
		jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'site-analytics:trend', 'title', NULL, 'x', 0, 'y', 2, 'w', 8, 'h', 4, 'range', NULL, 'filters', '{}'::jsonb, 'settings', '{"measures":["pageviews","visitors"]}'::jsonb, 'rows', 10),
		jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'site-analytics:sources', 'title', NULL, 'x', 8, 'y', 2, 'w', 4, 'h', 4, 'range', NULL, 'filters', '{}'::jsonb, 'settings', '{}'::jsonb, 'rows', 5),
		jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'site-analytics:top-pages', 'title', NULL, 'x', 0, 'y', 6, 'w', 6, 'h', 4, 'range', NULL, 'filters', '{}'::jsonb, 'settings', '{}'::jsonb, 'rows', 5),
		jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'site-analytics:goals', 'title', NULL, 'x', 6, 'y', 6, 'w', 6, 'h', 2, 'range', NULL, 'filters', '{}'::jsonb, 'settings', '{}'::jsonb, 'rows', 5),
		jsonb_build_object('id', gen_random_uuid()::text, 'kind', 'site-analytics:devices', 'title', NULL, 'x', 6, 'y', 8, 'w', 6, 'h', 2, 'range', NULL, 'filters', '{}'::jsonb, 'settings', '{}'::jsonb, 'rows', 5)
	),
	true,
	now(),
	now()
FROM "sites" s
WHERE NOT EXISTS (SELECT 1 FROM "dashboards" d WHERE d."site_id" = s."id" AND d."built_in");

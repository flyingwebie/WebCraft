-- Every Site has the built-in Page Post Type; Sites made since get it with the Site. This gives one
-- to each Site made before. Its key is `page` unless a Post Type of the Site already took it; the
-- built_in column, not the key, is what marks it.
INSERT INTO "post_types" ("workspace_id", "site_id", "key", "name", "url_pattern", "fields", "built_in", "created_at", "updated_at")
SELECT
	s."workspace_id",
	s."id",
	CASE
		WHEN EXISTS (SELECT 1 FROM "post_types" p WHERE p."site_id" = s."id" AND p."key" = 'page') THEN 'built-in-page'
		ELSE 'page'
	END,
	'Pages',
	'/{path}',
	'[]'::jsonb,
	'page',
	now(),
	now()
FROM "sites" s
WHERE NOT EXISTS (SELECT 1 FROM "post_types" p WHERE p."site_id" = s."id" AND p."built_in" = 'page');

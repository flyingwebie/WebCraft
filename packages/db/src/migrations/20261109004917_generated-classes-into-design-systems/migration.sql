-- Generated Classes (#58) move into each Site's Design system, which now holds every Class with a
-- Draft and a published version. Pages showed them as soon as a Template using them was published,
-- so they go into both versions. Sections the document leaves out (tokens, base styles) read as the
-- default ones. The `classes` table stays, unused, until a later release removes it (ADR 0031).
INSERT INTO "design_systems" ("workspace_id", "site_id", "draft", "published", "created_at", "updated_at")
SELECT "workspace_id", "site_id", "document", "document", now(), now()
FROM (
	SELECT
		"workspace_id",
		"site_id",
		jsonb_build_object(
			'version', 1,
			'classes', jsonb_agg(
				jsonb_build_object(
					'id', "id"::text,
					'name', "name",
					'generated', "generated",
					'styles', CASE WHEN "styles" = '' THEN '[]'::jsonb ELSE jsonb_build_array("styles") END,
					'breakpoints', '{}'::jsonb,
					'css', '[]'::jsonb
				)
				ORDER BY "created_at", "name"
			)
		) AS "document"
	FROM "classes"
	GROUP BY "workspace_id", "site_id"
) AS "legacy"
ON CONFLICT ("site_id") DO NOTHING;

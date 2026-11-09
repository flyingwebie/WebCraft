-- Every Site has a row in site_languages for its Default language; Sites made since get it with the
-- Site. This gives one to each Site made before, named in the language itself.
INSERT INTO "site_languages" ("workspace_id", "site_id", "code", "name", "direction", "position", "created_at")
SELECT
	s."workspace_id",
	s."id",
	s."default_language",
	CASE split_part(lower(s."default_language"), '-', 1)
		WHEN 'en' THEN 'English'
		WHEN 'it' THEN 'Italiano'
		WHEN 'fr' THEN 'Français'
		WHEN 'de' THEN 'Deutsch'
		WHEN 'es' THEN 'Español'
		ELSE s."default_language"
	END,
	CASE WHEN split_part(lower(s."default_language"), '-', 1) IN ('ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi')
		THEN 'rtl' ELSE 'ltr' END,
	0,
	now()
FROM "sites" s
WHERE NOT EXISTS (SELECT 1 FROM "site_languages" l WHERE l."site_id" = s."id" AND l."code" = s."default_language");

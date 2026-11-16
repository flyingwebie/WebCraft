-- Folders made before the Site could order them keep the order they were shown in (A–Z by name,
-- whatever the case, then by id), as their place in the Site's own order.
UPDATE "media_folders" AS f
SET "sort_order" = ranked.position
FROM (
	SELECT "id", (row_number() OVER (PARTITION BY "site_id" ORDER BY lower("name"), "id") - 1)::integer AS position
	FROM "media_folders"
) AS ranked
WHERE f."id" = ranked."id";

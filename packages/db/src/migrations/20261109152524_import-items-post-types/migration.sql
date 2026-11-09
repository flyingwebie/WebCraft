-- Source ids are looked up within the Post Type an item goes to: give the Entries an Import brought
-- in before their Post Type.
UPDATE "import_items" AS "item"
SET "post_type_id" = "entry"."post_type_id"
FROM "entries" AS "entry"
WHERE "item"."entry_id" = "entry"."id" AND "item"."kind" = 'entry' AND "item"."post_type_id" IS NULL;

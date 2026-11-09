-- Site search (ADR 0021): a Post Type made before Searched fields existed searches what a new one
-- does by default: its title at weight A (the column's default) and its Body field, if it has one, at B.
UPDATE "post_types"
SET "searched_fields" = "searched_fields" || coalesce(
	(
		SELECT jsonb_agg(jsonb_build_object('field', field ->> 'key', 'weight', 'B'))
		FROM jsonb_array_elements("post_types"."fields") AS field
		WHERE field ->> 'type' = 'body'
	),
	'[]'::jsonb
);

-- "share" became a reserved Site slug with Reports and Share links (#104): Share links are served
-- at share.<sites domain>, and the Site pipeline answers that host before it resolves a Site by
-- hostname, so a Site already slugged "share" from before this change would silently lose its
-- Staging address to the Share link host on upgrade. Move it to the first free share-<n> instead,
-- and record the change in the Audit log as WebCraft itself (no person), the way `recordAudit`
-- would, with the old and new slug.
DO $$
DECLARE
	moved RECORD;
	candidate TEXT;
	n INTEGER;
BEGIN
	FOR moved IN SELECT id, workspace_id FROM "sites" WHERE "slug" = 'share' LOOP
		n := 1;
		LOOP
			candidate := 'share-' || n;
			EXIT WHEN NOT EXISTS (SELECT 1 FROM "sites" WHERE "slug" = candidate);
			n := n + 1;
		END LOOP;
		UPDATE "sites" SET "slug" = candidate WHERE "id" = moved.id;
		INSERT INTO "audit_log" ("occurred_at", "person_id", "via", "via_name", "workspace_id", "site_id", "action", "details")
		VALUES (
			now(),
			NULL,
			'command',
			'migrate',
			moved.workspace_id,
			moved.id,
			'site.slugChanged',
			jsonb_build_object('from', 'share', 'to', candidate)
		);
	END LOOP;
END $$;

import type { ModuleMigration } from "@webcraft/module-sdk";

/** The sample Module's migrations, oldest first. */
export const migrations: readonly ModuleMigration[] = [
	{
		name: "0001-notes",
		sql: `
CREATE TABLE notes (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	body text NOT NULL,
	source text NOT NULL,
	created_at timestamp with time zone NOT NULL,
	CONSTRAINT notes_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX notes_site_created_at_idx ON notes (site_id, created_at);
`,
	},
];

import type { ModuleMigration } from "@webcraft/module-sdk";

/** The Forms Module's migrations, oldest first. Never change one that shipped: add another. */
export const migrations: readonly ModuleMigration[] = [
	{
		name: "0001-submissions",
		sql: `
CREATE TABLE submissions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	form_id uuid NOT NULL,
	form_key text NOT NULL,
	form_name text NOT NULL,
	language text NOT NULL,
	page text,
	folder text NOT NULL CHECK (folder IN ('inbox', 'spam')),
	spam_reason text,
	"values" jsonb NOT NULL,
	received_at timestamp with time zone NOT NULL,
	CONSTRAINT submissions_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX submissions_site_form_received_at_idx ON submissions (site_id, form_id, received_at);
CREATE INDEX submissions_site_folder_received_at_idx ON submissions (site_id, folder, received_at);
`,
	},
];

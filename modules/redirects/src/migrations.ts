import type { ModuleMigration } from "@webcraft/module-sdk";

/** The Redirects Module's migrations, oldest first. Never change one that shipped: add another. */
export const migrations: readonly ModuleMigration[] = [
	{
		name: "0001-rules-and-misses",
		sql: `
CREATE TABLE rules (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	from_path text NOT NULL,
	wildcard boolean NOT NULL,
	target text NOT NULL,
	status integer NOT NULL CHECK (status IN (301, 302)),
	automatic boolean NOT NULL,
	entry_id uuid,
	created_at timestamp with time zone NOT NULL,
	updated_at timestamp with time zone NOT NULL,
	CONSTRAINT rules_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX rules_site_from_unique ON rules (site_id, from_path, wildcard);
CREATE INDEX rules_site_target_idx ON rules (site_id, target);
CREATE INDEX rules_site_updated_at_idx ON rules (site_id, updated_at);

CREATE TABLE misses (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	path text NOT NULL,
	language text NOT NULL,
	hits integer NOT NULL CHECK (hits > 0),
	first_seen timestamp with time zone NOT NULL,
	last_seen timestamp with time zone NOT NULL,
	referrer_host text,
	ignored boolean NOT NULL,
	CONSTRAINT misses_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX misses_site_path_unique ON misses (site_id, path);
CREATE INDEX misses_site_last_seen_idx ON misses (site_id, last_seen);
`,
	},
];

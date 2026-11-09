import type { ModuleMigration } from "@webcraft/module-sdk";

/** The Site analytics Module's migrations, oldest first. Never change one that shipped: add another. */
export const migrations: readonly ModuleMigration[] = [
	{
		name: "0001-events-and-rollups",
		sql: `
CREATE TABLE events (
	id uuid NOT NULL DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	occurred_at timestamp with time zone NOT NULL,
	hour timestamp with time zone NOT NULL,
	day timestamp with time zone NOT NULL,
	type text NOT NULL CHECK (type IN ('pageview', 'consent', 'link', 'event', 'form')),
	name text,
	target text,
	path text NOT NULL,
	source text,
	medium text,
	campaign text,
	country text,
	device text NOT NULL,
	browser text NOT NULL,
	os text NOT NULL,
	visitor text,
	visit uuid,
	starts_visit boolean NOT NULL,
	PRIMARY KEY (id, occurred_at),
	CONSTRAINT events_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
) PARTITION BY RANGE (occurred_at);
CREATE INDEX events_site_occurred_at_idx ON events (site_id, occurred_at);
CREATE INDEX events_site_visitor_occurred_at_idx ON events (site_id, visitor, occurred_at);

CREATE TABLE rollups (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	period text NOT NULL CHECK (period IN ('hour', 'day')),
	start timestamp with time zone NOT NULL,
	dimension text NOT NULL,
	value text NOT NULL,
	pageviews integer NOT NULL,
	visitors integer NOT NULL,
	visits integer NOT NULL,
	events integer NOT NULL,
	CONSTRAINT rollups_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX rollups_site_period_start_dimension_value_idx ON rollups (site_id, period, start, dimension, value);
CREATE INDEX rollups_site_period_dimension_start_idx ON rollups (site_id, period, dimension, start);

CREATE TABLE rollup_state (
	workspace_id uuid NOT NULL,
	site_id uuid PRIMARY KEY,
	hours_until timestamp with time zone NOT NULL,
	days_until timestamp with time zone NOT NULL,
	CONSTRAINT rollup_state_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE settings (
	workspace_id uuid NOT NULL,
	site_id uuid PRIMARY KEY,
	excluded_ranges jsonb NOT NULL,
	updated_at timestamp with time zone NOT NULL,
	CONSTRAINT settings_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
`,
	},
	{
		name: "0002-goals-funnels-and-visit-sources",
		sql: `
ALTER TABLE events ADD COLUMN visit_source text;
-- Before consent a page view stands alone: its visit's source is its own (null for a move within the Site).
UPDATE events SET visit_source = source WHERE visit IS NULL;
-- After consent every event of a visit carries the source of the visit's arrival: a self-join on
-- (site_id, visit), found by starts_visit. events has no index on that pair otherwise (it is kept in
-- monthly partitions, up to 13 months), so a temporary one speeds this backfill; dropped once it is done.
CREATE INDEX events_visit_source_backfill_idx ON events (site_id, visit) WHERE starts_visit;
UPDATE events AS later SET visit_source = arrival.source
	FROM events AS arrival
	WHERE later.visit IS NOT NULL AND arrival.site_id = later.site_id AND arrival.visit = later.visit AND arrival.starts_visit;
DROP INDEX events_visit_source_backfill_idx;
CREATE INDEX events_site_type_occurred_at_idx ON events (site_id, type, occurred_at);

CREATE TABLE goals (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	name text NOT NULL,
	kind text NOT NULL CHECK (kind IN ('form', 'page', 'link', 'event')),
	definition jsonb NOT NULL,
	created_at timestamp with time zone NOT NULL,
	updated_at timestamp with time zone NOT NULL,
	CONSTRAINT goals_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX goals_site_name_idx ON goals (site_id, lower(name));

CREATE TABLE funnels (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL,
	site_id uuid NOT NULL,
	name text NOT NULL,
	steps jsonb NOT NULL,
	created_at timestamp with time zone NOT NULL,
	updated_at timestamp with time zone NOT NULL,
	CONSTRAINT funnels_site_fkey FOREIGN KEY (workspace_id, site_id) REFERENCES sites (workspace_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX funnels_site_name_idx ON funnels (site_id, lower(name));
`,
	},
];

import type pg from "pg";

/**
 * Which of a Site's rows a Site export carries. Every table holding a Site's rows (a `workspace_id`
 * and a `site_id`, in WebCraft's schema or a Module's) is read from Postgres's catalog, so a table a
 * later feature adds goes in by itself; the ones that must not are listed here with why. The export's
 * manifest names both, and a test checks that every table holding a Site's rows is one or the other.
 */
export const LEFT_OUT_TABLES: Readonly<Record<string, LeftOutReason>> = {
	// Credentials and what they reach never leave their Install.
	"public.api_token_sites": "credential",
	"public.oauth_grant_sites": "credential",
	"public.content_keys": "credential",
	"public.content_key_usage": "credential",
	"public.share_links": "credential",
	"public.secrets": "secrets",
	// Sessions, links and confirmations belong to people signed in on this Install.
	"public.edit_links": "session",
	"public.edit_sessions": "session",
	"public.staging_links": "session",
	"public.staging_sessions": "session",
	"public.confirmations": "session",
	// The live state of Co-editing: the Drafts themselves are in their items.
	"public.draft_documents": "working",
	"public.draft_document_changes": "working",
	// Members go by email (`people.jsonl.gz`), matched or invited on import.
	"public.membership_sites": "members",
	"public.invite_sites": "members",
	// What publishing makes: the new Site's Content arrives as Drafts, and its next publish makes them again.
	"public.published_slugs": "published",
	"public.search_documents": "published",
	"public.gone_paths": "published",
	"public.stylesheets": "published",
	// Scheduled publishes are dropped (and listed), so nothing publishes by itself on the new Site.
	"public.scheduled_publishes": "scheduled",
	"public.scheduled_publish_items": "scheduled",
	// Work under way or files on their way out, which the new Site doesn't need.
	"public.import_files": "working",
	"public.retired_script_files": "working",
	"public.retired_library_files": "working",
	"public.translation_tasks": "working",
	"public.translation_cache": "working",
	// What the Workspace that paid spent on AI stays with it.
	"public.ai_calls": "billing",
	"public.translation_counts": "billing",
	// Delivery logs and Reports' sends: what this Install sent.
	"public.webhook_deliveries": "sent",
	"public.webhook_delivery_attempts": "sent",
	"public.report_sends": "sent",
	"public.module_log": "sent",
	// Error groups are Install-wide; their Site links cannot move independently.
	"public.error_group_places": "install",
	// Transfer jobs, reports and temporary archives belong to their Install.
	"public.site_exports": "working",
	"public.site_imports": "working",
};

/**
 * Why a table is left out: `credential` (tokens, keys, links: never moved), `secrets` (carried apart,
 * under the passphrase), `session`, `working` (state of work under way), `members` (by email),
 * `published` (made again by publishing), `scheduled` (dropped and listed), `billing`, `sent`, `install`, `excluded` (an export option).
 */
export type LeftOutReason =
	| "credential"
	| "secrets"
	| "session"
	| "working"
	| "members"
	| "published"
	| "scheduled"
	| "billing"
	| "excluded"
	| "install"
	| "sent";

/** Rows of a table the export leaves out: Media variants (made again on import) and replaced files on their way out. */
const ROW_FILTERS: Readonly<Record<string, string>> = {
	"public.media_files": `t.role <> 'variant' AND t.retired_at IS NULL`,
	// Unclaimed uploads and detached deletion retries belong only to their original Install.
	"public.form_uploads": "t.submission_id IS NOT NULL",
	// A Relationship's published links are made again by publishing; the Draft's stay.
	"public.entry_links": `t.version = 'draft'`,
};

/** One table holding a Site's rows, as the catalog describes it. */
export type SiteTable = {
	/** `<schema>.<table>`. */
	name: string;
	schema: string;
	table: string;
	/** The Module it is of (by its schema), or null for WebCraft's own. */
	module: string | null;
	columns: string[];
	/** Columns Postgres fills from a sequence (an Audit log entry's id): a new value on import. */
	sequenced: string[];
	/** Columns naming a person (`people.id`). */
	personColumns: string[];
	/** Columns naming a row of a table left out (an Import run's file, a Review's schedule): emptied on import. */
	leftOutColumns: string[];
	/** Columns that can't be empty. */
	required: string[];
	/** Each column's default, as Postgres writes it (`true`, `'[]'::jsonb`), for the columns that have one. */
	defaults: Record<string, string>;
	/** For a table kept in monthly partitions: the column it is partitioned by. */
	partitionedBy: string | null;
	/** The extra condition the export reads its rows with, if any. */
	filter: string | null;
};

const SCHEMAS = `(n.nspname = 'public' OR n.nspname LIKE 'm\\_%')`;

/**
 * Every table holding a Site's rows (but those left out), in load order: a table after the tables its
 * foreign keys point at. `modules` names each Module schema's Module.
 */
export async function siteTables(
	client: pg.ClientBase,
	modules: ReadonlyMap<string, string>,
): Promise<{ tables: SiteTable[]; leftOut: { name: string; reason: LeftOutReason }[] }> {
	const { rows } = await client.query<{
		oid: number;
		schema: string;
		table: string;
		partitioned: boolean;
		columns: string[];
		sequenced: string[];
		required: string[];
		defaults: [string, string][] | null;
	}>(
		`SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS "table", c.relkind = 'p' AS partitioned,
				array(SELECT a.attname::text FROM pg_attribute a
					WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
					ORDER BY a.attnum) AS columns,
				array(SELECT a.attname::text FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
					WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
						AND (a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%')) AS sequenced,
				array(SELECT a.attname::text FROM pg_attribute a
					WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull) AS required,
				(SELECT json_agg(json_build_array(a.attname, pg_get_expr(d.adbin, d.adrelid))) FROM pg_attribute a
					JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
					WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '') AS defaults
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND ${SCHEMAS}
				AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'site_id' AND NOT a.attisdropped)
				AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped)
			ORDER BY n.nspname, c.relname`,
	);
	const leftOut: { name: string; reason: LeftOutReason }[] = [];
	const held = rows.filter((row) => {
		const name = `${row.schema}.${row.table}`;
		const reason = LEFT_OUT_TABLES[name];
		if (reason) leftOut.push({ name, reason });
		// A Module schema no Module of this build has (its Module is gone) isn't read.
		return !reason && (row.schema === "public" || modules.has(row.schema));
	});
	const leftOutOids = new Set(
		rows.filter((row) => LEFT_OUT_TABLES[`${row.schema}.${row.table}`]).map((row) => row.oid),
	);
	const keys = await client.query<{ table: number; target: number; target_name: string; columns: string[] }>(
		`SELECT con.conrelid::int AS "table", con.confrelid::int AS target,
				tn.nspname || '.' || t.relname AS target_name,
				array(SELECT a.attname::text FROM unnest(con.conkey) k JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k) AS columns
			FROM pg_constraint con JOIN pg_class t ON t.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = t.relnamespace
			WHERE con.contype = 'f' AND con.conparentid = 0`,
	);
	const byOid = new Map(held.map((row) => [row.oid, row]));
	const pointsAt = new Map<number, number[]>();
	const personColumns = new Map<number, string[]>();
	const leftOutColumns = new Map<number, string[]>();
	for (const key of keys.rows) {
		if (!byOid.has(key.table)) continue;
		if (key.target_name === "public.people" && key.columns.length === 1) {
			personColumns.set(key.table, [...(personColumns.get(key.table) ?? []), ...key.columns]);
		} else if (leftOutOids.has(key.target)) {
			// Only the column that isn't the Site's own (`site_id`) is emptied.
			const own = key.columns.filter((column) => column !== "site_id" && column !== "workspace_id");
			leftOutColumns.set(key.table, [...(leftOutColumns.get(key.table) ?? []), ...own]);
		} else if (key.target !== key.table && byOid.has(key.target)) {
			pointsAt.set(key.table, [...(pointsAt.get(key.table) ?? []), key.target]);
		}
	}
	const ordered: typeof held = [];
	const state = new Map<number, "visiting" | "done">();
	const visit = (row: (typeof held)[number]) => {
		const seen = state.get(row.oid);
		if (seen === "done") return;
		if (seen === "visiting") throw new Error(`The Site's tables' foreign keys go round in a circle at ${row.table}.`);
		state.set(row.oid, "visiting");
		for (const target of pointsAt.get(row.oid) ?? []) {
			const parent = byOid.get(target);
			if (parent) visit(parent);
		}
		state.set(row.oid, "done");
		ordered.push(row);
	};
	for (const row of held) visit(row);
	const partitions = await client.query<{ oid: number; column: string }>(
		`SELECT p.partrelid::int AS oid, a.attname::text AS column FROM pg_partitioned_table p
			JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = p.partattrs[0]`,
	);
	const partitionedBy = new Map(partitions.rows.map((row) => [row.oid, row.column]));
	return {
		tables: ordered.map((row) => {
			const name = `${row.schema}.${row.table}`;
			return {
				name,
				schema: row.schema,
				table: row.table,
				module: row.schema === "public" ? null : (modules.get(row.schema) ?? null),
				columns: row.columns,
				sequenced: row.sequenced,
				personColumns: personColumns.get(row.oid) ?? [],
				leftOutColumns: [...new Set(leftOutColumns.get(row.oid) ?? [])],
				required: row.required,
				defaults: Object.fromEntries(row.defaults ?? []),
				partitionedBy: row.partitioned ? (partitionedBy.get(row.oid) ?? null) : null,
				filter: ROW_FILTERS[name] ?? null,
			};
		}),
		leftOut,
	};
}

/** `schema.table` as a quoted name. */
export function quoted(table: Pick<SiteTable, "schema" | "table">): string {
	return `${ident(table.schema)}.${ident(table.table)}`;
}

export function ident(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

export function literal(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

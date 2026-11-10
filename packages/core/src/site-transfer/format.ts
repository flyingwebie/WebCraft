import semver from "semver";
import { z } from "zod";

import { WEBCRAFT_VERSION } from "../version.ts";

/**
 * A Site export's archive (ADR 0033) is a plain tar file (the same writer and reader as Backups'),
 * read and written as a stream:
 *
 * 1. `manifest.json`: what the archive holds (format, versions, the Site, its Modules, every file
 *    with its row count or size and its SHA-256, what was left out and why);
 * 2. `secrets.json`, only when the export was taken with a passphrase: the Site's secrets, each
 *    encrypted under a key derived from the passphrase (never under the Master key);
 * 3. `people.jsonl.gz`: the people the Site's rows name, and its Members and pending invites, by email;
 * 4. `data/<n>-<schema>.<table>.jsonl.gz`: one table's rows of the Site, one JSON object a line, in
 *    the order they load (a table after the tables its foreign keys point at);
 * 5. `files.jsonl.gz`, then `files/<storage key>`: the stored files the rows name (Media originals,
 *    Libraries and claimed private Form uploads), each once.
 *
 * Nothing in it is encrypted under the Master key or names one; ids are the Site's own, and every one
 * is replaced on import.
 */
export const SITE_EXPORT_FORMAT = "webcraft-site-export";

/** The version of the archive's layout this build writes. Older ones are brought up by `UPGRADES`. */
export const SITE_EXPORT_FORMAT_VERSION = 1;

export const MANIFEST_FILE = "manifest.json";
export const SECRETS_FILE = "secrets.json";
export const PEOPLE_FILE = "people.jsonl.gz";
export const FILES_INDEX = "files.jsonl.gz";
/** The folder of the stored files: `files/<storage key>`. */
export const FILES_FOLDER = "files/";

/** The largest manifest WebCraft reads: it is read before the archive can be trusted. */
export const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
/** The largest secrets file WebCraft reads. */
export const SECRETS_MAX_BYTES = 4 * 1024 * 1024;

/** A plain Postgres name, as WebCraft and its Modules name tables and columns. */
const PLAIN_NAME = /^[a-z_][a-z0-9_]*$/;
/** A table of WebCraft's (`public`) or a Module's (`m_<id>`) schema. */
const TABLE_NAME = /^(?:public|m_[a-z0-9_]+)\.[a-z_][a-z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const tableSchema = z.object({
	/** `<schema>.<table>`, such as `public.entries` or `m_forms.submissions`. */
	name: z.string().regex(TABLE_NAME),
	/** The Module the table is of; null for WebCraft's own. */
	module: z.string().nullable(),
	/** The columns its rows hold. */
	columns: z.array(z.string().regex(PLAIN_NAME)),
	rows: z.number().safe().nonnegative(),
	file: z.string().regex(/^data\/\d{4}-[a-z0-9_.]+\.jsonl\.gz$/),
	sha256: z.string().regex(SHA256),
});

const fileSchema = z.object({
	file: z.string(),
	sha256: z.string().regex(SHA256),
	rows: z.number().safe().nonnegative(),
});

/** What a Site export leaves out on purpose, listed so the Site import report can say so. */
const leftOutSchema = z.object({
	/** Tables of the Site's data that never go in, each with why (`credential`, `session`, …). */
	tables: z.array(z.object({ name: z.string(), reason: z.string() })),
	/** The Site's Content keys (by name): credentials never leave their Install. */
	contentKeys: z.array(z.string()),
	/** The Site's Share links (by name): links to a Dashboard belong to the Install that made them. */
	shareLinks: z.array(z.string()),
	/** The Site's Scheduled publishes: dropped, so nothing publishes by itself on the new Site. */
	scheduledPublishes: z.array(
		z.object({ action: z.string(), at: z.string(), items: z.array(z.string()), by: z.string().nullable() }),
	),
	/** Whether the Site had a staging password: a password never moves. */
	stagingPassword: z.boolean(),
	/** Explicitly excluded Submissions and private Form uploads. Older exports included them. */
	submissions: z.boolean().default(false),
});

/**
 * A Site export's manifest: what the archive holds. It is read before the archive can be trusted, so
 * every name it gives is of the shape WebCraft writes, and every count and checksum is checked.
 */
export const siteExportManifestSchema = z.object({
	format: z.literal(SITE_EXPORT_FORMAT),
	formatVersion: z.number().int().positive(),
	/** The archive's name as it was written. */
	name: z.string(),
	createdAt: z.iso.datetime(),
	webcraft: z.object({
		/** The WebCraft version the data was written by (the one that last migrated its database). */
		version: z.string(),
		/** The WebCraft version that wrote the export. */
		takenBy: z.string(),
	}),
	/** The Module SDK version of the build that wrote it. */
	sdk: z.string(),
	/** WebCraft's migrations the data was written at. */
	migrations: z.array(z.string()),
	site: z.object({
		id: z.string().regex(UUID),
		workspaceId: z.string().regex(UUID),
		name: z.string(),
		slug: z.string(),
		/** The rest of the Site's own settings, as its row holds them. */
		settings: z.record(z.string(), z.unknown()),
	}),
	/** The Modules whose data is in it, with the version that wrote it, and whether it ran on the Site. */
	modules: z.array(z.object({ id: z.string(), version: z.string(), tables: z.array(z.string()) })),
	tables: z.array(tableSchema),
	people: fileSchema,
	files: fileSchema.extend({ bytes: z.number().safe().nonnegative(), mediaBytes: z.number().safe().nonnegative() }),
	secrets: z.object({
		/** Whether the secrets are in `secrets.json`, under the export passphrase; without it they were dropped. */
		carried: z.boolean(),
		/** The names of the Site's secrets (carried or dropped), never their values. */
		names: z.array(z.string()),
		sha256: z.string().regex(SHA256).nullable(),
	}),
	leftOut: leftOutSchema,
	/** How many of the main things it holds, for the people about to import it. */
	counts: z.record(z.string(), z.number().safe().nonnegative()),
});

export type SiteExportManifest = z.infer<typeof siteExportManifestSchema>;

/** Why an archive isn't one an import takes. */
export type ArchiveRefusalReason =
	/** Not a Site export at all (or damaged): no manifest first, or a manifest that doesn't read. */
	| "not-an-export"
	/** A newer layout than this build reads. */
	| "newer-format"
	/** Written by a newer WebCraft than this one: upgrade this Install first. */
	| "newer-version"
	/** A file of it doesn't have the checksum or count the manifest gives. */
	| "damaged";

export class ArchiveRefusedError extends Error {
	override name = "ArchiveRefusedError";
	readonly reason: ArchiveRefusalReason;
	readonly details: Record<string, unknown>;
	constructor(reason: ArchiveRefusalReason, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.reason = reason;
		this.details = details;
	}
}

/**
 * One step bringing an older layout up to the next version: it rewrites the manifest, and the rows of
 * the tables whose shape it changed. Each layout change adds one step and raises
 * `SITE_EXPORT_FORMAT_VERSION`; the chain runs every step from the archive's version up.
 */
export type FormatUpgrade = {
	from: number;
	manifest(manifest: Record<string, unknown>): Record<string, unknown>;
	/** Rewrites one row of a table (`<schema>.<table>`); answers it as it was when the step leaves it alone. */
	row?(table: string, row: Record<string, unknown>): Record<string, unknown>;
};

/**
 * The upgrade chain, oldest first. Format 1 is the first layout, so it is empty: data an older
 * WebCraft wrote in it is brought up by the import itself (a table or column that didn't exist yet
 * takes its default; see `import.ts`).
 */
export const FORMAT_UPGRADES: readonly FormatUpgrade[] = [];

/**
 * Reads a manifest as an import takes it: refuses what isn't a Site export, a layout or WebCraft
 * version newer than this build, and brings an older layout up through the chain.
 */
export function readManifest(
	text: string,
	upgrades: readonly FormatUpgrade[] = FORMAT_UPGRADES,
): { manifest: SiteExportManifest; steps: FormatUpgrade[] } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new ArchiveRefusedError("not-an-export", "The archive's manifest isn't JSON.");
	}
	if (!json || typeof json !== "object" || (json as { format?: unknown }).format !== SITE_EXPORT_FORMAT) {
		throw new ArchiveRefusedError("not-an-export", "The file isn't a WebCraft Site export.");
	}
	const formatVersion = (json as { formatVersion?: unknown }).formatVersion;
	if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 1) {
		throw new ArchiveRefusedError("not-an-export", "The archive's manifest has no format version.");
	}
	if (formatVersion > SITE_EXPORT_FORMAT_VERSION) {
		throw new ArchiveRefusedError(
			"newer-format",
			`The export was written in a newer layout (${formatVersion}) than this WebCraft reads (${SITE_EXPORT_FORMAT_VERSION}). Update this Install first.`,
			{ formatVersion, readable: SITE_EXPORT_FORMAT_VERSION },
		);
	}
	const version = (json as { webcraft?: { version?: unknown } }).webcraft?.version;
	if (typeof version === "string" && semver.valid(version) && semver.valid(WEBCRAFT_VERSION)) {
		if (semver.gt(version, WEBCRAFT_VERSION)) {
			throw new ArchiveRefusedError(
				"newer-version",
				`The export was written by WebCraft ${version}, newer than this Install's ${WEBCRAFT_VERSION}. Update this Install first.`,
				{ version, running: WEBCRAFT_VERSION },
			);
		}
	}
	let upgraded = json as Record<string, unknown>;
	const steps: FormatUpgrade[] = [];
	for (let from = formatVersion; from < SITE_EXPORT_FORMAT_VERSION; from++) {
		const step = upgrades.find((each) => each.from === from);
		if (!step) {
			throw new ArchiveRefusedError("not-an-export", `WebCraft can't read layout ${from} of a Site export.`);
		}
		upgraded = { ...step.manifest(upgraded), formatVersion: from + 1 };
		steps.push(step);
	}
	const parsed = siteExportManifestSchema.safeParse(upgraded);
	if (!parsed.success) {
		throw new ArchiveRefusedError("not-an-export", "The archive's manifest isn't one WebCraft writes.");
	}
	const manifest = parsed.data;
	const unique = (items: readonly string[]) => new Set(items).size === items.length;
	const modules = new Map(manifest.modules.map((module) => [module.id, module]));
	if (
		!semver.valid(manifest.webcraft.version) ||
		!semver.valid(manifest.webcraft.takenBy) ||
		manifest.site.id === manifest.site.workspaceId ||
		manifest.people.file !== PEOPLE_FILE ||
		manifest.files.file !== FILES_INDEX ||
		manifest.secrets.carried !== (manifest.secrets.sha256 !== null) ||
		!unique(manifest.tables.map((table) => table.name)) ||
		!unique(manifest.tables.map((table) => table.file)) ||
		!unique(manifest.modules.map((module) => module.id)) ||
		!unique(manifest.secrets.names) ||
		manifest.tables.some(
			(table) =>
				!unique(table.columns) ||
				(table.module === null
					? !table.name.startsWith("public.")
					: !modules.has(table.module) || !table.name.startsWith(`m_${table.module.replaceAll("-", "_")}.`)),
		)
	)
		throw new ArchiveRefusedError("not-an-export", "The manifest has invalid or ambiguous identities.");
	if (semver.gt(manifest.webcraft.takenBy, WEBCRAFT_VERSION)) {
		throw new ArchiveRefusedError("newer-version", "The export was taken by a newer WebCraft.", {
			version: manifest.webcraft.takenBy,
			running: WEBCRAFT_VERSION,
		});
	}
	return { manifest, steps };
}

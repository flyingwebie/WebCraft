import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { lastMigratedVersion, readMigrationLevel } from "@webcraft/db";
import { SDK_VERSION } from "@webcraft/module-sdk";
import type pg from "pg";
import semver from "semver";
import { useDumpSettings } from "../backups/dump.ts";
import { type TarInput, writeTar } from "../backups/tar.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import type { StorageKind } from "../media/storage.ts";
import type { ScopedSecrets } from "../tenancy/data-layer.ts";
import { WEBCRAFT_VERSION } from "../version.ts";
import {
	FILES_FOLDER,
	FILES_INDEX,
	MANIFEST_FILE,
	PEOPLE_FILE,
	SECRETS_FILE,
	SITE_EXPORT_FORMAT,
	SITE_EXPORT_FORMAT_VERSION,
	type SiteExportManifest,
} from "./format.ts";
import { type Kdf, type SecretsBundle, secretSealer } from "./passphrase.ts";
import { createRowRemapper } from "./references.ts";
import { ident, literal, quoted, type SiteTable, siteTables } from "./tables.ts";

/** One line of `people.jsonl.gz`: a person the Site's rows name, or one of its Members or invites. */
export type ExportedPerson = {
	/** Their id on the Install the export came from; null for an invite to an address without an account. */
	id: string | null;
	name: string | null;
	email: string;
	/** `superadmin` or `staff` when they held that role there. */
	installRole: string | null;
	/** Their Membership's Workspace role, when it reached the Site. */
	member: { role: string } | null;
	/** A pending invite reaching the Site, with the role it grants. */
	invite: { role: string } | null;
	/** Whether the Site's rows name them (they wrote, published, reviewed something). */
	referenced: boolean;
};

/** What writing an export needs. */
export type ExportWriterContext = {
	database: { pool: pg.Pool };
	storage: InstallStorage;
	/** Each Module schema's Module, with its version: `m_forms` → `forms`. */
	modules: ReadonlyMap<string, { id: string; version: string }>;
	/** Rows fetched at a time from each table (the streaming threshold). */
	batchRows: number;
	/** Leave the Forms Module's Submissions and every private Form upload out together. */
	includeSubmissions?: boolean;
	now(): Date;
	/** Says how far it got: a step and its count. */
	progress(step: "tables" | "files" | "archive", done: number, total: number): Promise<void>;
};

/** The Site's secrets, sealed under the passphrase's key inside the `useWith` holding each. */
export type ExportSecrets = {
	secrets: Pick<ScopedSecrets, "names" | "useWith">;
	/** The key `passphraseKey` gave, used inside this call only; null to drop the secrets. */
	withKey<Result>(use: (key: string) => Promise<Result>): Promise<Result>;
	kdf: Kdf;
} | null;

export type WrittenExport = { manifest: SiteExportManifest; bytes: AsyncIterable<Uint8Array>; done(): Promise<void> };

/**
 * Reads the Site into a temporary folder (one consistent snapshot of every table holding its rows,
 * a batch of rows at a time, so a big Site never sits in memory), hashes the stored files it names,
 * and answers the archive as a stream of bytes, manifest first: write it where it goes, then call
 * `done` to remove the folder. `secrets` carries the Site's secrets under the passphrase, or drops
 * them (null).
 */
export async function writeSiteExport(
	context: ExportWriterContext,
	site: { id: string; workspaceId: string },
	secrets: ExportSecrets,
	secretNames: () => Promise<string[]>,
): Promise<WrittenExport> {
	const folder = await mkdtemp(join(tmpdir(), "webcraft-site-export-"));
	try {
		const snapshot = await readSnapshot(context, site, folder);
		const names = await secretNames();
		let bundle: SecretsBundle | null = null;
		if (secrets) {
			bundle = await secrets.withKey(async (key) => {
				const sealer = await secretSealer(key);
				const sealed: SecretsBundle["secrets"] = [];
				for (const name of names) {
					const one = await secrets.secrets.useWith(name, (value) => sealer.secret(name, value)).catch(() => null);
					if (one) sealed.push(one);
				}
				return { kdf: secrets.kdf, check: await sealer.check(), secrets: sealed };
			});
		}
		const secretsBytes = bundle ? new TextEncoder().encode(`${JSON.stringify(bundle)}\n`) : null;
		const files = await hashFiles(context, snapshot.fileKeys);
		const filesIndex = await writeGzipLines(
			join(folder, "files.jsonl.gz"),
			files.map((file) => JSON.stringify({ key: file.key, size: file.size, sha256: file.sha256 })),
		);
		const manifest: SiteExportManifest = {
			format: SITE_EXPORT_FORMAT,
			formatVersion: SITE_EXPORT_FORMAT_VERSION,
			name: archiveName(snapshot.site.slug, context.now()),
			createdAt: context.now().toISOString(),
			webcraft: { version: snapshot.version ?? WEBCRAFT_VERSION, takenBy: WEBCRAFT_VERSION },
			sdk: SDK_VERSION,
			migrations: snapshot.migrations,
			site: snapshot.site,
			modules: snapshot.modules,
			tables: snapshot.tables.map((table) => table.entry),
			people: { file: PEOPLE_FILE, sha256: snapshot.people.sha256, rows: snapshot.people.rows },
			files: {
				file: FILES_INDEX,
				sha256: filesIndex.sha256,
				rows: files.length,
				bytes: files.reduce((sum, file) => sum + file.size, 0),
				mediaBytes: files.filter((file) => file.media).reduce((sum, file) => sum + file.size, 0),
			},
			secrets: {
				carried: secretsBytes !== null,
				names,
				sha256: secretsBytes ? sha256(secretsBytes) : null,
			},
			leftOut: snapshot.leftOut,
			counts: snapshot.counts,
		};
		const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, "\t")}\n`);
		let sent = 0;
		async function* entries(): AsyncGenerator<TarInput> {
			yield { path: MANIFEST_FILE, size: manifestBytes.length, body: manifestBytes };
			if (secretsBytes) yield { path: SECRETS_FILE, size: secretsBytes.length, body: secretsBytes };
			yield { path: PEOPLE_FILE, size: snapshot.people.size, body: readFile(snapshot.people.path) };
			for (const table of snapshot.tables) {
				yield { path: table.entry.file, size: table.size, body: readFile(table.path) };
			}
			yield { path: FILES_INDEX, size: filesIndex.size, body: readFile(filesIndex.path) };
			for (const file of files) {
				const backend = await context.storage.holding(file.storage);
				const stream = await backend.stream(file.key);
				if (!stream) throw new Error(`A stored file of the Site went missing while it was exported: ${file.key}`);
				yield { path: `${FILES_FOLDER}${file.key}`, size: file.size, body: stream as AsyncIterable<Uint8Array> };
				sent++;
				if (sent % 50 === 0 || sent === files.length) await context.progress("archive", sent, files.length);
			}
		}
		return {
			manifest,
			bytes: writeTar(entries()),
			done: () => rm(folder, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(folder, { recursive: true, force: true });
		throw error;
	}
}

type Snapshot = {
	site: SiteExportManifest["site"];
	version: string | null;
	migrations: string[];
	modules: SiteExportManifest["modules"];
	tables: { entry: SiteExportManifest["tables"][number]; path: string; size: number }[];
	people: { path: string; size: number; sha256: string; rows: number };
	leftOut: SiteExportManifest["leftOut"];
	counts: Record<string, number>;
	fileKeys: { storage: StorageKind; key: string; media: boolean }[];
};

/** What the manifest counts for people about to import it: table → name. */
const COUNTED: Readonly<Record<string, string>> = {
	"public.entries": "entries",
	"public.post_types": "postTypes",
	"public.media": "media",
	"public.templates": "templates",
	"public.components": "components",
	"public.forms": "forms",
	"public.revisions": "revisions",
	"public.checkpoints": "checkpoints",
	"public.reviews": "reviews",
	"public.site_languages": "languages",
	"public.audit_log": "auditEntries",
	"m_forms.submissions": "submissions",
	"m_site_analytics.events": "analyticsEvents",
	"m_redirects.rules": "redirectRules",
	"m_redirects.misses": "notFoundLog",
};

/** Reads every table of the Site in one snapshot, into gzip-compressed JSON Lines files in `folder`. */
async function readSnapshot(
	context: ExportWriterContext,
	site: { id: string; workspaceId: string },
	folder: string,
): Promise<Snapshot> {
	const client = await context.database.pool.connect();
	try {
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		await useDumpSettings(client);
		const level = await readMigrationLevel(client);
		const version = await lastMigratedVersion(client);
		const siteRows = await client.query<{ row: Record<string, unknown> }>(
			"SELECT row_to_json(s) AS row FROM public.sites s WHERE s.id = $1 AND s.workspace_id = $2",
			[site.id, site.workspaceId],
		);
		const siteRow = siteRows.rows[0]?.row;
		if (!siteRow) throw new Error("The Site was deleted before it could be exported.");
		const schemaModules = new Map([...context.modules].map(([schema, module]) => [schema, module.id]));
		const { tables: available, leftOut } = await siteTables(client, schemaModules);
		const retained = await client.query<{
			table_name: string;
			module_id: string;
			module_version: string;
			definition: Pick<SiteTable, "columns" | "uuidColumns" | "primaryColumns" | "personColumns">;
		}>(
			"SELECT table_name, module_id, module_version, definition FROM public.site_retained_tables WHERE workspace_id = $1 AND site_id = $2 ORDER BY (definition->>'position')::integer, table_name",
			[site.workspaceId, site.id],
		);
		const held = new Map(retained.rows.map((row) => [row.table_name, row]));
		const live = new Set(available.map((table) => table.name));
		for (const table of available) {
			const retained = held.get(table.name);
			if (retained) {
				table.columns = [...new Set([...table.columns, ...retained.definition.columns])];
				const current = new Set(table.uuidColumns.map((column) => column.name));
				table.uuidColumns.push(...retained.definition.uuidColumns.filter((column) => !current.has(column.name)));
				table.personColumns = [...new Set([...table.personColumns, ...retained.definition.personColumns])];
			}
		}
		for (const row of retained.rows)
			if (!live.has(row.table_name)) {
				const [schema, table] = row.table_name.split(".") as [string, string];
				available.push({
					name: row.table_name,
					schema,
					table,
					module: row.module_id,
					...row.definition,
					sequenced: [],
					required: [],
					defaults: {},
					partitionedBy: null,
					leftOutColumns: [],
					filter: null,
				});
			}
		const includeSubmissions = context.includeSubmissions !== false;
		const tables = available.filter((table) => {
			if (!includeSubmissions && (table.name === "m_forms.submissions" || table.name === "public.form_uploads")) {
				leftOut.push({ name: table.name, reason: "excluded" });
				return false;
			}
			return true;
		});
		const named = new Set<string>();
		// The same typed traversal discovers person references; a UUID in literal text is never an account.
		const findPeople = createRowRemapper(
			async (name, id, path) => {
				const [schema, table] = name.split(".") as [string, string];
				const result = await client.query<{ value: unknown }>(
					`SELECT to_jsonb(t) #> $3::text[] AS value FROM ${quoted({ schema, table })} t WHERE t.workspace_id=$1 AND t.site_id=$2 AND ($4::text IS NULL OR to_jsonb(t)->>'id'=$4) LIMIT 1`,
					[site.workspaceId, site.id, path, id],
				);
				return result.rows[0]?.value;
			},
			{ id: (id) => id, key: (key) => key, secret: (name) => name, mask: "" },
			new Map(),
			(id) => named.add(id),
		);
		const written: Snapshot["tables"] = [];
		const counts: Record<string, number> = {};
		const where = `t.site_id = ${literal(site.id)} AND t.workspace_id = ${literal(site.workspaceId)}`;
		for (const [index, table] of tables.entries()) {
			const file = `data/${String(index + 1).padStart(4, "0")}-${table.name}.jsonl.gz`;
			const path = join(folder, `${String(index + 1).padStart(4, "0")}.jsonl.gz`);
			let rows = 0;
			async function* lines(): AsyncGenerator<string> {
				// Rows filled from a sequence go in its order, so their new values keep it (the Audit log's).
				const order = table.sequenced.length
					? ` ORDER BY ${table.sequenced.map((column) => `t.${ident(column)}`).join(", ")}`
					: "";
				const liveRows = `SELECT to_jsonb(t) AS value FROM ${quoted(table)} t WHERE ${where}${table.filter ? ` AND ${table.filter}` : ""}${order}`;
				const retainedRows = `SELECT r.value FROM public.site_retained_rows r WHERE r.workspace_id = ${literal(site.workspaceId)} AND r.site_id = ${literal(site.id)} AND r.table_name = ${literal(table.name)}`;
				let select = live.has(table.name) ? liveRows : `${retainedRows} ORDER BY r.position`;
				if (live.has(table.name) && held.has(table.name)) {
					// Live primary keys win. Without a key, multiset subtraction preserves legitimate equal rows
					// while avoiding duplicates when a Module has already restored some retained data.
					const keys = table.primaryColumns;
					const remaining = keys.length
						? `${retainedRows} AND NOT EXISTS (SELECT 1 FROM ${quoted(table)} t WHERE ${where} AND ${keys.map((key) => `to_jsonb(t)->${literal(key)} IS NOT DISTINCT FROM r.value->${literal(key)}`).join(" AND ")})`
						: `(${retainedRows}) EXCEPT ALL (${liveRows})`;
					select = `(${liveRows}) UNION ALL (${remaining})`;
				}
				await client.query(`DECLARE site_rows NO SCROLL CURSOR FOR SELECT x.value::text AS line FROM (${select}) x`);
				try {
					for (;;) {
						const batch = await client.query<{ line: string }>(`FETCH ${context.batchRows} FROM site_rows`);
						if (batch.rows.length === 0) break;
						for (const { line } of batch.rows) {
							rows++;
							// People are named in columns and inside values (who wrote a value, who impersonated whom).
							await findPeople(JSON.parse(line), table.name, table.uuidColumns, table.personColumns);
							yield `${line}\n`;
						}
					}
				} finally {
					await client.query("CLOSE site_rows");
				}
			}
			const { size, sha256: hash } = await writeGzip(path, lines());
			written.push({
				entry: {
					name: table.name,
					module: table.module,
					columns: table.columns,
					uuidColumns: table.uuidColumns,
					primaryColumns: table.primaryColumns,
					personColumns: table.personColumns,
					rows,
					file,
					sha256: hash,
				},
				path,
				size,
			});
			const counted = COUNTED[table.name];
			if (counted) counts[counted] = rows;
			await context.progress("tables", index + 1, tables.length);
		}
		const peopleLines = await exportedPeople(client, site, named, context.now());
		counts.members = peopleLines.filter((person) => person.member).length;
		counts.invites = peopleLines.filter((person) => person.invite).length;
		const peopleFile = await writeGzipLines(
			join(folder, "people.jsonl.gz"),
			peopleLines.map((person) => JSON.stringify(person)),
		);
		const lists = await leftOutLists(client, site);
		const fileKeys = await storedFiles(client, site, includeSubmissions);
		await client.query("COMMIT");
		const { id, workspace_id, name, slug, ...settings } = siteRow as {
			id: string;
			workspace_id: string;
			name: string;
			slug: string;
		} & Record<string, unknown>;
		delete settings.staging_password_hash;
		delete settings.staging_password_changed_at;
		const moduleVersions = new Map([...context.modules.values()].map((module) => [module.id, module.version]));
		for (const row of retained.rows) {
			const current = moduleVersions.get(row.module_id);
			if (!current || semver.gt(row.module_version, current)) moduleVersions.set(row.module_id, row.module_version);
		}
		return {
			site: { id, workspaceId: workspace_id, name, slug, settings },
			version,
			migrations: [...level.core],
			modules: [...moduleVersions]
				.filter(([id]) => tables.some((table) => table.module === id))
				.map(([id, version]) => ({
					id,
					version,
					tables: tables.filter((table) => table.module === id).map((table) => table.table),
				})),
			tables: written,
			people: { ...peopleFile, rows: peopleLines.length },
			leftOut: {
				tables: leftOut,
				...lists,
				stagingPassword: siteRow.staging_password_hash != null,
				submissions: !includeSubmissions,
			},
			counts,
			fileKeys,
		};
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
	}
}

/**
 * The people the export names: everyone the Site's rows name (who wrote, published, reviewed), its
 * Members (with their Workspace role) and its pending invites, by email. Never anything they sign in with.
 */
async function exportedPeople(
	client: pg.ClientBase,
	site: { id: string; workspaceId: string },
	named: ReadonlySet<string>,
	now: Date,
): Promise<ExportedPerson[]> {
	const members = await client.query<{ id: string; name: string; email: string; role: string }>(
		`SELECT p.id::text, p.name, p.email, m.role FROM public.memberships m JOIN public.people p ON p.id = m.person_id
			WHERE m.workspace_id = $2 AND (m.all_sites OR EXISTS (
				SELECT 1 FROM public.membership_sites s WHERE s.membership_id = m.id AND s.site_id = $1))`,
		[site.id, site.workspaceId],
	);
	const ids = [...new Set([...named, ...members.rows.map((row) => row.id)])];
	const people = await client.query<{ id: string; name: string; email: string; role: string | null }>(
		`SELECT p.id::text, p.name, p.email, r.role FROM public.people p
			LEFT JOIN public.install_roles r ON r.person_id = p.id WHERE p.id = ANY($1::uuid[]) ORDER BY p.email`,
		[ids],
	);
	const memberRole = new Map(members.rows.map((row) => [row.id, row.role]));
	const listed: ExportedPerson[] = people.rows.map((row) => ({
		id: row.id,
		name: row.name,
		email: row.email,
		installRole: row.role,
		member: memberRole.has(row.id) ? { role: memberRole.get(row.id) as string } : null,
		invite: null,
		referenced: named.has(row.id),
	}));
	const invites = await client.query<{ email: string; role: string }>(
		`SELECT i.email, i.role FROM public.invites i
			WHERE i.workspace_id = $2 AND i.expires_at > $3 AND (i.all_sites OR EXISTS (
				SELECT 1 FROM public.invite_sites s WHERE s.invite_id = i.id AND s.site_id = $1))
			ORDER BY i.email`,
		[site.id, site.workspaceId, now],
	);
	for (const invite of invites.rows) {
		listed.push({
			id: null,
			name: null,
			email: invite.email,
			installRole: null,
			member: null,
			invite: { role: invite.role },
			referenced: false,
		});
	}
	return listed;
}

/** What never moves, by name, so the Site import report can say so. */
async function leftOutLists(
	client: pg.ClientBase,
	site: { id: string },
): Promise<Omit<SiteExportManifest["leftOut"], "tables" | "stagingPassword" | "submissions">> {
	const contentKeys = await client.query<{ name: string }>(
		"SELECT name FROM public.content_keys WHERE site_id = $1 AND revoked_at IS NULL ORDER BY name",
		[site.id],
	);
	const shareLinks = await client.query<{ name: string }>(
		"SELECT name FROM public.share_links WHERE site_id = $1 AND revoked_at IS NULL ORDER BY name",
		[site.id],
	);
	const schedules = await client.query<{ action: string; at: Date; by: string | null; items: string[] }>(
		`SELECT s.action, s.at, p.name AS by,
				array(SELECT i.name FROM public.scheduled_publish_items i WHERE i.schedule_id = s.id ORDER BY i.position) AS items
			FROM public.scheduled_publishes s LEFT JOIN public.people p ON p.id = s.created_by
			WHERE s.site_id = $1 ORDER BY s.at`,
		[site.id],
	);
	return {
		contentKeys: contentKeys.rows.map((row) => row.name),
		shareLinks: shareLinks.rows.map((row) => row.name),
		scheduledPublishes: schedules.rows.map((row) => ({
			action: row.action,
			at: new Date(row.at).toISOString(),
			items: row.items,
			by: row.by,
		})),
	};
}

/** Media originals, Libraries and claimed private Form uploads, each read from its recorded backend. */
async function storedFiles(
	client: pg.ClientBase,
	site: { id: string },
	includeSubmissions: boolean,
): Promise<{ storage: StorageKind; key: string; media: boolean }[]> {
	const { rows } = await client.query<{ storage: string; key: string; media: boolean }>(
		`SELECT DISTINCT ON (key) storage, key, media FROM (
			SELECT f.storage, f.key, true AS media FROM public.media_files f
				WHERE f.site_id = $1 AND f.role <> 'variant' AND f.retired_at IS NULL
			UNION ALL
			SELECT l.storage, l.storage_key AS key, false AS media FROM public.libraries l
				WHERE l.site_id = $1 AND l.storage_key IS NOT NULL AND l.storage IS NOT NULL
			UNION ALL
			SELECT u.storage, u.key, false AS media FROM public.form_uploads u
				WHERE u.site_id = $1 AND u.submission_id IS NOT NULL AND $2
		) files ORDER BY key`,
		[site.id, includeSubmissions],
	);
	return rows.map((row) => ({ storage: row.storage === "s3" ? "s3" : "disk", key: row.key, media: row.media }));
}

/** Each stored file's size and SHA-256, read once before the archive is written (so the manifest has them). */
async function hashFiles(
	context: ExportWriterContext,
	keys: Snapshot["fileKeys"],
): Promise<(Snapshot["fileKeys"][number] & { size: number; sha256: string })[]> {
	const hashed: (Snapshot["fileKeys"][number] & { size: number; sha256: string })[] = [];
	for (const [index, file] of keys.entries()) {
		const backend = await context.storage.holding(file.storage);
		const stream = await backend.stream(file.key);
		// Every file named by the snapshot must be present, or its rows could not round-trip.
		if (!stream) throw new Error("A stored file required by the Site export is missing.");
		const hash = createHash("sha256");
		let size = 0;
		for await (const chunk of stream as AsyncIterable<Uint8Array>) {
			hash.update(chunk);
			size += chunk.length;
		}
		hashed.push({ ...file, size, sha256: hash.digest("hex") });
		if ((index + 1) % 50 === 0 || index + 1 === keys.length) await context.progress("files", index + 1, keys.length);
	}
	return hashed;
}

/** `webcraft-site-bakery-20260302-090000.tar`. */
function archiveName(slug: string, at: Date): string {
	const stamp = at
		.toISOString()
		.replace(/\.\d{3}Z$/, "")
		.replace(/[-:]/g, "")
		.replace("T", "-");
	return `webcraft-site-${slug}-${stamp}.tar`;
}

async function writeGzip(path: string, lines: AsyncIterable<string>): Promise<{ size: number; sha256: string }> {
	await pipeline(Readable.from(lines), createGzip(), createWriteStream(path));
	return { size: (await stat(path)).size, sha256: await hashFile(path) };
}

async function writeGzipLines(
	path: string,
	lines: readonly string[],
): Promise<{ path: string; size: number; sha256: string }> {
	async function* each() {
		for (const line of lines) yield `${line}\n`;
	}
	const written = await writeGzip(path, each());
	return { path, ...written };
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

function readFile(path: string): AsyncIterable<Uint8Array> {
	return createReadStream(path) as AsyncIterable<Uint8Array>;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { FORM_LIMITS } from "@webcraft/renderer";
import type pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import { z } from "zod";

import { useDumpSettings } from "../backups/dump.ts";
import { readTar, type TarEntry } from "../backups/tar.ts";
import { MediaQuotaFullError } from "../media/errors.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { keyParts } from "../media/storage.ts";
import { INVITE_LIFETIME_MS } from "../tenancy/invites.ts";
import type { ExportedPerson } from "./export.ts";
import {
	ArchiveRefusedError,
	FILES_FOLDER,
	FILES_INDEX,
	FORMAT_UPGRADES,
	type FormatUpgrade,
	MANIFEST_FILE,
	MANIFEST_MAX_BYTES,
	PEOPLE_FILE,
	readManifest,
	SECRETS_FILE,
	SECRETS_MAX_BYTES,
	type SiteExportManifest,
} from "./format.ts";
import { createReferenceLookup } from "./lookup.ts";
import { type ModuleComponentDeclaration, modulePropFields, retainModuleDeclarations } from "./module-declarations.ts";
import { keyOpens, openSecrets, type SecretsBundle, secretsBundleSchema } from "./passphrase.ts";
import { createRowRemapper } from "./references.ts";
import { type IdMap, idMap, newMask } from "./remap.ts";
import { ident, literal, quoted, type SiteTable, siteTables } from "./tables.ts";

/** The Site import report (GLOSSARY.md): what came in, and what was reassigned, dropped, paused and invited. */
export type SiteImportReport = {
	/** The Site it came from: its name and slug there, and the WebCraft version that wrote the export. */
	from: { name: string; slug: string; webcraft: string; exportedAt: string; upgraded: boolean };
	/** How many of each main thing came in, as the export counted them. */
	counts: Record<string, number>;
	/** Media and Library files copied into storage, and their bytes. */
	files: { count: number; bytes: number };
	/** Everything arrived as Drafts: how many items had a published version on the Site it came from. */
	drafts: { published: number };
	/** People the Site's rows named who have no account here: what they did is attributed to the importing person. */
	reassigned: { name: string | null; email: string; was: string | null }[];
	/** Members with an account here who are Members of this Workspace: their role kept, the new Site added. */
	matched: { email: string; name: string | null; role: string }[];
	/** Staff and the Superadmin of this Install the rows name, kept as themselves (Staff need no Membership). */
	staff: { email: string; name: string | null }[];
	/** Members and invites who became pending invitations to the new Site: no email until someone sends them. */
	invited: { email: string; role: string; inviteId: string; sent: boolean }[];
	/** Domains that came paused: they serve nothing until Staff switch them on. */
	paused: { name: string; role: string; language: string | null }[];
	/** Secrets: carried (under the passphrase) and set on the new Site, or dropped (by name). */
	secrets: { set: string[]; dropped: string[]; reason: "noPassphrase" | "notCarried" | "unreadable" | null };
	/** Webhooks switched off because their signing secret was dropped. */
	webhooksOff: string[];
	/** Reports that came paused (they would otherwise start emailing on their schedule). */
	reportsPaused: string[];
	/** What never moves between Installs, by name: Content keys, Share links, Scheduled publishes, the staging password, … */
	dropped: SiteExportManifest["leftOut"];
	/** Modules the data needs, and whether this Install runs them. Data of a Module this build lacks is kept aside. */
	modules: { id: string; version: string; status: ModuleTransferStatus; keptAside: boolean }[];
};

/** How a Module the export needs stands on this Install. */
export type ModuleTransferStatus = "approved" | "waiting" | "update-waiting" | "cannot-run" | "missing";

/** What reading an import needs. */
export type ImportReaderContext = {
	database: { pool: pg.Pool };
	storage: InstallStorage;
	/** Each Module schema of this build's Modules: `m_forms` → `forms`. */
	moduleSchemas: ReadonlyMap<string, string>;
	moduleComponents: readonly ModuleComponentDeclaration[];
	moduleStatus(moduleId: string): Promise<ModuleTransferStatus>;
	/** Makes the monthly partitions a partitioned Module table needs for these months, in the transaction. */
	preparePartitions(client: pg.ClientBase, moduleId: string, table: string, months: Date[]): Promise<void>;
	now(): Date;
	progress(step: "tables" | "files" | "people", done: number, total: number): Promise<void>;
	upgrades?: readonly FormatUpgrade[];
	/** Finalizes secrets, jobs, Audit and the durable report on this same transaction. */
	finish(client: pg.PoolClient, imported: ImportedSite): Promise<void>;
};

/** What the person importing chose. */
export type ImportPlan = {
	workspaceId: string;
	name: string;
	slug: string;
	/** Who imports it: what people without an account here did is attributed to them. Null for a server command. */
	importer: string | null;
	/** The key the passphrase gave (`passphraseKey`), or null to drop the secrets. */
	secretsKey: string | null;
};

export type ImportedSite = {
	siteId: string;
	report: SiteImportReport;
	/** The secrets to set on the new Site before its transaction commits. */
	secrets: { name: string; value: string }[];
	/** Media to process and to make variants of, as a restore queues them. */
	media: { process: string[]; variants: string[] };
};

/** The head of an archive: its manifest, and the passphrase check when it carries secrets. */
export type ArchiveHead = { manifest: SiteExportManifest; secrets: Pick<SecretsBundle, "kdf" | "check"> | null };

/** Reads only the head of an archive (its first files), to check it before anything is imported. */
export async function readArchiveHead(archive: AsyncIterable<Uint8Array>): Promise<ArchiveHead> {
	const reader = new ArchiveReader(archive);
	try {
		const { manifest } = await reader.manifest();
		if (!manifest.secrets.carried) return { manifest, secrets: null };
		const bundle = await reader.secrets(manifest);
		return { manifest, secrets: { kdf: bundle.kdf, check: bundle.check } };
	} finally {
		await reader.close();
	}
}

/**
 * Imports a Site export into a Workspace as a new Site: every row loaded in one transaction (ids
 * replaced, Content as Drafts, domains paused, Members matched or invited), every stored file copied,
 * checksums checked as it goes. On any failure nothing stays: the transaction rolls back and the files
 * copied are removed.
 */
export async function importSite(
	context: ImportReaderContext,
	archive: AsyncIterable<Uint8Array>,
	plan: ImportPlan,
): Promise<ImportedSite> {
	const reader = new ArchiveReader(archive);
	const copied: { backend: Awaited<ReturnType<InstallStorage["current"]>>; key: string }[] = [];
	const client = await context.database.pool.connect();
	let open = false;
	try {
		const { manifest, steps } = await reader.manifest(context.upgrades ?? FORMAT_UPGRADES);
		if (
			manifest.leftOut.submissions &&
			manifest.tables.some(
				(table) => (table.name === "m_forms.submissions" || table.name === "public.form_uploads") && table.rows > 0,
			)
		) {
			throw new ArchiveRefusedError("damaged", "The archive carries Submissions it declares excluded.");
		}
		// Layouts 1/2 did not carry Prop contracts. Only an explicitly matching source version is a fallback.
		const moduleComponents =
			manifest.moduleComponents ??
			context.moduleComponents.filter((component) =>
				manifest.modules.some((module) => module.id === component.moduleId && module.version === component.version),
			);
		const bundle = manifest.secrets.carried ? await reader.secrets(manifest) : null;
		const people = await reader.people(manifest);

		await client.query("BEGIN");
		open = true;
		await useDumpSettings(client);
		// The same lock as Media uploads and quota changes, held until the new Site commits.
		await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
			`webcraft:media-quota:${plan.workspaceId}`,
		]);
		const persons = await matchPeople(client, people);
		const ids = idMap(newMask(), new Map([[manifest.site.workspaceId, plan.workspaceId], ...persons.ids]));
		const siteId = ids.id(manifest.site.id);
		const missingPeople = new Map(persons.unmatched.map((person) => [ids.id(person.id), plan.importer]));
		await insertSite(client, manifest, plan, siteId, context.now());
		await retainModuleDeclarations(client, { workspaceId: plan.workspaceId, id: siteId }, moduleComponents);
		const target = new Map(
			(await siteTables(client, context.moduleSchemas)).tables.map((table) => [table.name, table] as const),
		);
		await client.query(
			"CREATE TEMP TABLE site_import_rows (n bigserial PRIMARY KEY, line text NOT NULL) ON COMMIT DROP",
		);
		await client.query(
			"CREATE TEMP TABLE site_import_source_rows (n bigserial PRIMARY KEY, table_name text NOT NULL, line text NOT NULL) ON COMMIT DROP",
		);
		await client.query("CREATE INDEX ON site_import_source_rows (table_name, ((line::jsonb)->>'id'))");
		await client.query(
			"CREATE TEMP TABLE site_import_people (id uuid PRIMARY KEY, name text, email text) ON COMMIT DROP",
		);
		await client.query(`CREATE TEMP TABLE site_import_upload_refs (
   id uuid PRIMARY KEY, submission_id uuid NOT NULL, form_id uuid NOT NULL,
   field_key text NOT NULL, name text NOT NULL, content_type text NOT NULL,
   size bigint NOT NULL CHECK (size >= 0 AND size <= ${FORM_LIMITS.fileBytes})
  ) ON COMMIT DROP`);
		for (const person of persons.unmatched) {
			await client.query("INSERT INTO site_import_people VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
				ids.id(person.id),
				person.name,
				person.email,
			]);
		}
		const keptAside = new Set<string>();
		const currentDeclarations = new Map(context.moduleComponents.map((component) => [component.id, component]));
		for (const component of moduleComponents) {
			const current = currentDeclarations.get(component.id);
			if (
				!current ||
				current.version !== component.version ||
				JSON.stringify(current.props) !== JSON.stringify(component.props)
			)
				keptAside.add(component.moduleId);
		}
		for (const table of manifest.tables) {
			const entry = await reader.next(table.file);
			const rows = await stageRows(client, entry, table.sha256, steps, table.name);
			if (rows !== table.rows) {
				throw new ArchiveRefusedError(
					"damaged",
					`${table.file} holds ${rows} rows, not the ${table.rows} the manifest says.`,
				);
			}
		}
		const remap = createRowRemapper(
			createReferenceLookup(client),
			ids,
			missingPeople,
			undefined,
			modulePropFields(moduleComponents),
		);
		for (const [index, table] of manifest.tables.entries()) {
			const here = target.get(table.name);
			const columns = here?.uuidColumns ?? table.uuidColumns;
			if (!columns && table.module)
				throw new ArchiveRefusedError(
					"damaged",
					"An unavailable Module's legacy table has no reference types. Export it again with current WebCraft.",
				);
			await client.query(
				`DECLARE original_rows NO SCROLL CURSOR FOR SELECT line FROM site_import_source_rows WHERE table_name = ${literal(table.name)} ORDER BY n`,
			);
			try {
				for (;;) {
					// One bounded row at a time, with original Structure in Postgres for reference resolution.
					const result = await client.query<{ line: string }>("FETCH 1 FROM original_rows");
					if (!result.rows[0]) break;
					const row = safeJson(result.rows[0].line);
					if (!row || typeof row !== "object" || Array.isArray(row))
						throw new ArchiveRefusedError("damaged", "A table row must be an object.");
					const mapped = await remap(
						row as Record<string, unknown>,
						table.name,
						columns ?? [],
						here?.personColumns ?? table.personColumns ?? [],
					);
					await client.query("INSERT INTO site_import_rows (line) VALUES ($1)", [JSON.stringify(mapped)]);
				}
			} finally {
				await client.query("CLOSE original_rows");
			}
			if (table.name === "m_forms.submissions") await stageUploadReferences(client);
			if (!here) {
				if (table.module) {
					// Missing Module rows remain durable, scoped and streamable independently of the report.
					keptAside.add(table.module);
					const definition = {
						position: index,
						columns: [...new Set([...table.columns, "workspace_id", "site_id"])],
						uuidColumns: [
							...(columns ?? []).filter((column) => !["workspace_id", "site_id"].includes(column.name)),
							{ name: "workspace_id", array: false },
							{ name: "site_id", array: false },
						],
						primaryColumns: table.primaryColumns ?? [],
						personColumns: table.personColumns ?? [],
					};
					await client.query(
						"INSERT INTO public.site_retained_tables (workspace_id, site_id, table_name, module_id, module_version, definition) VALUES ($1,$2,$3,$4,$5,$6)",
						[
							plan.workspaceId,
							siteId,
							table.name,
							table.module,
							manifest.modules.find((module) => module.id === table.module)?.version,
							JSON.stringify(definition),
						],
					);
					await client.query(
						`INSERT INTO public.site_retained_rows (workspace_id, site_id, table_name, position, value)
						SELECT $1::uuid,$2::uuid,$3,n,line::jsonb || jsonb_build_object('workspace_id',$1::text,'site_id',$2::text) FROM site_import_rows ORDER BY n`,
						[plan.workspaceId, siteId, table.name],
					);
				}
				await client.query("TRUNCATE site_import_rows");
				continue;
			}
			if (here.partitionedBy && here.module) {
				const months = await client.query<{ month: Date }>(
					`SELECT DISTINCT date_trunc('month', (line::json ->> ${literal(here.partitionedBy)})::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month FROM site_import_rows`,
				);
				await context.preparePartitions(
					client,
					here.module,
					here.table,
					months.rows.map((row) => new Date(row.month)),
				);
			}
			if (here.name === "public.site_domains")
				await loadPausedDomains(client, { workspaceId: plan.workspaceId, siteId }, context.now());
			else
				await loadRows(client, here, table.columns, { workspaceId: plan.workspaceId, siteId, importer: plan.importer });
			await client.query("TRUNCATE site_import_rows");
			await context.progress("tables", index + 1, manifest.tables.length);
		}

		// The stored files: each copied under its new key, into the storage new files go to now.
		const index = await reader.filesIndex(manifest);
		await checkUploadReferences(client, siteId);
		await checkFileReferences(client, manifest, index, ids, siteId);
		const quota = await client.query<{ quota: string; used: string }>(
			`SELECT q.quota_bytes::text AS quota, (SELECT coalesce(sum(f.size_bytes), 0)::text FROM
    (SELECT DISTINCT ON (storage, key) size_bytes FROM public.media_files WHERE workspace_id = $1) f) AS used
    FROM public.media_quotas q WHERE q.workspace_id = $1`,
			[plan.workspaceId],
		);
		const room = quota.rows[0];
		if (room && Number(room.used) > Number(room.quota))
			throw new MediaQuotaFullError(Number(room.used), Number(room.quota));
		const backend = await context.storage.current();
		const oldFolder = `${manifest.site.workspaceId}/${manifest.site.id}/`;
		let files = 0;
		let bytes = 0;
		const seen = new Set<string>();
		for (;;) {
			const entry = await reader.maybeNext();
			if (!entry) break;
			if (!entry.path.startsWith(FILES_FOLDER))
				throw new ArchiveRefusedError("damaged", `${entry.path} isn't a file of the Site.`);
			const key = entry.path.slice(FILES_FOLDER.length);
			const known = index.get(key);
			if (!known || !key.startsWith(oldFolder) || seen.has(key)) {
				throw new ArchiveRefusedError("damaged", `${entry.path} isn't one of the files the manifest lists.`);
			}
			seen.add(key);
			if (entry.size !== known.size) throw new ArchiveRefusedError("damaged", "A stored file has the wrong size.");
			const data = reader.verifiedBytes(entry, known.sha256);
			const newKey = ids.key(key);
			await backend.putStream(newKey, data, "application/octet-stream");
			copied.push({ backend, key: newKey });
			files++;
			bytes += entry.size;
			if (files % 50 === 0 || files === index.size) await context.progress("files", files, index.size);
		}
		if (files !== index.size || bytes !== manifest.files.bytes) {
			throw new ArchiveRefusedError(
				"damaged",
				`The archive holds ${files} files, not the ${index.size} the manifest lists.`,
			);
		}

		const published = await asDrafts(client, target, siteId, context.now());
		await client.query("UPDATE public.media_files SET storage = $2 WHERE site_id = $1", [siteId, backend.kind]);
		await client.query(
			`UPDATE public.form_uploads SET storage = $2,
   key = workspace_id::text || '/' || site_id::text || '/form-uploads/' || id::text WHERE site_id = $1`,
			[siteId, backend.kind],
		);
		if (target.has("public.libraries")) {
			await client.query("UPDATE public.libraries SET storage = $2 WHERE site_id = $1 AND storage IS NOT NULL", [
				siteId,
				backend.kind,
			]);
		}
		const paused = await pausedDomains(client, siteId);
		await reopenScheduledReviews(client, target, siteId);
		const reportsPaused = await pauseReports(client, target, siteId);
		await stopImportRuns(client, target, siteId, context.now());

		// Secrets: carried under the passphrase and opened with its key, or dropped.
		let secrets: { name: string; value: string }[] = [];
		let secretsReport: SiteImportReport["secrets"];
		if (!manifest.secrets.carried || !bundle) {
			secretsReport = {
				set: [],
				dropped: manifest.secrets.names.map((name) => ids.secret(name)),
				reason: manifest.secrets.names.length ? "notCarried" : null,
			};
		} else if (!plan.secretsKey) {
			secretsReport = {
				set: [],
				dropped: manifest.secrets.names.map((name) => ids.secret(name)),
				reason: "noPassphrase",
			};
		} else {
			if (!(await keyOpens(plan.secretsKey, bundle.check))) throw new PassphraseWrongError();
			const { opened } = await openSecrets(plan.secretsKey, bundle);
			secrets = opened.map((secret) => ({ name: ids.secret(secret.name), value: secret.value }));
			const set = new Set(opened.map((secret) => secret.name));
			const dropped = manifest.secrets.names.filter((name) => !set.has(name));
			secretsReport = {
				set: secrets.map((secret) => secret.name),
				dropped: dropped.map((name) => ids.secret(name)),
				reason: dropped.length ? "unreadable" : null,
			};
		}
		const webhooksOff = await webhooksWithoutSecrets(
			client,
			target,
			siteId,
			new Set(secrets.map((secret) => secret.name)),
		);

		const members = await placeMembers(client, plan, siteId, persons, context.now());
		const media = await mediaToRedo(client, siteId);
		const modules: SiteImportReport["modules"] = [];
		for (const module of manifest.modules) {
			modules.push({
				id: module.id,
				version: module.version,
				status: await context.moduleStatus(module.id),
				keptAside: keptAside.has(module.id),
			});
		}
		const report: SiteImportReport = {
			from: {
				name: manifest.site.name,
				slug: manifest.site.slug,
				webcraft: manifest.webcraft.version,
				exportedAt: manifest.createdAt,
				upgraded: steps.length > 0 || manifest.webcraft.version !== manifest.webcraft.takenBy,
			},
			counts: manifest.counts,
			files: { count: files, bytes },
			drafts: { published },
			reassigned: persons.unmatched
				.filter((person) => person.referenced)
				.map((person) => ({ name: person.name, email: person.email, was: person.was })),
			matched: members.matched,
			staff: persons.staff,
			invited: members.invited,
			paused,
			secrets: secretsReport,
			webhooksOff,
			reportsPaused,
			dropped: manifest.leftOut,
			modules,
		};
		const imported = { siteId, report, secrets, media };
		await context.finish(client, imported);
		await client.query("COMMIT");
		open = false;
		return imported;
	} catch (error) {
		if (open) await client.query("ROLLBACK").catch(() => {});
		for (const file of copied) await file.backend.delete(file.key).catch(() => {});
		throw error;
	} finally {
		client.release();
		await reader.close();
	}
}

/** Read file references even when the receiving Module is missing and its rows are kept aside. */
async function stageUploadReferences(client: pg.ClientBase) {
	try {
		await client.query(`INSERT INTO site_import_upload_refs (id, submission_id, form_id, field_key, name, content_type, size)
   SELECT (f->>'uploadId')::uuid, (r.line::jsonb->>'id')::uuid, (r.line::jsonb->>'form_id')::uuid,
    field->>'key', f->>'name', f->>'contentType', (f->>'size')::bigint
   FROM site_import_rows r, LATERAL jsonb_array_elements(r.line::jsonb->'values') field,
    LATERAL jsonb_array_elements(CASE WHEN field->>'type' = 'file' AND jsonb_typeof(field->'value') = 'array'
     THEN field->'value' ELSE '[]'::jsonb END) f
   WHERE f->>'uploadId' IS NOT NULL`);
	} catch (error) {
		const code = (error as { code?: string }).code ?? "";
		if (code.startsWith("22") || code.startsWith("23"))
			throw new ArchiveRefusedError("damaged", "A Submission has invalid or repeated private-file references.");
		throw error;
	}
}

/** A private file has one matching claim and a canonical private key, never a public Media key. */
async function checkUploadReferences(client: pg.ClientBase, siteId: string) {
	const invalid = await client.query(
		`SELECT 1 FROM
   (SELECT * FROM public.form_uploads WHERE site_id = $1) u
   FULL JOIN site_import_upload_refs r ON r.id = u.id
   WHERE u.id IS NULL OR r.id IS NULL OR u.submission_id IS DISTINCT FROM r.submission_id
    OR u.form_id IS DISTINCT FROM r.form_id OR u.field_key IS DISTINCT FROM r.field_key
    OR u.size IS DISTINCT FROM r.size OR u.name IS DISTINCT FROM r.name
    OR u.content_type IS DISTINCT FROM r.content_type
    OR u.key IS DISTINCT FROM u.workspace_id::text || '/' || u.site_id::text || '/form-uploads/' || u.id::text
   LIMIT 1`,
		[siteId],
	);
	if (invalid.rowCount)
		throw new ArchiveRefusedError("damaged", "Private Form uploads do not match their Submissions.");
}

/** Stored rows must name exactly the files supplied, inside this Site, with their actual sizes. */
async function checkFileReferences(
	client: pg.ClientBase,
	manifest: SiteExportManifest,
	index: ReadonlyMap<string, { size: number; sha256: string }>,
	ids: IdMap,
	siteId: string,
) {
	const supplied = new Map<string, number>();
	for (const [key, file] of index) {
		try {
			keyParts(key);
		} catch {
			throw new ArchiveRefusedError("damaged", "Invalid stored-file path.");
		}
		if (!key.startsWith(`${manifest.site.workspaceId}/${manifest.site.id}/`)) {
			throw new ArchiveRefusedError("damaged", "A stored file belongs to another Site.");
		}
		supplied.set(ids.key(key), file.size);
	}
	const { rows } = await client.query<{ key: string; size: string; media: boolean }>(
		`SELECT key, size_bytes::text AS size, true AS media FROM public.media_files WHERE site_id = $1
   UNION ALL SELECT storage_key AS key, size::text, false AS media FROM public.libraries WHERE site_id = $1
   UNION ALL SELECT key, size::text, false AS media FROM public.form_uploads WHERE site_id = $1`,
		[siteId],
	);
	const seen = new Set<string>();
	const media = new Set<string>();
	let mediaBytes = 0;
	for (const row of rows) {
		if (supplied.get(row.key) !== Number(row.size)) {
			throw new ArchiveRefusedError("damaged", "A stored-file reference is missing or has the wrong size.");
		}
		seen.add(row.key);
		if (row.media && !media.has(row.key)) {
			media.add(row.key);
			mediaBytes += Number(row.size);
		}
	}
	if (seen.size !== supplied.size || mediaBytes !== manifest.files.mediaBytes) {
		throw new ArchiveRefusedError("damaged", "The stored-file inventory does not match the Site's rows.");
	}
}

/** The passphrase given doesn't open the export's secrets. */
export class PassphraseWrongError extends Error {
	override name = "PassphraseWrongError";
	constructor() {
		super("That isn't the passphrase the Site was exported with.");
	}
}

/** The slug is taken on this Install, or isn't one a Site may have. */
export class SiteImportSlugError extends Error {
	override name = "SiteImportSlugError";
}

/** Reads an archive's files in order, checking each against the manifest. */
class ArchiveReader {
	private readonly entries: AsyncIterator<TarEntry>;
	constructor(archive: AsyncIterable<Uint8Array>) {
		this.entries = readTar(archive)[Symbol.asyncIterator]();
	}

	async maybeNext(): Promise<TarEntry | null> {
		const next = await this.entries.next();
		return next.done ? null : next.value;
	}

	async next(path: string): Promise<TarEntry> {
		const entry = await this.maybeNext().catch((error: unknown) => {
			throw new ArchiveRefusedError(
				"damaged",
				`The archive is damaged: ${error instanceof Error ? error.message : error}`,
			);
		});
		if (!entry || entry.path !== path) {
			throw new ArchiveRefusedError("damaged", `The archive should hold ${path} next, as its manifest lists.`);
		}
		return entry;
	}

	async manifest(upgrades: readonly FormatUpgrade[] = FORMAT_UPGRADES) {
		let entry: TarEntry | null;
		try {
			entry = await this.maybeNext();
		} catch {
			throw new ArchiveRefusedError("not-an-export", "The file isn't a WebCraft Site export.");
		}
		if (!entry || entry.path !== MANIFEST_FILE || entry.size > MANIFEST_MAX_BYTES) {
			throw new ArchiveRefusedError("not-an-export", "The file isn't a WebCraft Site export.");
		}
		return readManifest(new TextDecoder().decode(await collect(entry.body)), upgrades);
	}

	async secrets(manifest: SiteExportManifest): Promise<SecretsBundle> {
		const entry = await this.next(SECRETS_FILE);
		if (entry.size > SECRETS_MAX_BYTES)
			throw new ArchiveRefusedError("damaged", "The export's secrets file is too large.");
		const bytes = await this.bytes(entry, manifest.secrets.sha256 ?? "");
		const parsed = secretsBundleSchema.safeParse(safeJson(new TextDecoder().decode(bytes)));
		if (!parsed.success)
			throw new ArchiveRefusedError("damaged", "The export's secrets file isn't one WebCraft writes.");
		const names = new Set(manifest.secrets.names);
		const seen = new Set<string>();
		for (const secret of parsed.data.secrets) {
			if (!names.has(secret.name) || seen.has(secret.name))
				throw new ArchiveRefusedError("damaged", "The secret inventory does not match the manifest.");
			seen.add(secret.name);
		}
		return parsed.data;
	}

	async people(manifest: SiteExportManifest): Promise<ExportedPerson[]> {
		const entry = await this.next(PEOPLE_FILE);
		const lines = await this.gzipLines(entry, manifest.people.sha256);
		if (lines.length !== manifest.people.rows)
			throw new ArchiveRefusedError("damaged", "The export's people file is incomplete.");
		const membership = z.object({ role: z.enum(["owner", "editor", "author"]) }).nullable();
		const schema = z.object({
			id: z.uuid().nullable(),
			name: z.string().nullable(),
			email: z.email(),
			installRole: z.enum(["staff", "superadmin"]).nullable(),
			member: membership,
			invite: membership,
			referenced: z.boolean(),
		});
		const seen = new Set([manifest.site.id, manifest.site.workspaceId]);
		return lines.map((line) => {
			const parsed = schema.safeParse(safeJson(line));
			if (!parsed.success || (parsed.data.id !== null && seen.has(parsed.data.id))) {
				throw new ArchiveRefusedError("damaged", "The people file contains invalid or repeated identities.");
			}
			if (parsed.data.id) seen.add(parsed.data.id);
			return parsed.data;
		});
	}

	async filesIndex(manifest: SiteExportManifest): Promise<Map<string, { size: number; sha256: string }>> {
		const entry = await this.next(FILES_INDEX);
		const lines = await this.gzipLines(entry, manifest.files.sha256);
		const index = new Map<string, { size: number; sha256: string }>();
		for (const line of lines) {
			const file = safeJson(line) as { key?: unknown; size?: unknown; sha256?: unknown };
			if (
				typeof file.key !== "string" ||
				typeof file.size !== "number" ||
				!Number.isSafeInteger(file.size) ||
				file.size < 0 ||
				typeof file.sha256 !== "string" ||
				!/^[0-9a-f]{64}$/.test(file.sha256) ||
				index.has(file.key)
			) {
				throw new ArchiveRefusedError("damaged", "The export's list of files isn't one WebCraft writes.");
			}
			index.set(file.key, { size: file.size, sha256: file.sha256 });
		}
		if (index.size !== manifest.files.rows)
			throw new ArchiveRefusedError("damaged", "The export's list of files is incomplete.");
		return index;
	}

	/** An entry's bytes, refused when they don't have the checksum. */
	async bytes(entry: TarEntry, sha256: string): Promise<Uint8Array> {
		const data = await collect(entry.body);
		if (createHash("sha256").update(data).digest("hex") !== sha256) {
			throw new ArchiveRefusedError("damaged", `${entry.path} doesn't have the checksum the manifest gives.`);
		}
		return data;
	}

	/** Checks a stored file while storage consumes it; storage commits only at the end. */
	async *verifiedBytes(entry: TarEntry, sha256: string): AsyncGenerator<Uint8Array> {
		const hash = createHash("sha256");
		for await (const chunk of entry.body) {
			hash.update(chunk);
			yield chunk;
		}
		if (hash.digest("hex") !== sha256)
			throw new ArchiveRefusedError("damaged", "A stored-file checksum does not match.");
	}

	/** Reads an entry to its end, refused when it doesn't have the checksum. */
	async verify(entry: TarEntry, sha256: string): Promise<void> {
		const hash = createHash("sha256");
		for await (const chunk of entry.body) hash.update(chunk);
		if (hash.digest("hex") !== sha256) {
			throw new ArchiveRefusedError("damaged", `${entry.path} doesn't have the checksum the manifest gives.`);
		}
	}

	private async gzipLines(entry: TarEntry, sha256: string): Promise<string[]> {
		const hash = createHash("sha256");
		async function* hashed() {
			for await (const chunk of entry.body) {
				hash.update(chunk);
				yield chunk;
			}
		}
		let bytes = 0;
		const lines: string[] = [];
		try {
			for await (const line of jsonLines(Readable.from(hashed()))) {
				bytes += Buffer.byteLength(line) + 1;
				if (bytes > 16 * 1024 * 1024) throw new ArchiveRefusedError("damaged", "The export metadata exceeds 16 MiB.");
				lines.push(line);
			}
		} catch (error) {
			if (isZlibError(error)) throw new ArchiveRefusedError("damaged", `${entry.path} doesn't unzip: it is damaged.`);
			throw error;
		}
		if (hash.digest("hex") !== sha256)
			throw new ArchiveRefusedError("damaged", "The export metadata checksum does not match.");
		return lines;
	}

	async close(): Promise<void> {
		await this.entries.return?.();
	}
}

/**
 * Streams a table's rows from the archive into the import's staging table: unzipped, ids replaced in
 * each line's text, and copied in with COPY (one statement, a buffer at a time). Answers the count.
 */
async function stageRows(
	client: pg.ClientBase,
	entry: TarEntry,
	sha256: string,
	steps: readonly FormatUpgrade[],
	table: string,
): Promise<number> {
	const hash = createHash("sha256");
	async function* hashed() {
		for await (const chunk of entry.body) {
			hash.update(chunk);
			yield chunk;
		}
	}
	let rows = 0;
	const rowSteps = steps.filter((step) => step.row);
	async function* copied() {
		for await (const line of jsonLines(Readable.from(hashed()))) {
			if (line === "") continue;
			let row = safeJson(line);
			if (!row || typeof row !== "object" || Array.isArray(row))
				throw new ArchiveRefusedError("damaged", "A table row must be an object.");
			if (rowSteps.length > 0) {
				for (const step of rowSteps) row = step.row?.(table, row as Record<string, unknown>) ?? row;
			}
			const text = JSON.stringify(row);
			rows++;
			// COPY's text format: backslashes doubled; a JSON line holds no raw tab or line break.
			yield `${table}\t${text.replaceAll("\\", "\\\\")}\n`;
		}
	}
	const copy = client.query(copyFrom("COPY site_import_source_rows (table_name, line) FROM STDIN"));
	try {
		await pipeline(Readable.from(copied()), copy);
	} catch (error) {
		// Bytes that don't unzip were changed on the way: the file is damaged, not WebCraft.
		if (isZlibError(error)) throw new ArchiveRefusedError("damaged", `${entry.path} doesn't unzip: it is damaged.`);
		throw error;
	}
	if (hash.digest("hex") !== sha256) {
		throw new ArchiveRefusedError("damaged", `${entry.path} doesn't have the checksum the manifest gives.`);
	}
	return rows;
}

/**
 * Loads the staged rows into their table in one statement (so rows pointing at rows of the same table
 * load together), each row read by Postgres into the table's own types. The new Site's Workspace and
 * Site always win over what a row says; a column the export doesn't have takes its default (an export
 * an older WebCraft wrote); a column filled from a sequence takes a new value, in the rows' order;
 * people without an account here become the importing person, and rows of tables left out are named
 * no more.
 */
async function loadRows(
	client: pg.ClientBase,
	table: SiteTable,
	exported: readonly string[],
	place: { workspaceId: string; siteId: string; importer: string | null },
): Promise<void> {
	const has = new Set(exported);
	const columns = table.columns.filter(
		(column) =>
			!table.sequenced.includes(column) && (has.has(column) || column === "workspace_id" || column === "site_id"),
	);
	const importer = place.importer ? `${literal(place.importer)}::uuid` : "NULL";
	const person = (column: string) =>
		`CASE WHEN x.${ident(column)} IS NULL THEN NULL ELSE COALESCE((SELECT p.id FROM public.people p WHERE p.id = x.${ident(column)}), ${importer}) END`;
	const values = columns.map((column) => {
		if (column === "workspace_id") return `${literal(place.workspaceId)}::uuid`;
		if (column === "site_id") return `${literal(place.siteId)}::uuid`;
		if (table.leftOutColumns.includes(column)) return "NULL";
		// A language's own domain is unique on the Install: it comes paused, as the Site's domains do.
		if (table.name === "public.site_languages" && column === "domain") return "NULL";
		if (table.name === "public.audit_log" && (column === "person_id" || column === "impersonator_id")) {
			// The Audit log keeps who did what: someone without an account here is named in the entry instead.
			return `(SELECT p.id FROM public.people p WHERE p.id = x.${ident(column)})`;
		}
		if (table.name === "public.audit_log" && column === "details") {
			return `CASE WHEN x.person_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.people p WHERE p.id = x.person_id)
				THEN coalesce(x.details, '{}'::jsonb) || jsonb_build_object('importedPerson',
					(SELECT jsonb_build_object('name', i.name, 'email', i.email) FROM site_import_people i WHERE i.id = x.person_id))
				ELSE x.details END`;
		}
		const value = table.personColumns.includes(column) ? person(column) : `x.${ident(column)}`;
		// A row an older WebCraft wrote may not have the column yet: it takes its default, as a new row would.
		const fallback = table.defaults[column];
		return fallback ? `CASE WHEN j.row ? ${literal(column)} THEN ${value} ELSE ${fallback} END` : value;
	});
	await client.query(
		`INSERT INTO ${quoted(table)} (${columns.map(ident).join(", ")})
			SELECT ${values.join(", ")} FROM site_import_rows r, LATERAL (SELECT r.line::jsonb AS row) j,
				json_populate_record(NULL::${quoted(table)}, r.line::json) x
			ORDER BY r.n`,
	);
}

/** The new Site's row: its own settings from the export, the name and slug chosen, nothing published yet. */
async function insertSite(
	client: pg.ClientBase,
	manifest: SiteExportManifest,
	plan: ImportPlan,
	siteId: string,
	now: Date,
) {
	const taken = await client.query("SELECT 1 FROM public.sites WHERE slug = $1", [plan.slug]);
	if (taken.rowCount) throw new SiteImportSlugError("Another Site of this Install has that slug.");
	const columns = await client.query<{ name: string }>(
		`SELECT a.attname::text AS name FROM pg_attribute a WHERE a.attrelid = 'public.sites'::regclass
			AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' AND a.attidentity = ''`,
	);
	// What the new Site never takes from the old one: a password (it never moves), and what the
	// Install keeps track of itself (its page cache, its search index).
	const fresh = new Set([
		"staging_password_hash",
		"staging_password_changed_at",
		"page_cache_generation",
		"search_index_version",
		"search_rebuild_claimed_at",
	]);
	const settings = manifest.site.settings;
	const row: Record<string, unknown> = {};
	for (const { name } of columns.rows) {
		if (name in settings && !fresh.has(name) && name !== "created_at") row[name] = settings[name];
	}
	Object.assign(row, { id: siteId, workspace_id: plan.workspaceId, name: plan.name, slug: plan.slug });
	const names = Object.keys(row);
	await client.query(
		`INSERT INTO public.sites (${names.map(ident).join(", ")}, created_at)
			SELECT ${names.map((name) => `x.${ident(name)}`).join(", ")}, $2 FROM json_populate_record(NULL::public.sites, $1::json) x`,
		[JSON.stringify(row), now],
	);
}

/** Content as Drafts: every published version becomes the Draft it was (when the Draft didn't differ) and goes. */
async function asDrafts(
	client: pg.ClientBase,
	target: ReadonlyMap<string, SiteTable>,
	siteId: string,
	now: Date,
): Promise<number> {
	let published = 0;
	for (const table of target.values()) {
		if (table.schema !== "public") continue;
		const has = (column: string) => table.columns.includes(column);
		const pairs: [string, string][] = [];
		if (has("draft") && has("published")) pairs.push(["draft", "published"]);
		if (has("emails_draft") && has("emails_published")) pairs.push(["emails_draft", "emails_published"]);
		if (pairs.length === 0) continue;
		const sets: string[] = [];
		const kinds: Record<string, string> = {
			entries: "entry",
			templates: "template",
			components: "component",
			loops: "loop",
			filters: "filter",
			scripts: "script",
			forms: "form",
			globals: "globals",
			consent_banners: "consentBanner",
			design_systems: "designSystem",
		};
		for (const [draft, live] of pairs) {
			const kind = live === "emails_published" ? "formEmails" : kinds[table.table];
			if (kind) {
				const item = ["globals", "consentBanner", "designSystem"].includes(kind) ? "NULL::uuid" : "t.id";
				const time =
					live === "emails_published"
						? "emails_last_published_at"
						: has("published_at")
							? "published_at"
							: "last_published_at";
				const at = has(time) ? `coalesce(t.${ident(time)}, $3::timestamptz)` : "$3::timestamptz";
				// Revisions may have been disabled or pruned at the source. Never lose the former live version.
				await client.query(
					`INSERT INTO public.revisions (workspace_id, site_id, item_kind, item_id, content, published_at, via)
     SELECT t.workspace_id, t.site_id, $2, ${item}, to_jsonb(t.${ident(live)}), ${at}, '{"kind":"command","name":"site import"}'::jsonb
     FROM ${quoted(table)} t WHERE t.site_id = $1 AND t.${ident(live)} IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.revisions r WHERE r.site_id = t.site_id AND r.item_kind = $2
       AND r.item_id IS NOT DISTINCT FROM ${item} AND r.content = to_jsonb(t.${ident(live)}))`,
					[siteId, kind, now],
				);
			}
			sets.push(`${ident(draft)} = COALESCE(${ident(draft)}, ${ident(live)})`, `${ident(live)} = NULL`);
		}
		if (has("draft_hash") && has("published_hash")) {
			sets.push("draft_hash = COALESCE(draft_hash, published_hash)", "published_hash = NULL");
		}
		for (const column of ["published_at", "last_published_at", "unpublished_at", "emails_last_published_at"]) {
			if (has(column)) sets.push(`${ident(column)} = NULL`);
		}
		const counted = await client.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM ${quoted(table)} WHERE site_id = $1 AND (${pairs.map(([, live]) => `${ident(live)} IS NOT NULL`).join(" OR ")})`,
			[siteId],
		);
		published += Number(counted.rows[0]?.count ?? 0);
		await client.query(`UPDATE ${quoted(table)} SET ${sets.join(", ")} WHERE site_id = $1`, [siteId]);
	}
	return published;
}

/**
 * A Site's domains arrive paused (ADR 0033): kept apart, off the domain list (where a name is unique on
 * the Install, and the Site they came from may still have them), until Staff switch each on.
 */
async function loadPausedDomains(client: pg.ClientBase, place: { workspaceId: string; siteId: string }, now: Date) {
	await client.query(
		`INSERT INTO public.paused_domains (workspace_id, site_id, name, role, language, created_at)
			SELECT $1, $2, x.name, x.role, x.language, $3
			FROM site_import_rows r, json_populate_record(NULL::public.site_domains, r.line::json) x ORDER BY r.n`,
		[place.workspaceId, place.siteId, now],
	);
}

/** The domains that came paused (with any the Site had paused already: it was imported before). */
async function pausedDomains(client: pg.ClientBase, siteId: string): Promise<SiteImportReport["paused"]> {
	const { rows } = await client.query<{ name: string; role: string; language: string | null }>(
		"SELECT name, role, language FROM public.paused_domains WHERE site_id = $1 ORDER BY role, name",
		[siteId],
	);
	return rows;
}

/** A Review its dropped Scheduled publish ended goes back In review, as when a Scheduled publish is removed. */
async function reopenScheduledReviews(client: pg.ClientBase, target: ReadonlyMap<string, SiteTable>, siteId: string) {
	if (!target.has("public.reviews")) return 0;
	const reopened = await client.query(
		`UPDATE public.reviews r SET status = 'inReview', decided_by = NULL, decided_via = NULL, decided_at = NULL,
				scheduled_at = NULL, schedule_id = NULL
			WHERE r.site_id = $1 AND r.status = 'scheduled' AND NOT EXISTS (
				SELECT 1 FROM public.reviews o WHERE o.site_id = r.site_id AND o.status = 'inReview'
					AND o.item_kind = r.item_kind AND o.entry_id IS NOT DISTINCT FROM r.entry_id)`,
		[siteId],
	);
	return reopened.rowCount ?? 0;
}

/** Reports arrive paused: they would otherwise start emailing a Site that isn't live yet on their schedule. */
async function pauseReports(client: pg.ClientBase, target: ReadonlyMap<string, SiteTable>, siteId: string) {
	if (!target.has("public.reports")) return [];
	const { rows } = await client.query<{ name: string }>(
		"UPDATE public.reports SET active = false, next_run_at = NULL WHERE site_id = $1 AND active RETURNING name",
		[siteId],
	);
	return rows.map((row) => row.name).sort();
}

/** An Import run under way on the Site it came from stops: its file isn't part of the export. */
async function stopImportRuns(
	client: pg.ClientBase,
	target: ReadonlyMap<string, SiteTable>,
	siteId: string,
	now: Date,
) {
	if (!target.has("public.import_runs")) return 0;
	const result = await client.query(
		`UPDATE public.import_runs SET status = 'stopped', finished_at = COALESCE(finished_at, $2)
			WHERE site_id = $1 AND status IN ('waiting', 'running')`,
		[siteId, now],
	);
	return result.rowCount ?? 0;
}

/** Webhooks whose signing secret didn't come are switched off: they couldn't sign a delivery. */
async function webhooksWithoutSecrets(
	client: pg.ClientBase,
	target: ReadonlyMap<string, SiteTable>,
	siteId: string,
	secrets: ReadonlySet<string>,
): Promise<string[]> {
	if (!target.has("public.webhooks")) return [];
	const { rows } = await client.query<{ id: string; name: string; enabled: boolean }>(
		"SELECT id::text, name, enabled FROM public.webhooks WHERE site_id = $1",
		[siteId],
	);
	const off: string[] = [];
	for (const row of rows) {
		if (secrets.has(`webhook:${row.id}:signing`)) continue;
		if (row.enabled) await client.query("UPDATE public.webhooks SET enabled = false WHERE id = $1", [row.id]);
		off.push(row.name);
	}
	return off.sort();
}

/** The Media the new Site's worker cleans or makes variants of, as after a restore. */
async function mediaToRedo(client: pg.ClientBase, siteId: string): Promise<ImportedSite["media"]> {
	const variants = await client.query<{ media_id: string }>(
		`SELECT DISTINCT f.media_id::text FROM public.media_files f
			WHERE f.site_id = $1 AND f.role = 'original' AND f.retired_at IS NULL AND f.format <> 'svg' AND f.width IS NOT NULL`,
		[siteId],
	);
	const uploads = await client.query<{ media_id: string }>(
		"SELECT DISTINCT media_id::text FROM public.media_files WHERE site_id = $1 AND role = 'upload'",
		[siteId],
	);
	return { variants: variants.rows.map((row) => row.media_id), process: uploads.rows.map((row) => row.media_id) };
}

type MatchedPeople = {
	/** Old person id → their account here. */
	ids: [string, string][];
	/** People without an account here (by their old id). */
	unmatched: { id: string; name: string | null; email: string; was: string | null; referenced: boolean }[];
	staff: { email: string; name: string | null }[];
	/** Members and invites to place: each with their account here, if any. */
	toPlace: {
		email: string;
		name: string | null;
		role: string;
		account: { id: string; installRole: string | null } | null;
	}[];
};

/** Matches the export's people to accounts here, by email. */
async function matchPeople(client: pg.ClientBase, people: ExportedPerson[]): Promise<MatchedPeople> {
	const emails = [...new Set(people.map((person) => person.email.toLowerCase()))];
	const { rows } = await client.query<{ id: string; email: string; role: string | null }>(
		`SELECT p.id::text, lower(p.email) AS email, r.role FROM public.people p
			LEFT JOIN public.install_roles r ON r.person_id = p.id WHERE lower(p.email) = ANY($1::text[])`,
		[emails],
	);
	const accounts = new Map(rows.map((row) => [row.email, { id: row.id, installRole: row.role }]));
	const matched: MatchedPeople = { ids: [], unmatched: [], staff: [], toPlace: [] };
	for (const person of people) {
		const account = accounts.get(person.email.toLowerCase()) ?? null;
		if (person.id) {
			if (account) {
				matched.ids.push([person.id, account.id]);
				if (account.installRole) matched.staff.push({ email: person.email, name: person.name });
			} else {
				matched.unmatched.push({
					id: person.id,
					name: person.name,
					email: person.email,
					was: person.installRole ?? person.member?.role ?? null,
					referenced: person.referenced,
				});
			}
		}
		const role = person.member?.role ?? person.invite?.role;
		if (role && !person.installRole) {
			matched.toPlace.push({ email: person.email.toLowerCase(), name: person.name, role, account });
		}
	}
	return matched;
}

/**
 * Members and invites of the Site it came from: a Member of this Workspace keeps their role and reaches
 * the new Site; anyone else (an account elsewhere on the Install, or no account) gets a pending
 * invitation to the new Site with the role they had, sent only when someone chooses to.
 */
async function placeMembers(
	client: pg.ClientBase,
	plan: ImportPlan,
	siteId: string,
	people: MatchedPeople,
	now: Date,
): Promise<Pick<SiteImportReport, "matched" | "invited">> {
	const matched: SiteImportReport["matched"] = [];
	const invited: SiteImportReport["invited"] = [];
	for (const person of people.toPlace) {
		if (person.account?.installRole) continue;
		if (person.account) {
			const membership = await client.query<{ id: string; role: string; all_sites: boolean }>(
				"SELECT id::text, role, all_sites FROM public.memberships WHERE workspace_id = $1 AND person_id = $2",
				[plan.workspaceId, person.account.id],
			);
			const [member] = membership.rows;
			if (member) {
				if (!member.all_sites) {
					await client.query(
						"INSERT INTO public.membership_sites (membership_id, workspace_id, site_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
						[member.id, plan.workspaceId, siteId],
					);
				}
				matched.push({ email: person.email, name: person.name, role: member.role });
				continue;
			}
		}
		const tokenHash = createHash("sha256")
			.update(crypto.getRandomValues(new Uint8Array(32)))
			.digest("hex");
		const created = await client.query<{ id: string; all_sites: boolean; role: string; inserted: boolean }>(
			`INSERT INTO public.invites (email, token_hash, role, all_sites, workspace_id, invited_by, created_at, expires_at)
				VALUES ($1, $2, $3, false, $4, $5, $6, $7)
				ON CONFLICT (email, workspace_id) DO UPDATE SET email = EXCLUDED.email
				RETURNING id::text, all_sites, role, (xmax = 0) AS inserted`,
			[
				person.email,
				`unsent:${tokenHash}`,
				person.role,
				plan.workspaceId,
				plan.importer,
				now,
				new Date(now.getTime() + INVITE_LIFETIME_MS),
			],
		);
		const [invite] = created.rows;
		if (!invite) continue;
		if (!invite.all_sites) {
			await client.query(
				"INSERT INTO public.invite_sites (invite_id, workspace_id, site_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
				[invite.id, plan.workspaceId, siteId],
			);
		}
		invited.push({ email: person.email, role: invite.role, inviteId: invite.id, sent: false });
	}
	return { matched, invited };
}

/** An error zlib raised reading compressed bytes (`Z_DATA_ERROR`, `Z_BUF_ERROR`, …). */
function isZlibError(error: unknown): boolean {
	return typeof (error as { code?: unknown })?.code === "string" && (error as { code: string }).code.startsWith("Z_");
}

/** Splits a gzip-compressed stream into its lines. */
async function* jsonLines(source: Readable): AsyncGenerator<string> {
	const gunzip = createGunzip();
	const unzipped = source.pipe(gunzip);
	source.on("error", (error) => gunzip.destroy(error));
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const max = 16 * 1024 * 1024;
	let rest = "";
	let bytes = 0;
	try {
		for await (const chunk of unzipped as AsyncIterable<Buffer>) {
			let start = 0;
			for (;;) {
				const newline = chunk.indexOf(10, start);
				const end = newline === -1 ? chunk.length : newline;
				bytes += end - start;
				if (bytes > max) throw new ArchiveRefusedError("damaged", "A JSON row exceeds 16 MiB.");
				rest += decoder.decode(chunk.subarray(start, end), { stream: true });
				if (newline === -1) break;
				rest += decoder.decode();
				yield rest;
				rest = "";
				bytes = 0;
				start = newline + 1;
			}
		}
		rest += decoder.decode();
		if (rest !== "") yield rest;
	} catch (error) {
		if (isZlibError(error) || error instanceof TypeError)
			throw new ArchiveRefusedError("damaged", "The JSON Lines file is not valid UTF-8 gzip.");
		throw error;
	} finally {
		source.destroy();
		gunzip.destroy();
	}
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.length;
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

function safeJson(text: string): unknown {
	// Bound nesting before JSON.parse and recursive contract traversal, without interpreting strings.
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (const character of text) {
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
		} else if (character === '"') quoted = true;
		else if (character === "{" || character === "[") {
			if (++depth > 128) throw new ArchiveRefusedError("damaged", "A JSON row exceeds 128 nesting levels.");
		} else if (character === "}" || character === "]") depth--;
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new ArchiveRefusedError("damaged", "A line of the export isn't JSON.");
	}
}

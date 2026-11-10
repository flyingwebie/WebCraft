/**
 * Site export and Site import (ADR 0033, GLOSSARY.md): moving or copying one Site between Installs, or
 * within one, as one archive. Not a Backup (a whole Install) and not an Import (outside content into a
 * Site). See `docs/development.md` › "Site export and import".
 */
import { createHash } from "node:crypto";

import type { Database } from "@webcraft/db";
import { mediaQuotas, people, siteExports, siteImports, sites } from "@webcraft/db/schema";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import { isUuid } from "../ids.ts";
import {
	IMPORT_MAX_PARTS,
	IMPORT_PART_BYTES,
	IMPORT_PART_MIN_BYTES,
	partsHash,
	streamParts,
} from "../imports/uploads.ts";
import { defineJob, type JobQueue } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import type { Logger } from "../log.ts";
import { MediaQuotaFullError } from "../media/errors.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { mediaProcess, mediaVariants } from "../media/jobs.ts";
import { workspaceMediaBytes } from "../media/quota.ts";
import { type StorageKind, siteFolder } from "../media/storage.ts";
import type { ModuleHost } from "../modules/host.ts";
import type { PersonActor } from "../permissions/can.ts";
import { actingPerson, personIdOf } from "../permissions/can.ts";
import type { InstallSecrets } from "../secrets/index.ts";
import { reservedSlugs } from "../site-pages/addresses.ts";
import { socialCardsRender } from "../social-cards/jobs.ts";
import type { Access, DataLayer, SiteScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError, WorkspaceNotFoundError } from "../tenancy/errors.ts";
import type { MembersService } from "../tenancy/members.ts";
import { checkSlug, SITE_NAME_MAX_LENGTH, SlugTakenError } from "../tenancy/sites.ts";
import {
	SiteExportNotFoundError,
	SiteExportRunningError,
	SiteImportNotFoundError,
	SiteImportRefusedError,
	SiteImportStateError,
	SiteImportUploadRefusedError,
} from "./errors.ts";
import { type ExportSecrets, writeSiteExport } from "./export.ts";
import { ArchiveRefusedError, type SiteExportManifest } from "./format.ts";
import {
	type ImportReaderContext,
	importSite,
	type ModuleTransferStatus,
	PassphraseWrongError,
	readArchiveHead,
	type SiteImportReport,
	SiteImportSlugError,
} from "./import.ts";
import { ARCHIVE_PART_BYTES, removeParts, writeParts } from "./parts.ts";
import { type Kdf, kdfSchema, keyOpens, newKdf, passphraseKey } from "./passphrase.ts";

export * from "./errors.ts";
export { type ArchiveRefusalReason, ArchiveRefusedError, SITE_EXPORT_FORMAT_VERSION } from "./format.ts";
export { type ModuleTransferStatus, PassphraseWrongError, type SiteImportReport } from "./import.ts";
export { PASSPHRASE_MAX_LENGTH, PASSPHRASE_MIN_LENGTH } from "./passphrase.ts";
export { LEFT_OUT_TABLES } from "./tables.ts";

/** How long an export's download link works, after which its file is deleted. */
export const SITE_EXPORT_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** How long an upload waits for its next part, or to be started, before it is deleted. */
export const SITE_IMPORT_UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** How long a Site import report is kept after its import ends: as long as an Import report. */
export const SITE_IMPORT_REPORT_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
/** The largest archive an import takes: as many parts as an upload may have. */
export const SITE_IMPORT_MAX_BYTES = IMPORT_PART_BYTES * IMPORT_MAX_PARTS;

/** Where the admin downloads an export: `/api/site-exports/<site id>/<export id>?expires=…&signature=…`. */
export const SITE_EXPORT_DOWNLOAD_PREFIX = "/api/site-exports/";

/** Rows fetched at a time from each table, unless the Install says otherwise. */
const BATCH_ROWS = 500;

/** A Site export as the admin shows it. */
export type SiteExportView = {
	id: string;
	status: "waiting" | "running" | "done" | "failed" | "expired";
	withSecrets: boolean;
	withSubmissions: boolean;
	fileName: string;
	sizeBytes: number | null;
	progress: { step: string; done: number; total: number } | null;
	/** What went in and what was left out, once written. */
	summary: SiteExportSummary | null;
	failure: { reason: string } | null;
	requestedBy: { id: string; name: string } | null;
	createdAt: Date;
	finishedAt: Date | null;
	/** The signed download link while it works (24 hours after the export was written), only for people who may export the Site. */
	download: { url: string; expiresAt: Date } | null;
};

export type SiteExportSummary = {
	counts: Record<string, number>;
	files: { count: number; bytes: number };
	modules: { id: string; version: string }[];
	secrets: { carried: boolean; names: string[] };
	leftOut: SiteExportManifest["leftOut"];
};

/** A Site import as the admin shows it. */
export type SiteImportView = {
	id: string;
	status: "uploading" | "ready" | "refused" | "waiting" | "running" | "done" | "failed";
	fileName: string;
	sizeBytes: number;
	receivedBytes: number;
	partBytes: number;
	/** What the archive holds, once it came whole and was read. */
	archive: SiteImportArchive | null;
	refusal: { reason: string; message: string } | null;
	name: string | null;
	slug: string | null;
	/** The Site it made, while it exists. */
	site: { id: string; name: string } | null;
	progress: { step: string; done: number; total: number } | null;
	report: SiteImportReport | null;
	failure: { reason: string; message?: string } | null;
	startedBy: { id: string; name: string } | null;
	createdAt: Date;
	finishedAt: Date | null;
	expiresAt: Date;
};

export type SiteImportArchive = {
	site: { name: string; slug: string };
	webcraft: string;
	exportedAt: string;
	counts: Record<string, number>;
	files: { count: number; bytes: number; mediaBytes: number };
	secrets: { carried: boolean; names: string[] };
	modules: { id: string; version: string; status: ModuleTransferStatus }[];
	leftOut: SiteExportManifest["leftOut"];
};

export type SiteTransfer = {
	/** Starts exporting the Site (open it with `site.export`; a Sensitive action): the worker writes it. */
	startExport(
		scope: SiteScope,
		input: { passphrase: string | null; includeSubmissions?: boolean },
	): Promise<SiteExportView>;
	/** The Site's exports, newest first. */
	exports(scope: SiteScope): Promise<SiteExportView[]>;
	export(scope: SiteScope, exportId: string): Promise<SiteExportView>;
	/**
	 * An export's archive for its signed download link, to a person who may export its Site: the link
	 * must hold (its signature and expiry) and the export be written. Recorded in the Audit log.
	 */
	download(
		access: Access,
		link: { siteId: string; exportId: string; expires: string; signature: string },
	): Promise<{ body: ReadableStream<Uint8Array>; size: number; fileName: string }>;

	/** Starts uploading an archive in parts into a Workspace (open it with `site.import`). */
	startUpload(
		scope: WorkspaceScope,
		input: { fileName: string; size: number; partBytes?: number },
	): Promise<SiteImportView>;
	uploadPart(
		scope: WorkspaceScope,
		input: { importId: string; offset: number; sha256: string; data: Uint8Array },
	): Promise<SiteImportView>;
	/** Finishes an upload and reads its manifest: the import then waits to be started (or is refused, saying why). */
	finishUpload(scope: WorkspaceScope, input: { importId: string; sha256: string }): Promise<SiteImportView>;
	/** Starts the import into a new Site with this name and slug (a Sensitive action): the worker reads it in. */
	start(
		scope: WorkspaceScope,
		input: { importId: string; name: string; slug: string; passphrase: string | null },
	): Promise<SiteImportView>;
	imports(scope: WorkspaceScope): Promise<SiteImportView[]>;
	import(scope: WorkspaceScope, importId: string): Promise<SiteImportView>;
	/** Emails the pending invitations an import made (open the Workspace with `member.invite`). */
	sendInvitations(scope: WorkspaceScope, importId: string): Promise<SiteImportView>;

	/**
	 * `webcraft site export`: writes the Site's export at once, on the server, to where `write` puts it
	 * (a file or a folder). No person acts: it is recorded in the Audit log as done by the command.
	 */
	exportByCommand(input: {
		siteId: string;
		passphrase: string | null;
		includeSubmissions?: boolean;
		write(name: string, bytes: AsyncIterable<Uint8Array>): Promise<number>;
	}): Promise<{ name: string; sizeBytes: number; summary: SiteExportSummary }>;
	/**
	 * `webcraft site import`: imports a Site export from a file on the server into a Workspace as a new
	 * Site, at once, and keeps its Site import report (which the admin lists). What people without an
	 * account here did is attributed to nobody; recorded in the Audit log as done by the command.
	 */
	importByCommand(input: {
		workspaceId: string;
		fileName: string;
		sizeBytes: number;
		/** Opens the archive from its start (it is read twice: its head first). */
		open(): AsyncIterable<Uint8Array>;
		name: string;
		slug: string;
		passphrase: string | null;
	}): Promise<SiteImportView>;

	/** The worker's part. */
	runExport(payload: { siteId: string; exportId: string }): Promise<void>;
	runImport(payload: { workspaceId: string; importId: string }): Promise<void>;
	purge(): Promise<void>;
};

export type SiteTransferDeps = {
	database: Database;
	storage: InstallStorage;
	/** The Install's own secrets, where a passphrase's key waits for its job. */
	secrets: InstallSecrets;
	data: DataLayer;
	actors: { person(personId: string): Promise<PersonActor> };
	modules: ModuleHost;
	members: MembersService;
	jobs: JobQueue;
	clock: Clock;
	log: Logger;
	config: InstallConfig;
	/** The key download links are signed with (`siteExportLinkKey`). */
	linkKey: CryptoKey;
	/** Lower thresholds for tests: rows fetched at a time, and the size of an archive's parts. */
	tuning?: { batchRows?: number; partBytes?: number };
	/**
	 * A Site's secrets for the server commands, where no person (and so no Site scope) acts: listed,
	 * used inside a callback, and set, as a Site scope's are.
	 */
	commandSecrets: {
		names(site: { workspaceId: string; id: string }): Promise<string[]>;
		useWith<Result>(
			site: { workspaceId: string; id: string },
			name: string,
			use: (value: string) => Promise<Result>,
		): Promise<Result>;
		set(site: { workspaceId: string; id: string }, name: string, value: string): Promise<void>;
	};
};

const exportKey = (exportId: string) => ({ owner: { kind: "install" as const }, name: `siteExport:${exportId}:key` });
const importKey = (importId: string) => ({ owner: { kind: "install" as const }, name: `siteImport:${importId}:key` });

type ExportRow = typeof siteExports.$inferSelect;
type ImportRow = typeof siteImports.$inferSelect;

export function createSiteTransfer(deps: SiteTransferDeps): SiteTransfer {
	const { data, storage, clock, log } = deps;
	const batchRows = deps.tuning?.batchRows ?? BATCH_ROWS;
	const partBytes = deps.tuning?.partBytes ?? ARCHIVE_PART_BYTES;

	const signature = async (siteId: string, exportId: string, expires: number) => {
		const signed = await crypto.subtle.sign(
			"HMAC",
			deps.linkKey,
			new TextEncoder().encode(`site-export:${siteId}:${exportId}:${expires}`),
		);
		return Buffer.from(signed).toString("hex");
	};

	const names = async (ids: (string | null)[]) => {
		const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
		if (wanted.length === 0) return new Map<string, string>();
		const rows = await deps.database.db
			.select({ id: people.id, name: people.name })
			.from(people)
			.where(inArray(people.id, wanted));
		return new Map(rows.map((row) => [row.id, row.name]));
	};

	const exportView = async (row: ExportRow, who: Map<string, string>): Promise<SiteExportView> => {
		const live = row.status === "done" && row.expiresAt && row.expiresAt.getTime() > clock.now().getTime();
		let download: SiteExportView["download"] = null;
		if (live && row.expiresAt) {
			const expires = row.expiresAt.getTime();
			const url = new URL(`${SITE_EXPORT_DOWNLOAD_PREFIX}${row.siteId}/${row.id}`, deps.config.adminOrigin);
			url.searchParams.set("expires", String(expires));
			url.searchParams.set("signature", await signature(row.siteId, row.id, expires));
			download = { url: `${url.pathname}${url.search}`, expiresAt: row.expiresAt };
		}
		return {
			id: row.id,
			status: (row.status === "done" && !live ? "expired" : row.status) as SiteExportView["status"],
			withSecrets: row.withSecrets,
			withSubmissions: row.withSubmissions,
			fileName: row.fileName,
			sizeBytes: row.sizeBytes,
			progress: row.progress as SiteExportView["progress"],
			summary: row.summary as SiteExportSummary | null,
			failure: row.failure as SiteExportView["failure"],
			requestedBy: row.requestedBy ? { id: row.requestedBy, name: who.get(row.requestedBy) ?? "" } : null,
			createdAt: row.createdAt,
			finishedAt: row.finishedAt,
			download,
		};
	};

	const findExport = async (scope: SiteScope, exportId: string): Promise<ExportRow> => {
		const row = isUuid(exportId) ? await scope.first(siteExports, eq(siteExports.id, exportId)) : undefined;
		if (!row) throw new SiteExportNotFoundError();
		return row;
	};

	const importView = async (row: ImportRow): Promise<SiteImportView> => {
		const who = await names([row.startedBy]);
		const [made] = row.siteId
			? await deps.database.db
					.select({ id: sites.id, name: sites.name })
					.from(sites)
					.where(and(eq(sites.id, row.siteId), eq(sites.workspaceId, row.workspaceId)))
			: [];
		return {
			id: row.id,
			status: row.status as SiteImportView["status"],
			fileName: row.fileName,
			sizeBytes: row.sizeBytes,
			receivedBytes: row.receivedBytes,
			partBytes: row.partBytes,
			archive: row.manifest ? (row.manifest as { archive: SiteImportArchive }).archive : null,
			refusal: row.refusal as SiteImportView["refusal"],
			name: row.name,
			slug: row.slug,
			site: made ?? null,
			progress: row.progress as SiteImportView["progress"],
			report: row.report as SiteImportReport | null,
			failure: row.failure as SiteImportView["failure"],
			startedBy: row.startedBy ? { id: row.startedBy, name: who.get(row.startedBy) ?? "" } : null,
			createdAt: row.createdAt,
			finishedAt: row.finishedAt,
			expiresAt: row.expiresAt,
		};
	};

	const findImport = async (scope: WorkspaceScope, importId: string, lock = false): Promise<ImportRow> => {
		if (!isUuid(importId)) throw new SiteImportNotFoundError();
		const query = scope.db
			.select()
			.from(siteImports)
			.where(scope.where(siteImports, eq(siteImports.id, importId)));
		const [row] = lock ? await query.for("update") : await query;
		if (!row) throw new SiteImportNotFoundError();
		return row;
	};

	const moduleSchemas = () => {
		const map = new Map<string, { id: string; version: string }>();
		for (const module of deps.modules.registry.all()) {
			if (module.runnable) map.set(module.schema, { id: module.id, version: module.manifest.version });
		}
		return map;
	};

	/** Opens the person's own access again for a job: they may have lost it since they asked. */
	const accessOf = async (personId: string | null): Promise<Access | null> => {
		if (!personId) return null;
		try {
			return { actor: await deps.actors.person(personId), via: { kind: "admin" } };
		} catch {
			return null;
		}
	};

	const refusedBecauseOfAccess = (error: unknown) =>
		error instanceof PermissionDeniedError ||
		error instanceof SiteNotFoundError ||
		error instanceof WorkspaceNotFoundError;

	const readerContext = (progress: ImportReaderContext["progress"]): ImportReaderContext => ({
		database: deps.database,
		storage,
		moduleSchemas: new Map([...moduleSchemas()].map(([schema, module]) => [schema, module.id])),
		moduleStatus: (moduleId) => deps.modules.transferStatus(moduleId),
		preparePartitions: (client, moduleId, table, months) =>
			deps.modules.preparePartitions(client, moduleId, table, months),
		now: () => clock.now(),
		progress,
	});

	/** Rebuilds derived files for the new Site; card rendering reads only published Content. */
	const regenerateFiles = async (siteId: string, media: { process: string[]; variants: string[] }) => {
		for (const mediaId of media.process) await deps.jobs.send(mediaProcess, { siteId, mediaId });
		for (const mediaId of media.variants) await deps.jobs.send(mediaVariants, { siteId, mediaId });
		await deps.jobs.send(socialCardsRender, { siteId });
	};

	/** The details a `site.import` entry records. */
	const importDetails = (row: { id: string; name: string | null; slug: string | null }, report: SiteImportReport) => ({
		importId: row.id,
		name: row.name,
		slug: row.slug,
		from: { name: report.from.name, slug: report.from.slug, webcraft: report.from.webcraft },
		secrets: report.secrets.set.length,
		paused: report.paused.map((domain) => domain.name),
	});

	return {
		async startExport(scope, input) {
			const running = await scope.first(siteExports, inArray(siteExports.status, ["waiting", "running"]));
			if (running) throw new SiteExportRunningError();
			const id = crypto.randomUUID();
			const now = scope.now();
			const kdf = input.passphrase ? newKdf() : null;
			if (input.passphrase && kdf) {
				await deps.secrets.set(exportKey(id), await passphraseKey(input.passphrase, kdf));
			}
			const target = await storage.current();
			const row = await scope.transaction(async (tx) => {
				const inserted = await tx.insert(siteExports, {
					id,
					status: "waiting",
					requestedBy: actingPerson(tx.access.actor),
					withSecrets: kdf !== null,
					withSubmissions: input.includeSubmissions !== false,
					kdf,
					storage: target.kind,
					key: `${siteFolder(scope.site)}/exports/${id}`,
					fileName: `webcraft-site-${scope.site.slug}.tar`,
					createdAt: now,
				});
				await tx.audit("site.export", {
					exportId: id,
					secrets: kdf !== null ? "carried" : "dropped",
					submissions: input.includeSubmissions !== false,
				});
				return inserted;
			});
			await deps.jobs.send(siteExportsRun, { siteId: scope.site.id, exportId: id });
			return exportView(row, await names([row.requestedBy]));
		},

		async exports(scope) {
			const rows = await scope.select(siteExports, undefined, { orderBy: [desc(siteExports.createdAt)], limit: 20 });
			const who = await names(rows.map((row) => row.requestedBy));
			return Promise.all(rows.map((row) => exportView(row, who)));
		},

		async export(scope, exportId) {
			const row = await findExport(scope, exportId);
			return exportView(row, await names([row.requestedBy]));
		},

		async download(access, link) {
			const expires = Number(link.expires);
			if (!isUuid(link.siteId) || !isUuid(link.exportId) || !Number.isSafeInteger(expires)) {
				throw new SiteExportNotFoundError();
			}
			const expected = Buffer.from(await signature(link.siteId, link.exportId, expires), "hex");
			const given = /^[0-9a-f]{64}$/.test(link.signature) ? Buffer.from(link.signature, "hex") : null;
			if (!given || !timingSafeEqual(expected, given) || expires <= clock.now().getTime()) {
				throw new SiteExportNotFoundError();
			}
			const scope = await data.site(access, link.siteId, "site.export");
			const row = await findExport(scope, link.exportId);
			if (row.status !== "done" || !row.expiresAt || row.expiresAt.getTime() !== expires) {
				throw new SiteExportNotFoundError();
			}
			const body = await streamParts(storage, row);
			if (!body) throw new SiteExportNotFoundError();
			await scope.audit("siteExport.download", { exportId: row.id, fileName: row.fileName });
			return { body, size: row.sizeBytes ?? 0, fileName: row.fileName };
		},

		async startUpload(scope, input) {
			if (!Number.isSafeInteger(input.size) || input.size < 1 || input.size > SITE_IMPORT_MAX_BYTES) {
				throw new SiteImportUploadRefusedError("size", `A Site export can be at most ${SITE_IMPORT_MAX_BYTES} bytes.`, {
					maxBytes: SITE_IMPORT_MAX_BYTES,
				});
			}
			const part = input.partBytes ?? IMPORT_PART_BYTES;
			if (
				!Number.isInteger(part) ||
				part < IMPORT_PART_MIN_BYTES ||
				part > IMPORT_PART_BYTES ||
				Math.ceil(input.size / part) > IMPORT_MAX_PARTS
			) {
				throw new SiteImportUploadRefusedError(
					"part",
					`Parts are ${IMPORT_PART_MIN_BYTES} to ${IMPORT_PART_BYTES} bytes, at most ${IMPORT_MAX_PARTS} of them.`,
					{ minBytes: IMPORT_PART_MIN_BYTES, maxBytes: IMPORT_PART_BYTES },
				);
			}
			const id = crypto.randomUUID();
			const target = await storage.current();
			const now = scope.now();
			const row = await scope.insert(siteImports, {
				id,
				status: "uploading",
				startedBy: actingPerson(scope.access.actor),
				fileName: cleanFileName(input.fileName),
				sizeBytes: input.size,
				receivedBytes: 0,
				partBytes: part,
				parts: [],
				storage: target.kind,
				key: `${scope.workspace.id}/site-imports/${id}`,
				createdAt: now,
				expiresAt: new Date(now.getTime() + SITE_IMPORT_UPLOAD_LIFETIME_MS),
			});
			return importView(row);
		},

		async uploadPart(scope, input) {
			const saved = await scope.transaction(async (tx) => {
				const row = await findImport(tx, input.importId, true);
				ownUpload(tx, row);
				if (row.status !== "uploading") {
					throw new SiteImportUploadRefusedError("status", "This file has all its parts already.", {
						status: row.status,
					});
				}
				const parts = row.parts as string[];
				const index = input.offset / row.partBytes;
				const expected = Math.min(row.partBytes, row.sizeBytes - input.offset);
				if (!Number.isInteger(index) || index < 0 || index > parts.length || expected <= 0) {
					throw new SiteImportUploadRefusedError("offset", "Send the part that starts where the file got to.", {
						receivedBytes: row.receivedBytes,
					});
				}
				if (input.data.length !== expected) {
					throw new SiteImportUploadRefusedError("part", `This part should be ${expected} bytes.`, { bytes: expected });
				}
				const hash = createHash("sha256").update(input.data).digest("hex");
				if (hash !== input.sha256.toLowerCase()) {
					throw new SiteImportUploadRefusedError(
						"hash",
						"The part's bytes don't have the SHA-256 sent with it: send it again.",
						{
							offset: input.offset,
						},
					);
				}
				if (index < parts.length) {
					if (parts[index] !== hash) {
						throw new SiteImportUploadRefusedError("offset", "Send the part that starts where the file got to.", {
							receivedBytes: row.receivedBytes,
						});
					}
					return row;
				}
				const backend = await storage.holding(row.storage as StorageKind);
				await backend.put(
					`${row.key}/part-${String(index + 1).padStart(6, "0")}`,
					input.data,
					"application/octet-stream",
				);
				const now = tx.now();
				const [updated] = await tx.update(
					siteImports,
					{
						parts: [...parts, hash],
						receivedBytes: row.receivedBytes + input.data.length,
						expiresAt: new Date(now.getTime() + SITE_IMPORT_UPLOAD_LIFETIME_MS),
					},
					eq(siteImports.id, row.id),
				);
				return updated as ImportRow;
			});
			return importView(saved);
		},

		async finishUpload(scope, input) {
			const row = await scope.transaction(async (tx) => {
				const found = await findImport(tx, input.importId, true);
				ownUpload(tx, found);
				if (found.status !== "uploading") {
					throw new SiteImportUploadRefusedError("status", "This file has all its parts already.", {
						status: found.status,
					});
				}
				if (found.receivedBytes !== found.sizeBytes) {
					throw new SiteImportUploadRefusedError("size", "Parts of the file are still to come.", {
						receivedBytes: found.receivedBytes,
						size: found.sizeBytes,
					});
				}
				if (partsHash(found.parts as string[]) !== input.sha256.toLowerCase()) {
					throw new SiteImportUploadRefusedError(
						"hash",
						"The file's parts don't add up to the SHA-256 sent: upload it again.",
					);
				}
				return found;
			});
			// Only the archive's first files are read here: its manifest, and the passphrase check.
			const stream = await streamParts(storage, row);
			let refusal: { reason: string; message: string } | null = null;
			let manifest: Record<string, unknown> | null = null;
			try {
				if (!stream) throw new ArchiveRefusedError("damaged", "A part of the file is missing from storage.");
				const head = await readArchiveHead(stream);
				const modules: SiteImportArchive["modules"] = [];
				for (const module of head.manifest.modules) {
					modules.push({
						id: module.id,
						version: module.version,
						status: await deps.modules.transferStatus(module.id),
					});
				}
				const archive: SiteImportArchive = {
					site: { name: head.manifest.site.name, slug: head.manifest.site.slug },
					webcraft: head.manifest.webcraft.version,
					exportedAt: head.manifest.createdAt,
					counts: head.manifest.counts,
					files: {
						count: head.manifest.files.rows,
						bytes: head.manifest.files.bytes,
						mediaBytes: head.manifest.files.mediaBytes,
					},
					secrets: { carried: head.manifest.secrets.carried, names: head.manifest.secrets.names },
					modules,
					leftOut: head.manifest.leftOut,
				};
				manifest = { archive, secrets: head.secrets };
			} catch (error) {
				if (!(error instanceof ArchiveRefusedError)) throw error;
				refusal = { reason: error.reason, message: error.message, ...error.details };
			} finally {
				await stream?.cancel().catch(() => {});
			}
			const [updated] = await scope.update(
				siteImports,
				refusal ? { status: "refused", refusal } : { status: "ready", manifest },
				eq(siteImports.id, row.id),
			);
			if (refusal) {
				const { reason, message, ...details } = refusal;
				throw new SiteImportRefusedError(reason as ArchiveRefusedError["reason"], message, details);
			}
			return importView(updated as ImportRow);
		},

		async start(scope, input) {
			const name = input.name.trim();
			if (!name || name.length > SITE_NAME_MAX_LENGTH) {
				throw new TypeError(`A Site's name needs 1 to ${SITE_NAME_MAX_LENGTH} characters.`);
			}
			const slug = checkSlug(input.slug, reservedSlugs(deps.config));
			const row = await findImport(scope, input.importId);
			ownUpload(scope, row);
			if (row.status !== "ready" || !row.manifest) throw new SiteImportStateError(row.status);
			const [taken] = await scope.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug));
			if (taken) throw new SlugTakenError(slug);
			const { archive, secrets } = row.manifest as {
				archive: SiteImportArchive;
				secrets: { kdf: Kdf; check: { iv: string; ciphertext: string } } | null;
			};
			const [quota] = await scope.db
				.select({ quotaBytes: mediaQuotas.quotaBytes })
				.from(mediaQuotas)
				.where(eq(mediaQuotas.workspaceId, scope.workspace.id));
			if (quota?.quotaBytes != null) {
				const used = await workspaceMediaBytes(scope.db, scope.workspace.id);
				if (used + archive.files.mediaBytes > quota.quotaBytes) throw new MediaQuotaFullError(used, quota.quotaBytes);
			}
			if (secrets && input.passphrase) {
				const kdf = kdfSchema.parse(secrets.kdf);
				const key = await passphraseKey(input.passphrase, kdf);
				if (!(await keyOpens(key, secrets.check))) throw new PassphraseWrongError();
				await deps.secrets.set(importKey(row.id), key);
			}
			const [updated] = await scope.update(
				siteImports,
				{ status: "waiting", name, slug, startedBy: actingPerson(scope.access.actor), failure: null },
				and(eq(siteImports.id, row.id), eq(siteImports.status, "ready")),
			);
			if (!updated) throw new SiteImportStateError(row.status);
			await deps.jobs.send(siteImportsRun, { workspaceId: scope.workspace.id, importId: row.id });
			return importView(updated);
		},

		async imports(scope) {
			const rows = await scope.select(siteImports, undefined, { orderBy: [desc(siteImports.createdAt)], limit: 50 });
			return Promise.all(rows.map(importView));
		},

		async import(scope, importId) {
			return importView(await findImport(scope, importId));
		},

		async sendInvitations(scope, importId) {
			const row = await findImport(scope, importId);
			const report = row.report as SiteImportReport | null;
			if (row.status !== "done" || !report) throw new SiteImportStateError(row.status);
			const invited: SiteImportReport["invited"] = [];
			for (const invite of report.invited) {
				if (invite.sent) {
					invited.push(invite);
					continue;
				}
				try {
					await deps.members.resendInvite(scope, invite.inviteId);
					invited.push({ ...invite, sent: true });
				} catch (error) {
					// An invite revoked, accepted or run out since is left as it is.
					log.info("A Site import's invitation couldn't be sent", { importId, error });
					invited.push(invite);
				}
			}
			const [updated] = await scope.update(siteImports, { report: { ...report, invited } }, eq(siteImports.id, row.id));
			return importView(updated as ImportRow);
		},

		async exportByCommand(input) {
			const background = await data.background(input.siteId);
			if (!background) throw new SiteNotFoundError();
			const site = background.site;
			const kdf = input.passphrase ? newKdf() : null;
			const key = input.passphrase && kdf ? await passphraseKey(input.passphrase, kdf) : null;
			const secrets: ExportSecrets =
				kdf && key
					? {
							secrets: {
								names: () => deps.commandSecrets.names(site),
								useWith: (name, use) => deps.commandSecrets.useWith(site, name, async (value) => use(value)),
							},
							kdf,
							withKey: (use) => use(key),
						}
					: null;
			const archive = await writeSiteExport(
				{
					database: deps.database,
					storage,
					modules: moduleSchemas(),
					includeSubmissions: input.includeSubmissions !== false,
					batchRows,
					now: () => clock.now(),
					progress: async () => {},
				},
				{ id: site.id, workspaceId: site.workspaceId },
				secrets,
				() => deps.commandSecrets.names(site),
			);
			try {
				const sizeBytes = await input.write(archive.manifest.name, archive.bytes);
				const { manifest } = archive;
				await recordAudit(deps.database.db, clock.now(), {
					personId: null,
					via: { kind: "command", name: "site export" },
					workspaceId: site.workspaceId,
					siteId: site.id,
					action: "site.export",
					details: {
						file: manifest.name,
						secrets: manifest.secrets.carried ? "carried" : "dropped",
						submissions: !manifest.leftOut.submissions,
					},
				});
				return {
					name: manifest.name,
					sizeBytes,
					summary: {
						counts: manifest.counts,
						files: { count: manifest.files.rows, bytes: manifest.files.bytes },
						modules: manifest.modules.map((module) => ({ id: module.id, version: module.version })),
						secrets: { carried: manifest.secrets.carried, names: manifest.secrets.names },
						leftOut: manifest.leftOut,
					},
				};
			} finally {
				await archive.done();
			}
		},

		async importByCommand(input) {
			const workspace = await data.backgroundWorkspace(input.workspaceId);
			if (!workspace) throw new WorkspaceNotFoundError();
			const name = input.name.trim();
			if (!name || name.length > SITE_NAME_MAX_LENGTH) {
				throw new TypeError(`A Site's name needs 1 to ${SITE_NAME_MAX_LENGTH} characters.`);
			}
			const slug = checkSlug(input.slug, reservedSlugs(deps.config));
			const [taken] = await deps.database.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug));
			if (taken) throw new SlugTakenError(slug);
			let head: Awaited<ReturnType<typeof readArchiveHead>>;
			try {
				head = await readArchiveHead(input.open());
			} catch (error) {
				if (error instanceof ArchiveRefusedError)
					throw new SiteImportRefusedError(error.reason, error.message, error.details);
				throw error;
			}
			let key: string | null = null;
			if (head.secrets && input.passphrase) {
				key = await passphraseKey(input.passphrase, kdfSchema.parse(head.secrets.kdf));
				if (!(await keyOpens(key, head.secrets.check))) throw new PassphraseWrongError();
			}
			const imported = await importSite(
				readerContext(async () => {}),
				input.open(),
				{
					workspaceId: input.workspaceId,
					name,
					slug,
					importer: null,
					secretsKey: key,
				},
			);
			const site = { workspaceId: input.workspaceId, id: imported.siteId };
			for (const secret of imported.secrets) await deps.commandSecrets.set(site, secret.name, secret.value);
			await regenerateFiles(imported.siteId, imported.media);
			const now = clock.now();
			const target = await storage.current();
			const id = crypto.randomUUID();
			const [row] = await deps.database.db
				.insert(siteImports)
				.values({
					id,
					workspaceId: input.workspaceId,
					status: "done",
					startedBy: null,
					fileName: cleanFileName(input.fileName),
					sizeBytes: input.sizeBytes,
					receivedBytes: input.sizeBytes,
					partBytes: IMPORT_PART_BYTES,
					parts: [],
					storage: target.kind,
					key: `${input.workspaceId}/site-imports/${id}`,
					manifest: null,
					name,
					slug,
					siteId: imported.siteId,
					report: imported.report,
					createdAt: now,
					startedAt: now,
					finishedAt: now,
					expiresAt: new Date(now.getTime() + SITE_IMPORT_REPORT_LIFETIME_MS),
				})
				.returning();
			const via = { kind: "command", name: "site import" } as const;
			await recordAudit(deps.database.db, now, {
				personId: null,
				via,
				workspaceId: input.workspaceId,
				siteId: imported.siteId,
				action: "site.import",
				details: importDetails({ id, name, slug }, imported.report),
			});
			for (const invite of imported.report.invited) {
				await recordAudit(deps.database.db, now, {
					personId: null,
					via,
					workspaceId: input.workspaceId,
					siteId: imported.siteId,
					action: "member.invite",
					details: { email: invite.email, role: invite.role, sites: [imported.siteId], sent: false, siteImport: id },
				});
			}
			log.info("Imported a Site by command", { workspaceId: input.workspaceId, siteId: imported.siteId });
			return importView(row as ImportRow);
		},

		async runExport({ siteId, exportId }) {
			const background = await data.background(siteId);
			const row = background ? await background.first(siteExports, eq(siteExports.id, exportId)) : undefined;
			if (!background || !row || (row.status !== "waiting" && row.status !== "running")) return;
			const update = (values: Partial<typeof siteExports.$inferInsert>) =>
				background.update(siteExports, values, eq(siteExports.id, row.id));
			let written = 0;
			const backend = await storage.holding(row.storage as StorageKind);
			try {
				const access = await accessOf(row.requestedBy);
				let scope: SiteScope;
				try {
					if (!access) throw new PermissionDeniedError("site.export");
					scope = await data.site(access, siteId, "site.export");
				} catch (error) {
					if (!refusedBecauseOfAccess(error)) throw error;
					await update({ status: "failed", failure: { reason: "access" }, finishedAt: clock.now() });
					return;
				}
				await update({ status: "running", startedAt: clock.now() });
				const kdf = row.kdf ? kdfSchema.parse(row.kdf) : null;
				const secrets: ExportSecrets = kdf
					? {
							secrets: scope.secrets,
							kdf,
							withKey: (use) => deps.secrets.useWith(exportKey(row.id), use),
						}
					: null;
				const archive = await writeSiteExport(
					{
						database: deps.database,
						storage,
						modules: moduleSchemas(),
						includeSubmissions: row.withSubmissions,
						batchRows,
						now: () => clock.now(),
						progress: (step, done, total) => update({ progress: { step, done, total } }).then(() => {}),
					},
					{ id: siteId, workspaceId: scope.site.workspaceId },
					secrets,
					() => scope.secrets.names(""),
				);
				try {
					const { parts, size } = await writeParts(backend, row.key, archive.bytes, partBytes, async () => {
						written++;
					});
					const now = clock.now();
					const { manifest } = archive;
					const summary: SiteExportSummary = {
						counts: manifest.counts,
						files: { count: manifest.files.rows, bytes: manifest.files.bytes },
						modules: manifest.modules.map((module) => ({ id: module.id, version: module.version })),
						secrets: { carried: manifest.secrets.carried, names: manifest.secrets.names },
						leftOut: manifest.leftOut,
					};
					await update({
						status: "done",
						parts,
						sizeBytes: size,
						fileName: manifest.name,
						summary,
						progress: null,
						finishedAt: now,
						expiresAt: new Date(now.getTime() + SITE_EXPORT_LINK_LIFETIME_MS),
					});
					log.info("Exported a Site", { siteId, exportId, sizeBytes: size, secrets: manifest.secrets.carried });
				} finally {
					await archive.done();
				}
			} catch (error) {
				log.error("A Site export failed", { siteId, exportId, error });
				await removeParts(backend, row.key, written).catch(() => {});
				await update({ status: "failed", failure: { reason: "error" }, progress: null, finishedAt: clock.now() });
			} finally {
				await deps.secrets.remove(exportKey(row.id)).catch(() => {});
			}
		},

		async runImport({ workspaceId, importId }) {
			const background = await data.backgroundWorkspace(workspaceId);
			const [row] = background ? await background.select(siteImports, eq(siteImports.id, importId)) : [];
			if (!background || !row || (row.status !== "waiting" && row.status !== "running")) return;
			const update = (values: Partial<typeof siteImports.$inferInsert>) =>
				background.update(siteImports, values, eq(siteImports.id, row.id));
			const backend = await storage.holding(row.storage as StorageKind);
			const fail = async (reason: string, message?: string) => {
				await update({
					status: "failed",
					failure: message ? { reason, message } : { reason },
					progress: null,
					finishedAt: clock.now(),
					expiresAt: new Date(clock.now().getTime() + SITE_IMPORT_REPORT_LIFETIME_MS),
				});
			};
			try {
				const access = await accessOf(row.startedBy);
				let scope: WorkspaceScope;
				try {
					if (!access) throw new PermissionDeniedError("site.import");
					scope = await data.workspace(access, workspaceId, "site.import");
				} catch (error) {
					if (!refusedBecauseOfAccess(error)) throw error;
					return await fail("access");
				}
				await update({ status: "running", startedAt: clock.now() });
				const archive = await streamParts(storage, row);
				if (!archive) return await fail("damaged", "A part of the file is missing from storage.");
				const context = readerContext((step, done, total) =>
					update({ progress: { step, done, total } }).then(() => {}),
				);
				const run = async (secretsKey: string | null) => {
					const imported = await importSite(context, archive as AsyncIterable<Uint8Array>, {
						workspaceId,
						name: row.name ?? "",
						slug: row.slug ?? "",
						importer: personIdOf(scope.access.actor),
						secretsKey,
					});
					// The Site exists now: its secrets go in through its own scope.
					if (imported.secrets.length > 0) {
						const site = await data.site(scope.access, imported.siteId, "site.view");
						for (const secret of imported.secrets) await site.secrets.set(secret.name, secret.value);
					}
					return { siteId: imported.siteId, report: imported.report, media: imported.media };
				};
				const hasKey = (await deps.secrets.describe(importKey(row.id))).set;
				const result = hasKey ? await deps.secrets.useWith(importKey(row.id), run) : await run(null);
				await regenerateFiles(result.siteId, result.media);
				await scope.transaction(async (tx) => {
					await tx.audit("site.import", importDetails(row, result.report), { siteId: result.siteId });
					for (const invite of result.report.invited) {
						await tx.audit(
							"member.invite",
							{ email: invite.email, role: invite.role, sites: [result.siteId], sent: false, siteImport: row.id },
							{ siteId: result.siteId },
						);
					}
				});
				const now = clock.now();
				await update({
					status: "done",
					siteId: result.siteId,
					report: result.report,
					progress: null,
					finishedAt: now,
					expiresAt: new Date(now.getTime() + SITE_IMPORT_REPORT_LIFETIME_MS),
				});
				log.info("Imported a Site", { workspaceId, importId, siteId: result.siteId });
			} catch (error) {
				if (error instanceof ArchiveRefusedError) await fail(error.reason, error.message);
				else if (error instanceof PassphraseWrongError) await fail("passphrase");
				else if (error instanceof MediaQuotaFullError) await fail("quota");
				else if (error instanceof SiteImportSlugError || error instanceof SlugTakenError) await fail("slug");
				else {
					log.error("A Site import failed", { workspaceId, importId, error });
					await fail("error");
				}
			} finally {
				await deps.secrets.remove(importKey(row.id)).catch(() => {});
				// The upload isn't needed any more, whatever happened: the report says what came of it.
				await removeParts(backend, row.key, (row.parts as string[]).length).catch(() => {});
			}
		},

		async purge() {
			const now = clock.now();
			const { db } = deps.database;
			const exports = await db
				.select()
				.from(siteExports)
				.where(and(inArray(siteExports.status, ["done", "failed"]), lte(siteExports.expiresAt, now)));
			for (const row of exports) {
				const backend = await storage.holding(row.storage as StorageKind);
				await removeParts(backend, row.key, (row.parts as string[]).length);
				await db.update(siteExports).set({ status: "expired", parts: [] }).where(eq(siteExports.id, row.id));
			}
			const failed = await db
				.select({ id: siteExports.id })
				.from(siteExports)
				.where(and(eq(siteExports.status, "failed"), sql`${siteExports.expiresAt} IS NULL`));
			for (const row of failed) {
				await db
					.update(siteExports)
					.set({ expiresAt: new Date(now.getTime() + SITE_EXPORT_LINK_LIFETIME_MS) })
					.where(eq(siteExports.id, row.id));
			}
			const imports = await db.select().from(siteImports).where(lte(siteImports.expiresAt, now));
			for (const row of imports) {
				if (row.status === "waiting" || row.status === "running") continue;
				const backend = await storage.holding(row.storage as StorageKind);
				await removeParts(backend, row.key, (row.parts as string[]).length);
				await db.delete(siteImports).where(eq(siteImports.id, row.id));
			}
			// A passphrase's key left behind by a job that never ended.
			for (const prefix of ["siteExport:", "siteImport:"]) {
				for (const name of await deps.secrets.names({ kind: "install" }, prefix)) {
					const id = name.split(":")[1] ?? "";
					const busy = isUuid(id)
						? prefix === "siteExport:"
							? await db
									.select({ id: siteExports.id })
									.from(siteExports)
									.where(and(eq(siteExports.id, id), inArray(siteExports.status, ["waiting", "running"])))
							: await db
									.select({ id: siteImports.id })
									.from(siteImports)
									.where(and(eq(siteImports.id, id), inArray(siteImports.status, ["ready", "waiting", "running"])))
						: [];
					if (busy.length === 0) await deps.secrets.remove({ owner: { kind: "install" }, name });
				}
			}
		},
	};
}

/** An upload is the uploader's: nobody else adds parts to it or starts it. */
function ownUpload(scope: WorkspaceScope, row: ImportRow): void {
	if (row.startedBy !== personIdOf(scope.access.actor)) throw new SiteImportNotFoundError();
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

/** A file name as people see it: no folders before it, no control characters, at most 255 characters. */
function cleanFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
	const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return clean.slice(0, 255) || "site-export.tar";
}

const exportPayload = z.object({ siteId: z.uuid(), exportId: z.uuid() });
const importPayload = z.object({ workspaceId: z.uuid(), importId: z.uuid() });

/** Writes a Site export in the worker (one job: it streams, so it may take a while). */
export const siteExportsRun = defineJob({
	name: "siteExports.run",
	payload: exportPayload,
	queue: { retryLimit: 0, expireInSeconds: 6 * 60 * 60 },
	run: (payload, services) => services.siteTransfer.runExport(payload),
});

/** Reads a Site export into a new Site in the worker. */
export const siteImportsRun = defineJob({
	name: "siteImports.run",
	payload: importPayload,
	queue: { retryLimit: 0, expireInSeconds: 6 * 60 * 60 },
	run: (payload, services) => services.siteTransfer.runImport(payload),
});

/** Deletes exports whose download link ran out, uploads nobody started, and reports past keeping. */
export const siteTransfersPurge = defineJob({
	name: "siteTransfers.purge",
	payload: z.object({}),
	queue: { retryLimit: 1 },
	run: (_payload, services) => services.siteTransfer.purge(),
});

export const siteTransfersPurgeSchedule = defineSchedule({ job: siteTransfersPurge, cron: "13 * * * *", payload: {} });

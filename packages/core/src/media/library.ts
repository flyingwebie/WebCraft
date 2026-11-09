import { media, mediaFiles, mediaFolders, people } from "@webcraft/db/schema";
import { and, asc, count, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { isUniqueViolation } from "../db-errors.ts";
import type { Email } from "../email/index.ts";
import { isUuid } from "../ids.ts";
import type { InstallSettings } from "../install-settings.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import { actingPerson, can, personIdOf } from "../permissions/can.ts";
import type { SiteScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import {
	MediaFolderNotFoundError,
	MediaFolderTakenError,
	MediaInvalidError,
	MediaNotFoundError,
	MediaTooLargeError,
	MediaTypeRefusedError,
} from "./errors.ts";
import type { VariantFormat } from "./images.ts";
import type { InstallStorage } from "./install-storage.ts";
import { mediaProcess } from "./jobs.ts";
import type { MediaKind } from "./kinds.ts";
import { contentHash, MEDIA_PATH, SERVED_NAME, servedName } from "./names.ts";
import { assertRoom, type MediaStorage, mediaStorage, noticeQuotaUse, setMediaQuota } from "./quota.ts";
import { gifSize, sniff } from "./sniff.ts";
import { type ByteRange, type StorageBackend, type StorageKind, siteFolder } from "./storage.ts";
import { MEDIA_TEXTS, type MediaText, readText, storedTexts, writeText } from "./texts.ts";

export const MEDIA_FOLDER_NAME_MAX_LENGTH = 100;

/**
 * A Media item: `processing` until the worker has cleaned an image, `ready` once visitors get its
 * original (and, when the worker is done, its variants), `failed` when it couldn't be read.
 */
export type MediaStatus = "processing" | "ready" | "failed";

/** One width of an image, in AVIF or WebP. */
export type MediaVariant = { format: VariantFormat; width: number; height: number; url: string };

/** A file in a Site's Media library, as the admin shows it. Texts are in `language`. */
export type MediaItem = {
	id: string;
	siteId: string;
	folderId: string | null;
	kind: MediaKind;
	/** The name the file was uploaded with. */
	fileName: string;
	/** The type visitors get (a HEIC photo's is `image/jpeg` once converted). */
	contentType: string;
	sizeBytes: number;
	/** Upright, in pixels; null for files that aren't images, or until the worker has read the image. */
	width: number | null;
	height: number | null;
	status: MediaStatus;
	/** Where visitors get the original on the Site's domain, `/_media/<hash>-<name>`; null until ready. */
	url: string | null;
	/** The widths made of an image, smallest first, AVIF then WebP; empty until the worker made them. */
	variants: MediaVariant[];
	language: string;
	title: string | null;
	alt: string | null;
	caption: string | null;
	/** Who uploaded it; null once that person is deleted. */
	uploadedBy: { id: string; name: string } | null;
	createdAt: Date;
	updatedAt: Date;
	/** Whether the person asking may change it: their own upload, or every file with `media.manage`. */
	canEdit: boolean;
};

/** Which files to list: in a folder (`none`: in no folder), matching a search, of a kind. */
export type MediaQuery = {
	folderId?: string;
	search?: string;
	kind?: MediaKind;
	language?: string;
	limit?: number;
	offset?: number;
};

/** A change to a Media item. Texts are in `language` (the Default language unless given); null clears one. */
export type MediaChange = {
	language?: string;
	title?: string | null;
	alt?: string | null;
	caption?: string | null;
	/** Files it into a folder; null for none. */
	folderId?: string | null;
};

export type MediaFolder = { id: string; name: string; count: number; createdAt: Date };

/** What a Site's Media library takes and holds, for the library's screen. */
export type MediaOverview = {
	/** The largest file an upload, a replacement or an import may be (Install settings › Storage). */
	maxFileBytes: number;
	/** The Workspace's Media storage: what its Sites take, and its quota if Staff set one. */
	storage: MediaStorage;
};

/** A file as it was uploaded. */
export type NewUpload = { fileName: string; data: Uint8Array; folderId?: string | null };

/** A stored original or variant, ready to be streamed. */
export type StoredMediaFile = {
	contentType: string;
	size: number;
	/** A strong ETag: the content hash in the file's name. */
	etag: string;
	/** The file, or the bytes in `range`; null when the storage no longer holds it. */
	open(range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
};

/**
 * A Site's Media library: uploads, the files' texts and folders. Open the Site with `site.view` to
 * read, `media.upload` to upload and change your own uploads, and `media.manage` for folders. Changes
 * go live at once, with no Draft.
 */
export type MediaLibrary = {
	upload(scope: SiteScope, upload: NewUpload): Promise<MediaItem>;
	list(scope: SiteScope, query?: MediaQuery): Promise<{ items: MediaItem[]; total: number }>;
	get(scope: SiteScope, mediaId: string, language?: string): Promise<MediaItem>;
	/** Changes texts or the folder: a person's own upload, or any with `media.manage`. */
	update(scope: SiteScope, mediaId: string, change: MediaChange): Promise<MediaItem>;
	/** An original or variant by the name it is served under, or null. */
	file(scope: SiteScope, name: string): Promise<StoredMediaFile | null>;
	/** What the library takes and holds: the largest file, the Workspace's storage. */
	overview(scope: SiteScope): Promise<MediaOverview>;
	/** A Workspace's Media storage and quota. Open it with `workspace.view` to read, `quota.manage` to set. */
	quota: {
		get(scope: WorkspaceScope): Promise<MediaStorage>;
		/** Sets the quota in bytes (at least `MEDIA_QUOTA_MIN_BYTES`), or removes it with null. */
		set(scope: WorkspaceScope, quotaBytes: number | null): Promise<MediaStorage>;
	};
	folders: {
		list(scope: SiteScope): Promise<{ folders: MediaFolder[]; total: number }>;
		create(scope: SiteScope, name: string): Promise<MediaFolder>;
		rename(scope: SiteScope, folderId: string, name: string): Promise<MediaFolder>;
		/** Deletes a folder; its files stay in the library, in no folder. */
		delete(scope: SiteScope, folderId: string): Promise<void>;
	};
};

type MediaRow = typeof media.$inferSelect;
type FileRow = typeof mediaFiles.$inferSelect;

/** A file name as people see it: no folders before it, no control characters, at most 255 characters. */
function cleanFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
	const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return clean.slice(0, 255) || "file";
}

export function createMediaLibrary(options: {
	storage: InstallStorage;
	jobs: JobQueue;
	/** Install settings › Storage: the largest file the library takes. */
	settings: Pick<InstallSettings, "media">;
	/** System emails, for the warning when a Workspace's storage passes 80% of its quota. */
	email: Email;
	log: Logger;
	clock: Clock;
}): MediaLibrary {
	const { storage, jobs, settings } = options;
	const noticePorts = { email: options.email, log: options.log, clock: options.clock };

	const get = async (scope: SiteScope, mediaId: string, language?: string) => {
		const row = isUuid(mediaId) ? await scope.first(media, eq(media.id, mediaId)) : undefined;
		if (!row) throw new MediaNotFoundError();
		const { language: chosen, defaultLanguage } = await mediaLanguages(scope, language);
		const [item] = await views(scope, [row], chosen, defaultLanguage);
		if (!item) throw new MediaNotFoundError();
		return item;
	};

	const findFolder = async (scope: SiteScope, folderId: string) => {
		const folder = isUuid(folderId) ? await scope.first(mediaFolders, eq(mediaFolders.id, folderId)) : undefined;
		if (!folder) throw new MediaFolderNotFoundError();
		return folder;
	};

	const folderCount = async (scope: SiteScope, folderId: string) => scope.count(media, eq(media.folderId, folderId));

	const saveFolderName = async <Result>(save: () => Promise<Result>) => {
		try {
			return await save();
		} catch (error) {
			if (isUniqueViolation(error, "media_folders_site_id_name_unique")) throw new MediaFolderTakenError();
			throw error;
		}
	};

	return {
		async upload(scope, upload) {
			const { maxFileBytes } = await settings.media();
			if (upload.data.length > maxFileBytes) throw new MediaTooLargeError(maxFileBytes);
			const sniffed = sniff(upload.data);
			if ("refused" in sniffed) throw new MediaTypeRefusedError(sniffed.refused);
			const { format } = sniffed;
			const folderId = upload.folderId ? (await findFolder(scope, upload.folderId)).id : null;
			const fileName = cleanFileName(upload.fileName);
			const id = crypto.randomUUID();
			const target = await storage.current();
			const now = scope.now();
			const personId = actingPerson(scope.access.actor);

			// Images are cleaned by the worker before anyone sees them (they may carry GPS data): until
			// then the upload is kept apart, and never served.
			const clean = format.handling === "clean";
			const name = clean ? id : servedName(await contentHash(upload.data), fileName, format.extension);
			const key = `${siteFolder(scope.site)}/${clean ? "uploads" : "media"}/${name}`;
			const size = format.format === "gif" ? gifSize(upload.data) : undefined;
			// Refused before anything is stored when it plainly doesn't fit.
			const shared = await keyIsStored(scope, target.kind, key);
			await assertRoom(scope.db, scope.workspace.id, shared ? 0 : upload.data.length);
			await target.put(key, upload.data, format.contentType);
			try {
				await scope.transaction(async (tx) => {
					// Checked again with the quota held, now that the file is stored: two uploads at once
					// can't both squeeze past it. A file that already shares stored bytes adds none.
					const adds = (await keyIsStored(tx, target.kind, key)) ? 0 : upload.data.length;
					await assertRoom(tx.db, tx.workspace.id, adds, { lock: true });
					await tx.insert(media, {
						id,
						folderId,
						kind: format.kind,
						fileName,
						contentType: format.contentType,
						sizeBytes: upload.data.length,
						width: size?.width ?? null,
						height: size?.height ?? null,
						status: clean ? "processing" : "ready",
						uploadedBy: personId,
						createdAt: now,
						updatedAt: now,
					});
					await tx.insert(mediaFiles, {
						mediaId: id,
						role: clean ? "upload" : "original",
						name,
						format: format.format,
						contentType: format.contentType,
						width: size?.width ?? null,
						height: size?.height ?? null,
						sizeBytes: upload.data.length,
						storage: target.kind,
						key,
						createdAt: now,
					});
					await tx.audit("media.upload", { mediaId: id, fileName, contentType: format.contentType });
				});
			} catch (error) {
				await forgetStored(scope, target, key);
				throw error;
			}
			if (clean) await jobs.send(mediaProcess, { siteId: scope.site.id, mediaId: id });
			await noticeQuotaUse(scope.db, noticePorts, scope.workspace);
			return get(scope, id);
		},

		async list(scope, query = {}) {
			const { language, defaultLanguage } = await mediaLanguages(scope, query.language);
			const conditions: SQL[] = [];
			if (query.folderId === "none") conditions.push(isNull(media.folderId));
			else if (query.folderId !== undefined)
				conditions.push(eq(media.folderId, (await findFolder(scope, query.folderId)).id));
			if (query.kind) conditions.push(eq(media.kind, query.kind));
			const search = query.search?.trim();
			if (search) conditions.push(matching(search));
			const where = conditions.length > 0 ? and(...conditions) : undefined;
			const rows = await scope.db
				.select()
				.from(media)
				.where(scope.where(media, where))
				.orderBy(desc(media.createdAt), asc(media.id))
				.limit(Math.min(Math.max(query.limit ?? 100, 1), 200))
				.offset(Math.max(query.offset ?? 0, 0));
			return {
				items: await views(scope, rows, language, defaultLanguage),
				total: await scope.count(media, where),
			};
		},

		get,

		async update(scope, mediaId, change) {
			const { language } = await mediaLanguages(scope, change.language);
			const personId = actingPerson(scope.access.actor);
			await scope.transaction(async (tx) => {
				const [row] = isUuid(mediaId)
					? await tx.db
							.select()
							.from(media)
							.where(tx.where(media, eq(media.id, mediaId)))
							.for("update")
					: [];
				if (!row) throw new MediaNotFoundError();
				if (!mayChange(tx, row)) throw new PermissionDeniedError("media.manage");

				const changed: string[] = [];
				let texts = storedTexts(row.texts);
				for (const key of MEDIA_TEXTS) {
					const value = change[key];
					if (value === undefined) continue;
					// Written in the language itself: reading falls back to the Default language, writing never does.
					const before = texts.values[key]?.[language]?.value ?? "";
					const next = value?.trim() ?? "";
					if (before === next) continue;
					texts = writeText(texts, key, language, next, { kind: "person", personId });
					changed.push(key);
				}
				let folderId = row.folderId;
				if (change.folderId !== undefined) {
					const next = change.folderId === null ? null : (await findFolder(tx, change.folderId)).id;
					if (next !== row.folderId) {
						folderId = next;
						changed.push("folder");
					}
				}
				if (changed.length === 0) return;
				await tx.update(media, { texts, folderId, updatedAt: tx.now() }, eq(media.id, row.id));
				await tx.audit("media.update", { mediaId: row.id, changed });
				// Texts such as alt text show on published pages: they change at once, with no Draft.
				if (changed.some((key) => key !== "folder")) await clearPageCache(tx);
			});
			return get(scope, mediaId, language);
		},

		async file(scope, name) {
			return storedFile(scope, storage, name);
		},

		async overview(scope) {
			const { maxFileBytes } = await settings.media();
			return { maxFileBytes, storage: await mediaStorage(scope.db, scope.workspace.id) };
		},

		quota: {
			get: (scope) => mediaStorage(scope.db, scope.workspace.id),
			set: (scope, quotaBytes) => setMediaQuota(scope, noticePorts, quotaBytes),
		},

		folders: {
			async list(scope) {
				const folders = await scope.select(mediaFolders, undefined, {
					orderBy: [sql`lower(${mediaFolders.name})`, asc(mediaFolders.id)],
				});
				const counts = await scope.db
					.select({ folderId: media.folderId, count: count() })
					.from(media)
					.where(scope.where(media))
					.groupBy(media.folderId);
				const byFolder = new Map(counts.map((row) => [row.folderId, row.count]));
				return {
					folders: folders.map((folder) => ({
						id: folder.id,
						name: folder.name,
						count: byFolder.get(folder.id) ?? 0,
						createdAt: folder.createdAt,
					})),
					total: counts.reduce((sum, row) => sum + row.count, 0),
				};
			},

			async create(scope, name) {
				const folder = await saveFolderName(() =>
					scope.transaction(async (tx) => {
						const row = await tx.insert(mediaFolders, { name: name.trim(), createdAt: tx.now() });
						await tx.audit("mediaFolder.create", { folderId: row.id, name: row.name });
						return row;
					}),
				);
				return { id: folder.id, name: folder.name, count: 0, createdAt: folder.createdAt };
			},

			async rename(scope, folderId, name) {
				const folder = await findFolder(scope, folderId);
				const renamed = await saveFolderName(() =>
					scope.transaction(async (tx) => {
						const [row] = await tx.update(mediaFolders, { name: name.trim() }, eq(mediaFolders.id, folder.id));
						if (!row) throw new MediaFolderNotFoundError();
						await tx.audit("mediaFolder.rename", { folderId: row.id, from: folder.name, to: row.name });
						return row;
					}),
				);
				return {
					id: renamed.id,
					name: renamed.name,
					count: await folderCount(scope, renamed.id),
					createdAt: renamed.createdAt,
				};
			},

			async delete(scope, folderId) {
				const folder = await findFolder(scope, folderId);
				await scope.transaction(async (tx) => {
					await tx.update(media, { folderId: null }, eq(media.folderId, folder.id));
					await tx.delete(mediaFolders, eq(mediaFolders.id, folder.id));
					await tx.audit("mediaFolder.delete", { folderId: folder.id, name: folder.name });
				});
			},
		},
	};
}

/** Whether a stored file is named by any of the Site's Media files (identical bytes share one). */
async function keyIsStored(scope: Pick<SiteScope, "count">, kind: StorageKind, key: string): Promise<boolean> {
	return (await scope.count(mediaFiles, and(eq(mediaFiles.storage, kind), eq(mediaFiles.key, key)))) > 0;
}

/** Removes a stored file nothing records any more (an upload that was refused once stored). */
async function forgetStored(scope: Pick<SiteScope, "count">, backend: StorageBackend, key: string): Promise<void> {
	if (!(await keyIsStored(scope, backend.kind, key))) await backend.delete(key);
}

/** Whether the scope's person may change a Media item: their own upload, or any with `media.manage`. */
function mayChange(scope: SiteScope, row: Pick<MediaRow, "uploadedBy">): boolean {
	return row.uploadedBy === personIdOf(scope.access.actor) || canManage(scope);
}

function canManage(scope: SiteScope): boolean {
	return can(scope.access.actor, "media.manage", {
		level: "site",
		workspaceId: scope.workspace.id,
		siteId: scope.site.id,
	});
}

/** The Site's language `language` names (the Default language when absent); `MediaInvalidError` for one it doesn't have. */
async function mediaLanguages(
	scope: Pick<SiteScope, "db" | "site">,
	language?: string,
): Promise<{ language: string; defaultLanguage: string }> {
	const languages = languagesFor(await siteLanguages(scope), language);
	if (!languages) throw new MediaInvalidError([{ at: "language", message: `The Site has no language ${language}.` }]);
	return languages;
}

/** Files whose name, title or alt text holds `search`, in any case and any language. */
function matching(search: string): SQL {
	const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
	const inTexts = (key: "title" | "alt") =>
		sql`exists (select 1 from jsonb_each(${media.texts} -> 'values' -> ${key}::text) as text_value where text_value.value ->> 'value' ilike ${pattern})`;
	return or(sql`${media.fileName} ilike ${pattern}`, inTexts("title"), inTexts("alt")) as SQL;
}

/** Media items as the admin shows them, with their files and who uploaded them. */
async function views(
	scope: SiteScope,
	rows: readonly MediaRow[],
	language: string,
	defaultLanguage: string,
): Promise<MediaItem[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);
	const files = await scope.select(
		mediaFiles,
		and(inArray(mediaFiles.mediaId, ids), inArray(mediaFiles.role, ["original", "variant"])),
	);
	const uploaderIds = [...new Set(rows.map((row) => row.uploadedBy).filter((id): id is string => id !== null))];
	const uploaders = new Map(
		uploaderIds.length === 0
			? []
			: (
					await scope.db
						.select({ id: people.id, name: people.name })
						.from(people)
						.where(inArray(people.id, uploaderIds))
				).map((person) => [person.id, person.name]),
	);
	const manages = canManage(scope);
	const personId = personIdOf(scope.access.actor);
	return rows.map((row) => {
		const own = files.filter((file) => file.mediaId === row.id);
		const texts = storedTexts(row.texts);
		const text = (key: MediaText) => readText(texts, key, { language, defaultLanguage });
		const uploader = row.uploadedBy ? uploaders.get(row.uploadedBy) : undefined;
		return {
			id: row.id,
			siteId: row.siteId,
			folderId: row.folderId,
			kind: row.kind as MediaKind,
			fileName: row.fileName,
			contentType: row.contentType,
			sizeBytes: row.sizeBytes,
			width: row.width,
			height: row.height,
			status: row.status as MediaStatus,
			url: originalUrl(row, own),
			variants: variantsOf(own),
			language,
			title: text("title"),
			alt: text("alt"),
			caption: text("caption"),
			uploadedBy: row.uploadedBy && uploader !== undefined ? { id: row.uploadedBy, name: uploader } : null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			canEdit: manages || row.uploadedBy === personId,
		};
	});
}

/** The URL of a ready item's original. */
export function originalUrl(row: Pick<MediaRow, "status">, files: readonly FileRow[]): string | null {
	const original = files.find((file) => file.role === "original");
	return row.status === "ready" && original ? `${MEDIA_PATH}${original.name}` : null;
}

/** An image's variants, smallest first, AVIF before WebP at each width. */
export function variantsOf(files: readonly FileRow[]): MediaVariant[] {
	return files
		.filter((file) => file.role === "variant" && file.width !== null && file.height !== null)
		.map((file) => ({
			format: file.format as VariantFormat,
			width: file.width ?? 0,
			height: file.height ?? 0,
			url: `${MEDIA_PATH}${file.name}`,
		}))
		.sort((a, b) => a.width - b.width || a.format.localeCompare(b.format));
}

/** A stored original or variant of the scope's Site by the name it is served under, or null. */
export async function storedFile(
	scope: Pick<SiteScope, "first">,
	storage: InstallStorage,
	name: string,
): Promise<StoredMediaFile | null> {
	if (!SERVED_NAME.test(name)) return null;
	const row = await scope.first(
		mediaFiles,
		and(eq(mediaFiles.name, name), inArray(mediaFiles.role, ["original", "variant"])),
	);
	if (!row) return null;
	const backend = await storage.holding(row.storage === "s3" ? "s3" : "disk");
	return {
		contentType: row.contentType,
		size: row.sizeBytes,
		etag: `"${name.slice(0, 16)}"`,
		open: (range) => backend.stream(row.key, range),
	};
}

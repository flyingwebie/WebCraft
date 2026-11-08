import { media, mediaFiles, mediaFolders, people } from "@webcraft/db/schema";
import { and, asc, count, desc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";

import { siteLanguages } from "../content/entries.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { type EntryVersion, readValue, storedVersion, writeValue } from "../content/values.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { isUuid } from "../ids.ts";
import type { JobQueue } from "../jobs/define.ts";
import { can } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
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
import { contentHash, MEDIA_PATH, SERVED_NAME, servedName } from "./names.ts";
import { gifSize, type MediaKind, sniff } from "./sniff.ts";
import { type ByteRange, siteFolder } from "./storage.ts";

/** The largest file the Media library takes. Quotas per Site come later. */
export const MEDIA_MAX_BYTES = 50 * 1024 * 1024;

/** The texts each Media item has, per language, and their longest. */
export const MEDIA_TEXT_MAX_LENGTH = { title: 200, alt: 1000, caption: 2000 } as const;

export type MediaText = keyof typeof MEDIA_TEXT_MAX_LENGTH;

const MEDIA_TEXTS = Object.keys(MEDIA_TEXT_MAX_LENGTH) as MediaText[];

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

export function createMediaLibrary(options: { storage: InstallStorage; jobs: JobQueue }): MediaLibrary {
	const { storage, jobs } = options;

	const get = async (scope: SiteScope, mediaId: string, language?: string) => {
		const row = isUuid(mediaId) ? await scope.first(media, eq(media.id, mediaId)) : undefined;
		if (!row) throw new MediaNotFoundError();
		const { defaultLanguage } = await siteLanguages(scope);
		const [item] = await views(scope, [row], checkLanguage(language, defaultLanguage), defaultLanguage);
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
			if (upload.data.length > MEDIA_MAX_BYTES) throw new MediaTooLargeError(MEDIA_MAX_BYTES);
			const sniffed = sniff(upload.data);
			if ("refused" in sniffed) throw new MediaTypeRefusedError(sniffed.refused);
			const { format } = sniffed;
			const folderId = upload.folderId ? (await findFolder(scope, upload.folderId)).id : null;
			const fileName = cleanFileName(upload.fileName);
			const id = crypto.randomUUID();
			const target = await storage.current();
			const now = scope.now();
			const personId = scope.access.actor.personId;

			// Images are cleaned by the worker before anyone sees them (they may carry GPS data): until
			// then the upload is kept apart, and never served.
			const clean = format.handling === "clean";
			const name = clean ? id : servedName(await contentHash(upload.data), fileName, format.extension);
			const key = `${siteFolder(scope.site)}/${clean ? "uploads" : "media"}/${name}`;
			const size = format.format === "gif" ? gifSize(upload.data) : undefined;
			await target.put(key, upload.data, format.contentType);
			await scope.transaction(async (tx) => {
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
			if (clean) await jobs.send(mediaProcess, { siteId: scope.site.id, mediaId: id });
			return get(scope, id);
		},

		async list(scope, query = {}) {
			const { defaultLanguage } = await siteLanguages(scope);
			const language = checkLanguage(query.language, defaultLanguage);
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
			const { defaultLanguage } = await siteLanguages(scope);
			const language = checkLanguage(change.language, defaultLanguage);
			const personId = scope.access.actor.personId;
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
				let texts = storedVersion(row.texts);
				for (const key of MEDIA_TEXTS) {
					const value = change[key];
					if (value === undefined) continue;
					const place = { key, translatable: true, language, defaultLanguage };
					const before = readValue(texts, place);
					const next = value?.trim() ?? "";
					if ((before ?? "") === next) continue;
					texts = writeValue(texts, place, next, { kind: "person", personId });
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

/** Whether the scope's person may change a Media item: their own upload, or any with `media.manage`. */
function mayChange(scope: SiteScope, row: Pick<MediaRow, "uploadedBy">): boolean {
	return row.uploadedBy === scope.access.actor.personId || canManage(scope);
}

function canManage(scope: SiteScope): boolean {
	return can(scope.access.actor, "media.manage", {
		level: "site",
		workspaceId: scope.workspace.id,
		siteId: scope.site.id,
	});
}

function checkLanguage(language: string | undefined, defaultLanguage: string): string {
	if (language !== undefined && language !== defaultLanguage) {
		throw new MediaInvalidError([{ at: "language", message: `The Site has no language ${language}.` }]);
	}
	return defaultLanguage;
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
	const personId = scope.access.actor.personId;
	return rows.map((row) => {
		const own = files.filter((file) => file.mediaId === row.id);
		const texts = storedVersion(row.texts);
		const text = (key: MediaText) => readValue(texts, { key, translatable: true, language, defaultLanguage });
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

/** The texts of a Media item, as stored. */
export function mediaTexts(row: Pick<MediaRow, "texts">): EntryVersion {
	return storedVersion(row.texts);
}

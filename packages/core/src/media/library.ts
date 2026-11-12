import { media, mediaFiles, mediaFolders, people } from "@webcraft/db/schema";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AiKeys } from "../ai/keys.ts";
import type { AiProviders } from "../ai/providers.ts";
import type { Clock } from "../clock.ts";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { isUniqueViolation } from "../db-errors.ts";
import type { Email } from "../email/index.ts";
import type { GuardedFetch } from "../guarded-fetch.ts";
import { isUuid } from "../ids.ts";
import type { InstallSettings } from "../install-settings.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { Logger } from "../log.ts";
import { actingPerson, can, personIdOf } from "../permissions/can.ts";
import type { SiteScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { canSuggestAltText, suggestAltText } from "./alt-text.ts";
import {
	MediaFolderNotFoundError,
	MediaFolderTakenError,
	MediaInTrashError,
	MediaInvalidError,
	MediaNotFoundError,
	MediaNotInTrashError,
	MediaReplaceRefusedError,
	MediaTooLargeError,
	MediaTypeRefusedError,
} from "./errors.ts";
import type { VariantFormat } from "./images.ts";
import { fetchForImport, MEDIA_IMPORT_TIMEOUT_MS } from "./import.ts";
import type { InstallStorage } from "./install-storage.ts";
import { mediaProcess } from "./jobs.ts";
import type { MediaKind } from "./kinds.ts";
import { contentHash, MEDIA_PATH, SERVED_NAME, servedName } from "./names.ts";
import { assertRoom, type MediaStorage, mediaStorage, noticeQuotaUse, setMediaQuota } from "./quota.ts";
import { type FileFormat, gifSize, sniff } from "./sniff.ts";
import { type ByteRange, type StorageBackend, type StorageKind, siteFolder } from "./storage.ts";
import { MEDIA_TEXTS, type MediaText, readText, storedTexts, writeText } from "./texts.ts";
import { deleteForGood, removeUnusedFiles, retireFiles, TRASH_LIFETIME_MS } from "./trash.ts";
import { type MediaUse, mediaUses } from "./usage.ts";

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
	/** When it went to the Trash, and when it will be deleted for good; null while it is in the library. */
	trashedAt: Date | null;
	purgeAt: Date | null;
	/** An image's Focal point, shared by every language; null when none is set (pages centre it). */
	focalPoint: FocalPoint | null;
	/** Whether a new file (Replace file) is waiting for the worker; the current one is served until then. */
	replacing: boolean;
	/** Why the worker refused the file, or the file meant to replace it (the item kept its own); null otherwise. */
	failure: MediaFailure | null;
	/** Whether the person asking may change it: their own upload, or every file with `media.manage`. */
	canEdit: boolean;
};

/**
 * Why the worker refused a file: `unreadable` (it isn't the image it claims to be), `svgInvalid` (an
 * SVG that can't be read) or `svgUnsafe` (an SVG holding what can't be kept, listed in `found`).
 * `replacement` when it was meant to replace the item's file, which the item kept.
 */
export type MediaFailure = {
	reason: "unreadable" | "svgInvalid" | "svgUnsafe";
	replacement?: boolean;
	found?: string[];
};

/**
 * Which files to list: in a folder (`none`: in no folder), matching a search, of a kind; with
 * `trash`, the files in the Trash instead (most recently deleted first).
 */
export type MediaQuery = {
	trash?: boolean;
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
	/** An image's Focal point, as percentages of its width and height (whole numbers, 0 to 100); null clears it. */
	focalPoint?: FocalPoint | null;
};

/** The spot of an image that must stay visible, as percentages of its width and height from its top left. */
export type FocalPoint = { x: number; y: number };

export type MediaFolder = { id: string; name: string; count: number; createdAt: Date };

/** What a Site's Media library takes and holds, for the library's screen. */
export type MediaOverview = {
	/** The largest file an upload, a replacement or an import may be (Install settings › Storage). */
	maxFileBytes: number;
	/** The Workspace's Media storage: what its Sites take, and its quota if Staff set one. */
	storage: MediaStorage;
	/** How many files are in the Site's Trash. */
	trash: { count: number };
	/** Whether "Suggest alt text" is offered: the Workspace has an AI key. */
	altTextSuggestions: boolean;
};

/**
 * Putting a file in the Trash, in two steps: the first answers where it is used and a confirmation
 * id; the second, with the id, puts it there.
 */
export type MediaTrashing =
	| { trashed: false; usedIn: MediaUse[]; confirmation: Confirmation }
	| { trashed: true; media: MediaItem };

/** Deleting a file in the Trash for good, in two steps like putting it there. */
export type MediaDeletion = { deleted: false; usedIn: MediaUse[]; confirmation: Confirmation } | { deleted: true };

/** Emptying the Trash, in two steps: the first answers how many files it holds. */
export type TrashEmptying =
	| { emptied: false; count: number; confirmation: Confirmation }
	| { emptied: true; count: number };

/** A file as it was uploaded. */
export type NewUpload = {
	fileName: string;
	data: Uint8Array;
	folderId?: string | null;
	/** The host Import from URL fetched it from, recorded in the Audit log (`media.import`). */
	importedFrom?: string;
};

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
	/**
	 * Import from URL: fetches the file at a public address through the guarded fetcher (refusing
	 * addresses inside a network after DNS and after each redirect, at most 3 redirects, 30 seconds,
	 * the Install's largest file), then takes it exactly as an upload.
	 */
	importUrl(scope: SiteScope, address: string, options?: { folderId?: string | null }): Promise<MediaItem>;
	list(scope: SiteScope, query?: MediaQuery): Promise<{ items: MediaItem[]; total: number }>;
	get(scope: SiteScope, mediaId: string, language?: string): Promise<MediaItem>;
	/** Changes texts or the folder: a person's own upload, or any with `media.manage`. */
	update(scope: SiteScope, mediaId: string, change: MediaChange): Promise<MediaItem>;
	/**
	 * Replace file: gives an item a new file of the same kind, keeping its id, texts and every use. An
	 * image is cleaned by the worker first; until then the current file is served. The file it
	 * replaced is still served for 30 days. Your own upload, or any with `media.manage`.
	 */
	replace(scope: SiteScope, mediaId: string, upload: { fileName: string; data: Uint8Array }): Promise<MediaItem>;
	/** Every place a file is used on the Site (Used in). */
	usage(scope: SiteScope, mediaId: string): Promise<MediaUse[]>;
	/**
	 * Puts a file in the Trash, in two steps (`confirmation` from the first): your own upload, or
	 * any with `media.manage`. Pages stop showing it at once; it is deleted for good after 30 days.
	 */
	trash(scope: SiteScope, mediaId: string, confirmation?: string): Promise<MediaTrashing>;
	/** Takes a file out of the Trash, as it was: your own upload, or any with `media.manage`. */
	restore(scope: SiteScope, mediaId: string): Promise<MediaItem>;
	/** Deletes a file in the Trash for good, in two steps: your own upload, or any with `media.manage`. */
	deleteForever(scope: SiteScope, mediaId: string, confirmation?: string): Promise<MediaDeletion>;
	/** Deletes every file in the Trash for good, in two steps. Open the Site with `media.manage`. */
	emptyTrash(scope: SiteScope, confirmation?: string): Promise<TrashEmptying>;
	/** An original or variant by the name it is served under, or null (files in the Trash too, for the admin). */
	file(scope: SiteScope, name: string): Promise<StoredMediaFile | null>;
	/**
	 * What the library takes and holds: the largest file, the Workspace's storage, the Trash, and
	 * whether alt text can be suggested. `workspace` is the Site's Workspace, for its AI key.
	 */
	overview(scope: SiteScope, workspace: WorkspaceScope): Promise<MediaOverview>;
	/**
	 * Suggest alt text: an AI provider describes an image in `language`, with the Workspace's AI key
	 * (`workspace`, the Site's Workspace). Nothing is saved. Your own upload, or any with `media.manage`.
	 */
	suggestAltText(scope: SiteScope, mediaId: string, language?: string): Promise<string>;
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
	/** AI providers, for "Suggest alt text". */
	ai: AiProviders;
	/** The AI keys calls go through, with what they cost. */
	aiKeys: AiKeys;
	/** The guarded fetcher Import from URL uses, allowed files up to the largest an Install may take. */
	fetch: GuardedFetch;
	/** How long Import from URL waits: `MEDIA_IMPORT_TIMEOUT_MS` unless given (tests wait less). */
	importTimeoutMs?: number;
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

	const folderCount = async (scope: SiteScope, folderId: string) =>
		scope.count(media, and(eq(media.folderId, folderId), isNull(media.trashedAt)));

	const saveFolderName = async <Result>(save: () => Promise<Result>) => {
		try {
			return await save();
		} catch (error) {
			if (isUniqueViolation(error, "media_folders_site_id_name_unique")) throw new MediaFolderTakenError();
			throw error;
		}
	};

	/**
	 * A file someone sent, checked: within the largest file, of a format WebCraft takes, named. A raw
	 * upload the worker cleans is kept under `uploadName` (a new item's id) until then.
	 */
	const incoming = async (
		upload: { fileName: string; data: Uint8Array },
		uploadName: string = crypto.randomUUID(),
	): Promise<IncomingFile> => {
		const { maxFileBytes } = await settings.media();
		if (upload.data.length > maxFileBytes) throw new MediaTooLargeError(maxFileBytes);
		const sniffed = sniff(upload.data);
		if ("refused" in sniffed) throw new MediaTypeRefusedError(sniffed.refused);
		const { format } = sniffed;
		const fileName = cleanFileName(upload.fileName);
		// Images are cleaned by the worker before anyone sees them (they may carry GPS data): until then
		// the upload is kept apart, and never served.
		const clean = format.handling === "clean";
		const name = clean ? uploadName : servedName(await contentHash(upload.data), fileName, format.extension);
		return {
			data: upload.data,
			format,
			fileName,
			clean,
			name,
			folder: clean ? "uploads" : "media",
			size: format.format === "gif" ? gifSize(upload.data) : undefined,
			target: await storage.current(),
		};
	};

	/**
	 * Stores an incoming file in the Site's folder and records it with `record`, in one transaction,
	 * within the Workspace's quota; a file refused once stored is removed again. Answers what `record`
	 * answers.
	 */
	const store = async <Result>(
		scope: SiteScope,
		file: IncomingFile,
		record: (tx: SiteScope) => Promise<Result>,
	): Promise<Result> => {
		const key = keyOf(scope, file);
		// Refused before anything is stored when it plainly doesn't fit.
		const shared = await keyIsStored(scope, file.target.kind, key);
		await assertRoom(scope.db, scope.workspace.id, shared ? 0 : file.data.length);
		await file.target.put(key, file.data, file.format.contentType);
		let result: Result;
		try {
			result = await scope.transaction(async (tx) => {
				// Checked again with the quota held, now that the file is stored: two uploads at once can't
				// both squeeze past it. A file that already shares stored bytes adds none.
				const adds = (await keyIsStored(tx, file.target.kind, key)) ? 0 : file.data.length;
				await assertRoom(tx.db, tx.workspace.id, adds, { lock: true });
				return record(tx);
			});
		} catch (error) {
			await forgetStored(scope, file.target, key);
			throw error;
		}
		await noticeQuotaUse(scope.db, noticePorts, scope.workspace);
		return result;
	};

	const library: MediaLibrary = {
		async upload(scope, upload) {
			const folderId = upload.folderId ? (await findFolder(scope, upload.folderId)).id : null;
			const id = crypto.randomUUID();
			const file = await incoming(upload, id);
			await store(scope, file, async (tx) => {
				const now = tx.now();
				await tx.insert(media, {
					id,
					folderId,
					kind: file.format.kind,
					fileName: file.fileName,
					contentType: file.format.contentType,
					sizeBytes: file.data.length,
					width: file.size?.width ?? null,
					height: file.size?.height ?? null,
					status: file.clean ? "processing" : "ready",
					uploadedBy: actingPerson(tx.access.actor),
					createdAt: now,
					updatedAt: now,
				});
				await tx.insert(mediaFiles, fileRow(tx, file, id, now));
				const details = { mediaId: id, fileName: file.fileName, contentType: file.format.contentType };
				if (upload.importedFrom) await tx.audit("media.import", { ...details, host: upload.importedFrom });
				else await tx.audit("media.upload", details);
			});
			if (file.clean) await jobs.send(mediaProcess, { siteId: scope.site.id, mediaId: id });
			return get(scope, id);
		},

		async importUrl(scope, address, importOptions = {}) {
			const folderId = importOptions.folderId ? (await findFolder(scope, importOptions.folderId)).id : null;
			const { maxFileBytes } = await settings.media();
			const fetched = await fetchForImport(
				options.fetch,
				address,
				{ maxBytes: maxFileBytes, timeoutMs: options.importTimeoutMs ?? MEDIA_IMPORT_TIMEOUT_MS },
				options.log,
			);
			return library.upload(scope, { ...fetched, folderId, importedFrom: fetched.host });
		},

		async replace(scope, mediaId, upload) {
			// Refused before anything is stored when the person may not, or the file isn't the right kind.
			const current = await changeable(scope, mediaId);
			const file = await incoming(upload);
			assertReplaceable(current, file);
			const waiting = await store(scope, file, async (tx) => {
				const row = await changeable(tx, mediaId);
				assertReplaceable(row, file);
				const now = tx.now();
				// A replacement still waiting for the worker gives way to this one.
				const earlier = await tx.select(mediaFiles, and(eq(mediaFiles.mediaId, row.id), eq(mediaFiles.role, "upload")));
				await tx.delete(mediaFiles, and(eq(mediaFiles.mediaId, row.id), eq(mediaFiles.role, "upload")));
				// A file served as it is replaces the current one at once, which stays served for 30 days.
				if (!file.clean) await retireFiles(tx, row.id);
				await tx.insert(mediaFiles, fileRow(tx, file, row.id, now));
				if (file.clean) {
					// Visitors keep getting the current file until the worker has cleaned the new one.
					await tx.update(
						media,
						{
							fileName: file.fileName,
							status: row.status === "ready" ? "ready" : "processing",
							failure: null,
							updatedAt: now,
						},
						eq(media.id, row.id),
					);
				} else {
					await tx.update(
						media,
						{
							fileName: file.fileName,
							contentType: file.format.contentType,
							sizeBytes: file.data.length,
							width: file.size?.width ?? null,
							height: file.size?.height ?? null,
							status: "ready",
							failure: null,
							updatedAt: now,
						},
						eq(media.id, row.id),
					);
					await clearPageCache(tx);
				}
				await tx.audit("media.replace", {
					mediaId: row.id,
					fileName: file.fileName,
					contentType: file.format.contentType,
				});
				return earlier;
			});
			await removeUnusedFiles(scope, storage, waiting);
			if (file.clean) await jobs.send(mediaProcess, { siteId: scope.site.id, mediaId });
			return get(scope, mediaId);
		},

		async list(scope, query = {}) {
			const { language, defaultLanguage } = await mediaLanguages(scope, query.language);
			const conditions: SQL[] = [query.trash ? isNotNull(media.trashedAt) : isNull(media.trashedAt)];
			if (query.folderId === "none") conditions.push(isNull(media.folderId));
			else if (query.folderId !== undefined)
				conditions.push(eq(media.folderId, (await findFolder(scope, query.folderId)).id));
			if (query.kind) conditions.push(eq(media.kind, query.kind));
			const search = query.search?.trim();
			if (search) conditions.push(matching(search));
			const where = and(...conditions);
			const rows = await scope.db
				.select()
				.from(media)
				.where(scope.where(media, where))
				.orderBy(...(query.trash ? [desc(media.trashedAt)] : []), desc(media.createdAt), asc(media.id))
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
				if (row.trashedAt) throw new MediaInTrashError();

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
				let focal = { focalX: row.focalX, focalY: row.focalY };
				if (change.focalPoint !== undefined) {
					if (change.focalPoint !== null && row.kind !== "image") {
						throw new MediaInvalidError([{ at: "focalPoint", message: "Only images have a Focal point." }]);
					}
					const next = change.focalPoint
						? { focalX: change.focalPoint.x, focalY: change.focalPoint.y }
						: { focalX: null, focalY: null };
					if (next.focalX !== row.focalX || next.focalY !== row.focalY) {
						focal = next;
						changed.push("focalPoint");
					}
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
				await tx.update(media, { texts, folderId, ...focal, updatedAt: tx.now() }, eq(media.id, row.id));
				await tx.audit("media.update", { mediaId: row.id, changed });
				// Texts such as alt text, and the Focal point, show on published pages: they change at once, with no Draft.
				if (changed.some((key) => key !== "folder")) await clearPageCache(tx);
			});
			return get(scope, mediaId, language);
		},

		usage: (scope, mediaId) => mediaUses(scope, mediaId),

		async trash(scope, mediaId, confirmation) {
			const trashed = await scope.transaction(async (tx) => {
				const row = await changeable(tx, mediaId);
				if (row.trashedAt) throw new MediaInTrashError();
				const request = { action: "media.trash", target: row.id, preview: { usedIn: await mediaUses(tx, row.id) } };
				if (confirmation === undefined) {
					return { trashed: false as const, ...request.preview, confirmation: await askConfirmation(tx, request) };
				}
				await useConfirmation(tx, confirmation, request);
				await tx.update(
					media,
					{ trashedAt: tx.now(), trashedBy: actingPerson(tx.access.actor), updatedAt: tx.now() },
					eq(media.id, row.id),
				);
				await tx.audit("media.trash", { mediaId: row.id, fileName: row.fileName });
				// Pages showing it stop at once; nothing else changes until it is deleted for good.
				await clearPageCache(tx);
				return null;
			});
			return trashed ?? { trashed: true, media: await get(scope, mediaId) };
		},

		async restore(scope, mediaId) {
			await scope.transaction(async (tx) => {
				const row = await changeable(tx, mediaId);
				if (!row.trashedAt) throw new MediaNotInTrashError();
				await tx.update(media, { trashedAt: null, trashedBy: null, updatedAt: tx.now() }, eq(media.id, row.id));
				await tx.audit("media.restore", { mediaId: row.id, fileName: row.fileName });
				await clearPageCache(tx);
			});
			return get(scope, mediaId);
		},

		async deleteForever(scope, mediaId, confirmation) {
			const result = await scope.transaction(async (tx) => {
				const row = await changeable(tx, mediaId);
				if (!row.trashedAt) throw new MediaNotInTrashError();
				const request = {
					action: "media.deleteForever",
					target: row.id,
					preview: { usedIn: await mediaUses(tx, row.id) },
				};
				if (confirmation === undefined) {
					return { deleted: false as const, ...request.preview, confirmation: await askConfirmation(tx, request) };
				}
				await useConfirmation(tx, confirmation, request);
				const files = await deleteForGood(tx, [row.id]);
				await tx.audit("media.deleteForever", { mediaId: row.id, fileName: row.fileName });
				return { deleted: true as const, files };
			});
			if (!result.deleted) return result;
			await removeUnusedFiles(scope, storage, result.files);
			await noticeQuotaUse(scope.db, noticePorts, scope.workspace);
			return { deleted: true };
		},

		async emptyTrash(scope, confirmation) {
			const result = await scope.transaction(async (tx) => {
				const rows = await tx.db
					.select({ id: media.id })
					.from(media)
					.where(tx.where(media, isNotNull(media.trashedAt)))
					.orderBy(asc(media.id))
					.for("update");
				const ids = rows.map((row) => row.id);
				const request = { action: "mediaTrash.empty", target: tx.site.id, preview: { ids } };
				if (confirmation === undefined) {
					return { emptied: false as const, count: ids.length, confirmation: await askConfirmation(tx, request) };
				}
				await useConfirmation(tx, confirmation, request);
				const files = await deleteForGood(tx, ids);
				await tx.audit("mediaTrash.empty", { count: ids.length });
				return { emptied: true as const, count: ids.length, files };
			});
			if (!result.emptied) return result;
			await removeUnusedFiles(scope, storage, result.files);
			await noticeQuotaUse(scope.db, noticePorts, scope.workspace);
			return { emptied: true, count: result.count };
		},

		async file(scope, name) {
			return storedFile(scope, storage, name, { trashed: true });
		},

		async overview(scope, workspace) {
			const { maxFileBytes } = await settings.media();
			return {
				maxFileBytes,
				storage: await mediaStorage(scope.db, scope.workspace.id),
				trash: { count: await scope.count(media, isNotNull(media.trashedAt)) },
				altTextSuggestions: await canSuggestAltText(options.aiKeys, workspace.workspace.id),
			};
		},

		async suggestAltText(scope, mediaId, language) {
			const row = await changeable(scope, mediaId);
			if (row.trashedAt) throw new MediaInTrashError();
			const item = await get(scope, mediaId, language);
			return suggestAltText({ ai: options.ai, keys: options.aiKeys, storage }, scope, item);
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
					.where(scope.where(media, isNull(media.trashedAt)))
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
	return library;
}

/** Whether a stored file is named by any of the Site's Media files (identical bytes share one). */
async function keyIsStored(scope: Pick<SiteScope, "count">, kind: StorageKind, key: string): Promise<boolean> {
	return (await scope.count(mediaFiles, and(eq(mediaFiles.storage, kind), eq(mediaFiles.key, key)))) > 0;
}

/** Removes a stored file nothing records any more (an upload that was refused once stored). */
async function forgetStored(scope: Pick<SiteScope, "count">, backend: StorageBackend, key: string): Promise<void> {
	if (!(await keyIsStored(scope, backend.kind, key))) await backend.delete(key);
}

/** A file someone sent, checked and named, before it is stored. */
type IncomingFile = {
	data: Uint8Array;
	format: FileFormat;
	fileName: string;
	/** Whether the worker cleans it before anyone sees it (images). */
	clean: boolean;
	/** Its name in storage: a random one for an upload to clean, the name it is served under otherwise. */
	name: string;
	folder: "uploads" | "media";
	size: { width: number; height: number } | undefined;
	target: StorageBackend;
};

function keyOf(scope: Pick<SiteScope, "site">, file: IncomingFile): string {
	return `${siteFolder(scope.site)}/${file.folder}/${file.name}`;
}

/** The row recording an incoming file: the raw `upload` the worker cleans, or the `original` itself. */
function fileRow(scope: Pick<SiteScope, "site">, file: IncomingFile, mediaId: string, now: Date) {
	return {
		mediaId,
		role: file.clean ? "upload" : "original",
		name: file.name,
		format: file.format.format,
		contentType: file.format.contentType,
		width: file.size?.width ?? null,
		height: file.size?.height ?? null,
		sizeBytes: file.data.length,
		storage: file.target.kind,
		key: keyOf(scope, file),
		createdAt: now,
	};
}

/** A file in the Trash isn't replaced, and a file is replaced by one of the same kind. */
function assertReplaceable(row: MediaRow, file: IncomingFile): void {
	if (row.trashedAt) throw new MediaInTrashError();
	if (row.kind !== file.format.kind) throw new MediaReplaceRefusedError("kind");
}

/**
 * A Media item the scope's person may change (their own upload, or any with `media.manage`),
 * locked until the transaction ends.
 */
async function changeable(scope: SiteScope, mediaId: string): Promise<MediaRow> {
	const [row] = isUuid(mediaId)
		? await scope.db
				.select()
				.from(media)
				.where(scope.where(media, eq(media.id, mediaId)))
				.for("update")
		: [];
	if (!row) throw new MediaNotFoundError();
	if (!mayChange(scope, row)) throw new PermissionDeniedError("media.manage");
	return row;
}

/** Whether the scope's person may change a Media item: their own upload, or any with `media.manage`. */
function mayChange(scope: SiteScope, row: Pick<MediaRow, "uploadedBy">): boolean {
	return uploadedBy(row, personIdOf(scope.access.actor)) || canManage(scope);
}

/**
 * Whether `personId` uploaded the item. Fails closed: an actor with no person (a Module) uploaded
 * nothing, even a file whose uploader's account is gone.
 */
function uploadedBy(row: Pick<MediaRow, "uploadedBy">, personId: string | null): boolean {
	return personId !== null && row.uploadedBy === personId;
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
	const files = await scope.select(mediaFiles, and(inArray(mediaFiles.mediaId, ids), isNull(mediaFiles.retiredAt)));
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
			focalPoint: focalPointOf(row),
			trashedAt: row.trashedAt,
			purgeAt: row.trashedAt ? new Date(row.trashedAt.getTime() + TRASH_LIFETIME_MS) : null,
			replacing: row.status === "ready" && own.some((file) => file.role === "upload"),
			failure: (row.failure as MediaFailure | null) ?? null,
			canEdit: manages || uploadedBy(row, personId),
		};
	});
}

/** An item's Focal point, or null. */
export function focalPointOf(row: Pick<MediaRow, "focalX" | "focalY">): FocalPoint | null {
	return row.focalX === null || row.focalY === null ? null : { x: row.focalX, y: row.focalY };
}

/** The URL of a ready item's original (its current one: not one Replace file put aside). */
export function originalUrl(row: Pick<MediaRow, "status">, files: readonly FileRow[]): string | null {
	const original = files.find((file) => file.role === "original" && file.retiredAt === null);
	return row.status === "ready" && original ? `${MEDIA_PATH}${original.name}` : null;
}

/** An image's variants, smallest first, AVIF before WebP at each width. */
export function variantsOf(files: readonly FileRow[]): MediaVariant[] {
	return files
		.filter((file) => file.role === "variant" && file.retiredAt === null && file.width !== null && file.height !== null)
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
	scope: Pick<SiteScope, "db" | "where" | "now">,
	storage: InstallStorage,
	name: string,
	options: { trashed?: boolean } = {},
): Promise<StoredMediaFile | null> {
	if (!SERVED_NAME.test(name)) return null;
	// Visitors never get a file in the Trash (the admin still shows it there). A file Replace file put
	// aside is still served for 30 days, for pages loaded before.
	const replacedSince = new Date(scope.now().getTime() - TRASH_LIFETIME_MS);
	const [found] = await scope.db
		.select({ file: mediaFiles })
		.from(mediaFiles)
		.innerJoin(media, and(eq(media.id, mediaFiles.mediaId), eq(media.siteId, mediaFiles.siteId)))
		.where(
			scope.where(
				mediaFiles,
				and(
					eq(mediaFiles.name, name),
					inArray(mediaFiles.role, ["original", "variant"]),
					or(isNull(mediaFiles.retiredAt), gt(mediaFiles.retiredAt, replacedSince)),
					options.trashed ? undefined : isNull(media.trashedAt),
				),
			),
		)
		// Two items can share a name (identical bytes): either row names the same stored file.
		.orderBy(desc(isNull(mediaFiles.retiredAt)))
		.limit(1);
	const row = found?.file;
	if (!row) return null;
	const backend = await storage.holding(row.storage === "s3" ? "s3" : "disk");
	return {
		contentType: row.contentType,
		size: row.sizeBytes,
		etag: `"${name.slice(0, 16)}"`,
		open: (range) => backend.stream(row.key, range),
	};
}

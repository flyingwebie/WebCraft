import { media, mediaFiles } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { clearPageCache } from "../content/page-cache.ts";
import { defineJob, type JobContext } from "../jobs/define.ts";
import type { BackgroundScope } from "../tenancy/data-layer.ts";
import { type ImageInput, ImageUnreadableError, VARIANT_FORMATS, variantWidths } from "./images.ts";
import { contentHash, servedName } from "./names.ts";
import { fileFormat } from "./sniff.ts";
import { type StorageKind, siteFolder } from "./storage.ts";

const payload = z.object({ siteId: z.uuid(), mediaId: z.uuid() });

/**
 * Cleans an uploaded image in the worker (ADR 0027): strips its metadata (GPS, camera, EXIF, XMP),
 * turns it upright, converts HEIC to JPEG, stores the result as the original visitors get, and
 * removes the raw upload. Then it queues the variants. Until it is done, the image isn't served.
 */
export const mediaProcess = defineJob({
	name: "media.process",
	payload,
	queue: { retryLimit: 5, retryDelay: 30, retryBackoff: true },
	run: ({ siteId, mediaId }, context) => cleanUpload(context, siteId, mediaId),
});

/**
 * Makes the fixed widths of a cleaned image, each in AVIF and WebP, never larger than the original.
 * The original is served alone until they are all stored; then pages switch to `<picture>` at once.
 */
export const mediaVariants = defineJob({
	name: "media.variants",
	payload,
	queue: { retryLimit: 5, retryDelay: 60, retryBackoff: true },
	run: ({ siteId, mediaId }, context) => makeVariants(context, siteId, mediaId),
});

async function cleanUpload(context: JobContext, siteId: string, mediaId: string): Promise<void> {
	const { data, storage, images, log, jobs } = context;
	const scope = await data.background(siteId);
	const row = scope ? await scope.first(media, eq(media.id, mediaId)) : undefined;
	if (!scope || !row) return;
	if (row.status === "ready") {
		// Done before, perhaps by a run that stopped before queueing the variants.
		if (!(await hasVariants(scope, mediaId))) await jobs.send(mediaVariants, { siteId, mediaId });
		return;
	}
	if (row.status !== "processing") return;
	const upload = await scope.first(mediaFiles, and(eq(mediaFiles.mediaId, mediaId), eq(mediaFiles.role, "upload")));
	if (!upload) return;

	const source = await storage.holding(upload.storage as StorageKind);
	const bytes = await source.read(upload.key);
	if (!bytes) {
		log.error("An upload to clean is missing from storage", { siteId, mediaId, key: upload.key });
		await markFailed(scope, mediaId);
		return;
	}
	let prepared: Awaited<ReturnType<typeof images.prepare>>;
	try {
		prepared = await images.prepare(bytes, upload.format as ImageInput);
	} catch (error) {
		if (!(error instanceof ImageUnreadableError)) throw error;
		log.warn("An uploaded image can't be read", { siteId, mediaId, error });
		await markFailed(scope, mediaId);
		await scope.delete(mediaFiles, eq(mediaFiles.id, upload.id));
		await source.delete(upload.key);
		return;
	}

	const format = fileFormat(prepared.format);
	if (!format) throw new Error(`The worker made an image in an unknown format, ${prepared.format}.`);
	const name = servedName(await contentHash(prepared.data), row.fileName, format.extension);
	const key = `${siteFolder(scope.site)}/media/${name}`;
	const target = await storage.current();
	await target.put(key, prepared.data, format.contentType);
	await scope.transaction(async (tx) => {
		const now = tx.now();
		await tx.insert(mediaFiles, {
			mediaId,
			role: "original",
			name,
			format: format.format,
			contentType: format.contentType,
			width: prepared.width,
			height: prepared.height,
			sizeBytes: prepared.data.length,
			storage: target.kind,
			key,
			createdAt: now,
		});
		await tx.delete(mediaFiles, eq(mediaFiles.id, upload.id));
		await tx.update(
			media,
			{
				status: "ready",
				contentType: format.contentType,
				sizeBytes: prepared.data.length,
				width: prepared.width,
				height: prepared.height,
				updatedAt: now,
			},
			eq(media.id, mediaId),
		);
		// Pages that show the image get it at once.
		await clearPageCache(tx);
	});
	await source.delete(upload.key);
	log.info("Cleaned an uploaded image", { siteId, mediaId, width: prepared.width, height: prepared.height });
	await jobs.send(mediaVariants, { siteId, mediaId });
}

async function makeVariants(context: JobContext, siteId: string, mediaId: string): Promise<void> {
	const { data, storage, images, log } = context;
	const scope = await data.background(siteId);
	if (!scope) return;
	const original = await scope.first(mediaFiles, and(eq(mediaFiles.mediaId, mediaId), eq(mediaFiles.role, "original")));
	if (!original || original.width === null || (await hasVariants(scope, mediaId))) return;
	const widths = variantWidths(original.width);
	if (widths.length === 0) return;

	const bytes = await (await storage.holding(original.storage as StorageKind)).read(original.key);
	if (!bytes) throw new Error(`The original ${original.key} is missing from storage.`);
	const row = await scope.first(media, eq(media.id, mediaId));
	if (!row) return;
	const target = await storage.current();
	const made: Omit<typeof mediaFiles.$inferInsert, "workspaceId" | "siteId">[] = [];
	for (const width of widths) {
		for (const format of VARIANT_FORMATS) {
			let variant: Awaited<ReturnType<typeof images.variant>>;
			try {
				variant = await images.variant(bytes, width, format);
			} catch (error) {
				if (!(error instanceof ImageUnreadableError)) throw error;
				log.error("The variants of an image can't be made; its original stays", { siteId, mediaId, error });
				return;
			}
			const name = servedName(await contentHash(variant.data), row.fileName, format, width);
			const key = `${siteFolder(scope.site)}/media/${name}`;
			await target.put(key, variant.data, `image/${format}`);
			made.push({
				mediaId,
				role: "variant",
				name,
				format,
				contentType: `image/${format}`,
				width: variant.width,
				height: variant.height,
				sizeBytes: variant.data.length,
				storage: target.kind,
				key,
				createdAt: scope.now(),
			});
		}
	}
	await scope.transaction(async (tx) => {
		if (await hasVariants(tx, mediaId)) return;
		for (const file of made) await tx.insert(mediaFiles, file);
		await clearPageCache(tx);
	});
	log.info("Made the variants of an image", { siteId, mediaId, widths });
}

async function hasVariants(scope: BackgroundScope, mediaId: string): Promise<boolean> {
	return (await scope.count(mediaFiles, and(eq(mediaFiles.mediaId, mediaId), eq(mediaFiles.role, "variant")))) > 0;
}

async function markFailed(scope: BackgroundScope, mediaId: string): Promise<void> {
	await scope.update(media, { status: "failed", updatedAt: scope.now() }, eq(media.id, mediaId));
}

import type { Database } from "@webcraft/db";
import { mediaFiles } from "@webcraft/db/schema";
import { and, asc, count, countDistinct, eq, notInArray } from "drizzle-orm";

import type { Logger } from "../log.ts";
import type { InstallStorage } from "./install-storage.ts";
import { StorageError, type StorageKind } from "./storage.ts";

/** What `webcraft admin media move` did. */
export type MediaMoveReport = {
	to: StorageKind;
	/** Stored files moved (a file several items share counts once), and their bytes. */
	moved: number;
	bytes: number;
	/** Keys whose file is in neither storage: their items stay as they were, broken before the move too. */
	missing: string[];
	/** Media files the Install still keeps in the other storage (only those missing, once it finished). */
	left: number;
};

/** Why a move can't start. */
export class MediaMoveRefusedError extends Error {
	override name = "MediaMoveRefusedError";
	readonly reason: "newFilesElsewhere" | "noBucket";
	constructor(reason: MediaMoveRefusedError["reason"], to: StorageKind) {
		super(
			reason === "noBucket"
				? "No S3-compatible bucket is set. Set it up in Install settings › Storage first."
				: `New files go to ${to === "s3" ? "local disk" : "the bucket"} (Install settings › Storage). Make the ${to === "s3" ? "bucket" : "local disk"} where new files go first, then move the files already stored, so files uploaded meanwhile land there too.`,
		);
		this.reason = reason;
	}
}

/** How many stored files a move reads at a time. */
const BATCH = 50;

/**
 * Moves every stored Media file (originals, variants and uploads waiting for the worker) to the
 * storage `to`, one stored file at a time: it copies the file, reads it back to check every byte,
 * then points every row naming it at the new storage, and (unless `keepSource`) deletes the old
 * copy. URLs never change: files are served by name, from wherever their row says. Each file is
 * finished before the next starts, so a move that stops (a crash, a network failure) is run again
 * and goes on where it stopped; running it when everything moved does nothing.
 */
export async function moveMediaFiles(
	{ database, storage, log }: { database: Database; storage: InstallStorage; log: Logger },
	{
		to,
		keepSource = false,
		onProgress,
	}: {
		to: StorageKind;
		keepSource?: boolean;
		onProgress?: (progress: { moved: number; total: number; bytes: number }) => void;
	},
): Promise<MediaMoveReport> {
	const { db } = database;
	const settings = await storage.settings();
	if (to === "s3" && !settings.s3) throw new MediaMoveRefusedError("noBucket", to);
	if (settings.kind !== to) throw new MediaMoveRefusedError("newFilesElsewhere", to);
	const from: StorageKind = to === "s3" ? "disk" : "s3";

	const [counted] = await db
		.select({ keys: countDistinct(mediaFiles.key) })
		.from(mediaFiles)
		.where(eq(mediaFiles.storage, from));
	const total = counted?.keys ?? 0;
	const report: MediaMoveReport = { to, moved: 0, bytes: 0, missing: [], left: 0 };
	if (total > 0) {
		const source = await storage.holding(from);
		const target = await storage.holding(to);
		for (;;) {
			const batch = await db
				.selectDistinctOn([mediaFiles.key], { key: mediaFiles.key, contentType: mediaFiles.contentType })
				.from(mediaFiles)
				.where(
					and(
						eq(mediaFiles.storage, from),
						report.missing.length > 0 ? notInArray(mediaFiles.key, report.missing) : undefined,
					),
				)
				.orderBy(asc(mediaFiles.key))
				.limit(BATCH);
			if (batch.length === 0) break;
			for (const { key, contentType } of batch) {
				const bytes = (await source.read(key)) ?? (await target.read(key));
				if (!bytes) {
					log.warn("A Media file is in neither storage: its items stay as they were", { key, from, to });
					report.missing.push(key);
					continue;
				}
				await target.put(key, bytes, contentType);
				const copy = await target.read(key);
				if (!copy || (await digest(copy)) !== (await digest(bytes))) {
					throw new StorageError(
						`The copy of ${key} in the ${to === "s3" ? "bucket" : "local disk"} isn't the same file. Nothing more was moved; run the move again.`,
					);
				}
				await db
					.update(mediaFiles)
					.set({ storage: to })
					.where(and(eq(mediaFiles.storage, from), eq(mediaFiles.key, key)));
				if (!keepSource) await source.delete(key);
				report.moved++;
				report.bytes += bytes.byteLength;
				onProgress?.({ moved: report.moved, total, bytes: report.bytes });
			}
		}
	}
	const [left] = await db.select({ rows: count() }).from(mediaFiles).where(eq(mediaFiles.storage, from));
	report.left = left?.rows ?? 0;
	log.info("Media files were moved", { to, moved: report.moved, bytes: report.bytes, missing: report.missing.length });
	return report;
}

async function digest(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return Buffer.from(hash).toString("hex");
}

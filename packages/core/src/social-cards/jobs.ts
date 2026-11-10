import { entries, sites, socialCards } from "@webcraft/db/schema";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { z } from "zod";
import type { RecordedAuditEntry } from "../audit.ts";
import { siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { defineJob, type JobQueue } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import { StorageError, type StorageKind } from "../media/storage.ts";
import { cardSnapshot } from "./cards.ts";
import { SOCIAL_CARD_MAX_BYTES } from "./renderer.ts";

/** Each retry reads what is published now. No job payload ever contains Draft text or remote asset URLs. */
export const socialCardsRender = defineJob({
	name: "socialCards.render",
	payload: z.object({ siteId: z.uuid(), entryId: z.uuid().optional() }),
	queue: { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 3600 },
	async run({ siteId, entryId }, context) {
		const scope = await context.data.background(siteId);
		if (!scope) return;
		const languages = await siteLanguages(scope);
		const rows = await scope.select(
			entries,
			and(isNotNull(entries.published), entryId ? eq(entries.id, entryId) : undefined),
		);
		for (const row of rows)
			for (const language of languages.languages) {
				const snapshot = await cardSnapshot(scope, row.id, language.code);
				if (!snapshot) continue;
				const where = and(
					eq(socialCards.entryId, row.id),
					eq(socialCards.language, language.code),
					eq(socialCards.hash, snapshot.hash),
				);
				if (await scope.count(socialCards, where)) continue;
				let logo: Uint8Array | null = null;
				try {
					if (snapshot.logo)
						logo = await (await context.storage.holding(snapshot.logo.storage as StorageKind)).read(snapshot.logo.key);
				} catch (error) {
					if (!(error instanceof StorageError)) throw error;
					context.log.warn("A Social card logo couldn't be read from storage", {
						siteId,
						entryId: row.id,
						language: language.code,
						error,
					});
					// Keep the existing social fallback; hourly reconciliation retries when storage recovers.
					continue;
				}
				if (snapshot.logo && !logo) throw new Error("The Social card logo is missing from storage.");
				const png = await context.socialCardRenderer.render({ ...snapshot.input, logo });
				if (
					png.length > SOCIAL_CARD_MAX_BYTES ||
					Buffer.from(png.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a"
				)
					throw new Error("The Social card renderer returned an invalid PNG.");
				await scope.transaction(async (tx) => {
					// It may have changed, been deleted or unpublished while rendering. Immutable keys prevent stale overwrites even across this check.
					const current = await cardSnapshot(tx, row.id, language.code);
					if (current?.hash !== snapshot.hash) return;
					await tx.db
						.insert(socialCards)
						.values({
							workspaceId: scope.site.workspaceId,
							siteId,
							entryId: row.id,
							language: language.code,
							hash: snapshot.hash,
							png: Buffer.from(png),
							createdAt: tx.now(),
						})
						.onConflictDoNothing();
					await clearPageCache(tx);
				});
			}
		// Keep replaced renders for 30 days for cache reuse; current versions are never aged out.
		for (const old of await scope.select(
			socialCards,
			lt(socialCards.createdAt, new Date(scope.now().getTime() - 30 * 86400000)),
		)) {
			const current = await cardSnapshot(scope, old.entryId, old.language);
			if (current?.hash !== old.hash) await scope.delete(socialCards, eq(socialCards.id, old.id));
		}
	},
});

/** Recover lost enqueue attempts or a renderer upgrade, using the same published inputs and cache. */
export const socialCardsReconcile = defineJob({
	name: "socialCards.reconcile",
	payload: z.object({}),
	queue: { retryLimit: 3, retryDelay: 60 },
	async run(_payload, context) {
		// Install-wide enumeration only; every content read happens in the background Site scope.
		for (const site of await context.database.db.select({ id: sites.id }).from(sites))
			await context.jobs.send(socialCardsRender, { siteId: site.id });
	},
});
export const socialCardsReconcileSchedule = defineSchedule({
	job: socialCardsReconcile,
	cron: "23 * * * *",
	payload: {},
});

export function socialCardsAfterAudit(jobs: JobQueue) {
	return async (entry: RecordedAuditEntry): Promise<void> => {
		if (!entry.siteId) return;
		if (entry.action === "entry.publish") {
			await jobs.send(socialCardsRender, {
				siteId: entry.siteId,
				entryId: typeof entry.details.entryId === "string" ? entry.details.entryId : undefined,
			});
		} else if (entry.action === "translation.publish") {
			const item = z.object({ kind: z.literal("entry"), id: z.uuid() }).safeParse(entry.details.item);
			if (item.success) await jobs.send(socialCardsRender, { siteId: entry.siteId, entryId: item.data.id });
		} else if (
			[
				"seoSettings.change",
				"postType.update",
				"designSystem.publish",
				"site.update",
				"defaultLanguage.change",
			].includes(entry.action) ||
			entry.action.startsWith("language.") ||
			entry.action.startsWith("media.")
		) {
			await jobs.send(socialCardsRender, { siteId: entry.siteId });
		}
	};
}

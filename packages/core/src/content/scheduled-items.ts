import { scheduledPublishes, scheduledPublishItems } from "@webcraft/db/schema";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { draftVersion } from "./json.ts";
import type { PublishItem } from "./publishing.ts";

/**
 * The rows of Scheduled publishes that name items, kept apart from `scheduled-publishes.ts` so that
 * publishing (which every Scheduled publish goes through) can use them without importing it.
 */

/** What a Scheduled publish does at its time: publish its items' frozen versions, or unpublish an Entry. */
export type ScheduleAction = "publish" | "unpublish";

/** The id an item's rows carry: its own, or null for the items a Site has one of. */
export function scheduledItemId(item: PublishItem): string | null {
	return "id" in item ? item.id : null;
}

/** The condition naming one item's rows among a Site's Scheduled publish items. */
export function scheduledItemWhere(item: PublishItem, action: ScheduleAction): SQL {
	const id = scheduledItemId(item);
	return and(
		eq(scheduledPublishItems.action, action),
		eq(scheduledPublishItems.itemKind, item.kind),
		id === null ? isNull(scheduledPublishItems.itemId) : eq(scheduledPublishItems.itemId, id),
	) as SQL;
}

/**
 * Takes items just published now (by themselves, or by Publish all) out of the Scheduled publishes
 * they waited in: a newer version is live already, so publishing the older one later would take it
 * back. A Scheduled publish of that one item is cancelled; a Publish all set goes on with the rest,
 * and is cancelled once nothing is left in it. Each change is in the Audit log
 * (`scheduledPublish.change` or `scheduledPublish.cancel`, with `reason: "published"`). An Entry's
 * scheduled unpublish stays: publishing it doesn't change when it should stop showing.
 */
export async function leaveScheduledPublishes(scope: SiteScope, items: readonly PublishItem[]): Promise<void> {
	for (const item of items) {
		const removed = await scope.db
			.delete(scheduledPublishItems)
			.where(scope.where(scheduledPublishItems, scheduledItemWhere(item, "publish")))
			.returning({ scheduleId: scheduledPublishItems.scheduleId });
		for (const row of removed) {
			if ((await scope.count(scheduledPublishItems, eq(scheduledPublishItems.scheduleId, row.scheduleId))) > 0) {
				await scope.update(scheduledPublishes, { updatedAt: scope.now() }, eq(scheduledPublishes.id, row.scheduleId));
				await scope.audit("scheduledPublish.change", {
					scheduleId: row.scheduleId,
					removed: [item],
					reason: "published",
				});
				continue;
			}
			const [schedule] = await scope.db
				.delete(scheduledPublishes)
				.where(scope.where(scheduledPublishes, eq(scheduledPublishes.id, row.scheduleId)))
				.returning();
			if (schedule) {
				await scope.audit("scheduledPublish.cancel", {
					scheduleId: schedule.id,
					action: schedule.action,
					at: schedule.at.toISOString(),
					items: [item],
					reason: "published",
				});
			}
		}
	}
}

/** Whether a Scheduled publish is one item's or a Publish all set ("Publish all at…"). */
export type ScheduleKind = "item" | "set";

/**
 * An Entry's Scheduled publishes, as the Entry's answer carries them: the one publishing it (with
 * whether its Draft has changed since it was scheduled: later edits stay in the Draft) and the one
 * unpublishing it, each null when there is none.
 */
export type EntrySchedule = {
	publish: { id: string; at: Date; kind: ScheduleKind; changedSinceScheduled: boolean } | null;
	unpublish: { id: string; at: Date } | null;
};

/** No Scheduled publish at all. */
export const NOT_SCHEDULED: EntrySchedule = { publish: null, unpublish: null };

/** The Scheduled publishes of these Entries, by id, in one query. */
export async function entrySchedules(
	scope: SiteScope,
	rows: readonly { id: string; draft: unknown }[],
): Promise<Map<string, EntrySchedule>> {
	const found = new Map<string, EntrySchedule>();
	if (rows.length === 0) return found;
	const waiting = await scope.db
		.select({
			id: scheduledPublishes.id,
			at: scheduledPublishes.at,
			kind: scheduledPublishes.kind,
			action: scheduledPublishItems.action,
			entryId: scheduledPublishItems.itemId,
			version: scheduledPublishItems.version,
		})
		.from(scheduledPublishItems)
		.innerJoin(scheduledPublishes, eq(scheduledPublishes.id, scheduledPublishItems.scheduleId))
		.where(
			scope.where(
				scheduledPublishItems,
				and(
					eq(scheduledPublishItems.itemKind, "entry"),
					inArray(
						scheduledPublishItems.itemId,
						rows.map((row) => row.id),
					),
				),
			),
		);
	for (const row of rows) {
		const mine = waiting.filter((each) => each.entryId === row.id);
		const publish = mine.find((each) => each.action === "publish");
		const unpublish = mine.find((each) => each.action === "unpublish");
		if (!publish && !unpublish) continue;
		found.set(row.id, {
			publish: publish
				? {
						id: publish.id,
						at: publish.at,
						kind: publish.kind === "set" ? "set" : "item",
						changedSinceScheduled: publish.version !== draftVersion(row.draft),
					}
				: null,
			unpublish: unpublish ? { id: unpublish.id, at: unpublish.at } : null,
		});
	}
	return found;
}

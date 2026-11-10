import type { Database } from "@webcraft/db";
import { entries, scheduledPublishes, scheduledPublishItems } from "@webcraft/db/schema";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";

import { type AuditVia, clientNameOf, recordAudit } from "../audit.ts";
import type { Clock } from "../clock.ts";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { isSerializationFailure, isUniqueViolation } from "../db-errors.ts";
import type { Email } from "../email/index.ts";
import { peopleNames, storedVia } from "../history/attribution.ts";
import { itemState } from "../history/items.ts";
import { isUuid } from "../ids.ts";
import type { Logger } from "../log.ts";
import { can, type PersonActor, personIdOf } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import type { BackgroundScope, DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import type { ComponentSources } from "./components.ts";
import { draftVersion } from "./json.ts";
import { orderForPublish, PublishAllInvalidError, PublishAllRefusedError, siteDrafts } from "./publish-all.ts";
import { type PublishItem, publishItems, publishPermission, requirePublishPermissions } from "./publishing.ts";
import { reopenReviewsOfSchedule, reviewItemOf, reviewsOnSchedule } from "./review-items.ts";
import { type ScheduleAction, type ScheduleKind, scheduledItemId, scheduledItemWhere } from "./scheduled-items.ts";
import { unpublishEntry } from "./unpublishing.ts";

/**
 * Scheduled publishes (GLOSSARY.md › Scheduled publish, spec story 46): a publish set to happen at a
 * later time, of one item or a Publish all set ("Publish all at…"), or an Entry's unpublish.
 *
 * - **A frozen version**: scheduling holds each item's Draft as its table stores it then (every
 *   language) with its version (`draftVersion`). At the time, exactly that is published through
 *   `publishItems`, so Revisions, Webhooks, the page cache, Module events and Automatic translation
 *   follow as for any publish. Later edits stay in the Draft; the item shows "Changed since
 *   scheduled" until the person takes the current Draft into it (`updateScheduled`) or it runs.
 * - **Checked when scheduled**: the frozen versions are published once in a transaction that is
 *   rolled back, so what couldn't be published now is refused now (with the reason publishing would
 *   give), not by email later. What it needs must be published first or scheduled with it.
 * - **Who and how**: whoever may publish the items schedules them (`publishPermission`: Authors
 *   can't); at the time, WebCraft publishes on behalf of the person who scheduled it, with their
 *   access as it is then (`via: { kind: "scheduledPublish" }`).
 * - **All or none**: a run that can't publish every item publishes none of them (one transaction, as
 *   Publish all), is removed, and the person who scheduled it gets the `scheduled-publish-failed`
 *   email saying what stopped it.
 * - **Once**: the worker holds a Scheduled publish's row while it runs it (`for update skip locked`)
 *   and deletes it in the same transaction, so two workers never run it twice.
 */

/** How far ahead a time may be, and when a run counts as late. */
export const SCHEDULE_LIMITS = {
	/** At most ten years ahead. */
	maxAheadMs: 3650 * 24 * 60 * 60_000,
	/** The worker looks every minute: a run more than two minutes after its time ran late (the worker was down). */
	lateAfterMs: 2 * 60_000,
	/** How many times a run Postgres gave up on (a deadlock) is tried again, a minute apart, before it fails. */
	maxAttempts: 5,
	/** How many due Scheduled publishes one look runs. */
	batch: 50,
} as const;

/** One item of a Scheduled publish, as the admin and API clients see it. */
export type ScheduledItem = {
	item: PublishItem;
	/** Its name, as Publish all names it (an Entry's title in the Default language); null for the rest. */
	name: string | null;
	postType: { id: string; name: string } | null;
	templateKind: string | null;
	scriptKind: "site" | "page" | null;
	/** Its Draft differs from the version it will publish: later edits stay in the Draft. */
	changedSinceScheduled: boolean;
	/** It was deleted since it was scheduled: the Scheduled publish will fail unless it is taken out. */
	missing: boolean;
};

/** A Scheduled publish waiting for its time. */
export type ScheduledPublish = {
	id: string;
	action: ScheduleAction;
	kind: ScheduleKind;
	/** When it runs, in UTC. */
	at: Date;
	/** In the order they go live. */
	items: ScheduledItem[];
	/** Who scheduled it, and the API client or AI client they did it through; null once they are gone. */
	createdBy: { id: string; name: string; via: string | null } | null;
	createdAt: Date;
	updatedAt: Date;
	/** Whether the person may change its time, take the current Drafts into it, or cancel it: they may publish every item of it. */
	canChange: boolean;
};

/** "Publish all at…"'s first call: what would be scheduled, in the order it would go live, and the id that confirms it. */
export type ScheduleAllPreview = {
	scheduled: false;
	preview: { at: Date; items: { item: PublishItem; name: string | null; status: "new" | "changed" }[] };
	confirmation: Confirmation;
};

/** "Publish all at…"'s second call: the Scheduled publish made. */
export type ScheduleAllDone = { scheduled: ScheduledPublish };

/** Why a time or a Scheduled publish is refused. */
export type ScheduleProblem = "past" | "tooFar" | "notAnEntry" | "nothingToTake";

export class ScheduleInvalidError extends Error {
	override name = "ScheduleInvalidError";
	readonly reason: ScheduleProblem;
	constructor(reason: ScheduleProblem) {
		super(
			reason === "past"
				? "Choose a time in the future."
				: reason === "tooFar"
					? "Choose a time within the next ten years."
					: reason === "notAnEntry"
						? "Only Entries and Pages can be scheduled to unpublish."
						: "An unpublish has no Draft to take: it only ends the Entry's pages.",
		);
		this.reason = reason;
	}
}

/** The item already waits in a Scheduled publish of the same action: change or cancel that one instead. */
export class ItemAlreadyScheduledError extends Error {
	override name = "ItemAlreadyScheduledError";
	readonly item: PublishItem;
	readonly scheduleId: string;
	readonly at: Date;
	constructor(item: PublishItem, scheduleId: string, at: Date) {
		super("This is already scheduled. Change or cancel that Scheduled publish instead.");
		this.item = item;
		this.scheduleId = scheduleId;
		this.at = at;
	}
}

export class ScheduledPublishNotFoundError extends Error {
	override name = "ScheduledPublishNotFoundError";
	constructor() {
		super("There is no such Scheduled publish on this Site: it may have run or been cancelled.");
	}
}

/** The action "Publish all at…"'s confirmations are for. */
const SCHEDULE_ALL_ACTION = "site.schedulePublishAll";

/** One item frozen for a Scheduled publish: its Draft as its table stores it, that Draft's version, and its name then. */
type Frozen = { item: PublishItem; content: unknown; version: string | null; name: string | null };

type Row = typeof scheduledPublishes.$inferSelect;
type ItemRow = typeof scheduledPublishItems.$inferSelect;

/** Reads an item row back as publishing names it. */
function itemOf(row: Pick<ItemRow, "itemKind" | "itemId">): PublishItem {
	return (row.itemId === null ? { kind: row.itemKind } : { kind: row.itemKind, id: row.itemId }) as PublishItem;
}

function itemKey(item: PublishItem): string {
	return `${item.kind}:${scheduledItemId(item) ?? ""}`;
}

/** Refuses a time in the past (or this very moment) and one more than ten years ahead. */
export function checkScheduleTime(at: Date, now: Date): void {
	if (Number.isNaN(at.getTime()) || at.getTime() <= now.getTime()) throw new ScheduleInvalidError("past");
	if (at.getTime() - now.getTime() > SCHEDULE_LIMITS.maxAheadMs) throw new ScheduleInvalidError("tooFar");
}

/** Each item's Draft now, frozen. Refuses an item that isn't the Site's with its own not-found error. */
async function freeze(scope: SiteScope, items: readonly PublishItem[]): Promise<Frozen[]> {
	const frozen: Frozen[] = [];
	for (const item of items) {
		const { draft, summary } = await itemState(scope, item);
		frozen.push({ item, content: draft, version: draftVersion(draft), name: summary.name });
	}
	return frozen;
}

/** Thrown to roll a check back. */
class RolledBack extends Error {}

/**
 * Runs `work` in a transaction of its own and rolls it back, answering what `work` answered: how
 * scheduling checks that the frozen versions could be published, by publishing them. Nothing it did
 * stays, and nothing waiting for the commit (Webhooks, Module events, AI translation) hears of it.
 * Open `scope` outside a transaction.
 */
async function rolledBack<Result>(scope: SiteScope, work: (tx: SiteScope) => Promise<Result>): Promise<Result> {
	let result: Result | undefined;
	try {
		await scope.transaction(async (tx) => {
			result = await work(tx);
			throw new RolledBack();
		});
	} catch (error) {
		if (!(error instanceof RolledBack)) throw error;
	}
	return result as Result;
}

/** A frozen set's refusal, as Publish all words it: which item stopped them all. */
function setRefusal(names: ReadonlyMap<string, string | null>) {
	return (item: PublishItem, error: unknown) =>
		new PublishAllRefusedError(item, names.get(itemKey(item)) ?? null, error);
}

/** Checks the frozen versions could be published now, in their order, publishing nothing. */
async function checkPublishable(
	scope: SiteScope,
	frozen: readonly Frozen[],
	sources: ComponentSources,
	refusal?: (item: PublishItem, error: unknown) => Error,
): Promise<void> {
	const versions = new Map(frozen.map((each) => [itemKey(each.item), each.content]));
	await rolledBack(scope, (tx) =>
		publishItems(
			tx,
			frozen.map((each) => each.item),
			sources,
			refusal,
			(item) => versions.get(itemKey(item)),
		),
	);
}

/** Saves a new Scheduled publish and its items, refusing an item already waiting in one of the same action. */
async function insertSchedule(
	scope: SiteScope,
	input: { action: ScheduleAction; kind: ScheduleKind; at: Date; frozen: readonly Frozen[] },
): Promise<string> {
	return scope.transaction(async (tx) => {
		await refuseScheduledAlready(tx, input.action, input.frozen);
		const now = tx.now();
		const personId = personIdOf(tx.access.actor);
		const row = await tx.insert(scheduledPublishes, {
			action: input.action,
			kind: input.kind,
			at: input.at,
			createdBy: personId,
			createdVia: tx.access.via,
			createdAt: now,
			updatedBy: personId,
			updatedAt: now,
		});
		await insertItems(tx, row.id, input.action, input.frozen);
		// Items In review are scheduled from their Review: it ends, and their Author is told when.
		if (input.action === "publish") {
			await reviewsOnSchedule(
				tx,
				input.frozen.map((each) => each.item),
				input.at,
				row.id,
			);
		}
		await tx.audit("scheduledPublish.create", {
			scheduleId: row.id,
			action: input.action,
			kind: input.kind,
			at: input.at.toISOString(),
			items: input.frozen.map((each) => each.item),
			count: input.frozen.length,
		});
		return row.id;
	});
}

/**
 * Saves a new Scheduled publish (`save`, outside a transaction), answering `ItemAlreadyScheduledError`
 * when another one took one of its items at the same moment (the unique index refused it).
 */
async function saveRefusingScheduledAlready<Result>(
	scope: SiteScope,
	action: ScheduleAction,
	frozen: readonly Frozen[],
	save: () => Promise<Result>,
): Promise<Result> {
	try {
		return await save();
	} catch (error) {
		if (isUniqueViolation(error, "scheduled_publish_items_item_unique")) {
			await refuseScheduledAlready(scope, action, frozen);
		}
		throw error;
	}
}

async function refuseScheduledAlready(scope: SiteScope, action: ScheduleAction, frozen: readonly Frozen[]) {
	for (const { item } of frozen) {
		const [waiting] = await scope.db
			.select({ id: scheduledPublishes.id, at: scheduledPublishes.at })
			.from(scheduledPublishItems)
			.innerJoin(scheduledPublishes, eq(scheduledPublishes.id, scheduledPublishItems.scheduleId))
			.where(scope.where(scheduledPublishItems, scheduledItemWhere(item, action)));
		if (waiting) throw new ItemAlreadyScheduledError(item, waiting.id, waiting.at);
	}
}

async function insertItems(scope: SiteScope, scheduleId: string, action: ScheduleAction, frozen: readonly Frozen[]) {
	for (const [position, each] of frozen.entries()) {
		await scope.insert(scheduledPublishItems, {
			scheduleId,
			position,
			action,
			itemKind: each.item.kind,
			itemId: scheduledItemId(each.item),
			name: each.name,
			content: action === "publish" ? (each.content ?? null) : null,
			version: action === "publish" ? each.version : null,
		});
	}
}

/**
 * Schedules one item's publish at `at` (open the Site with `publishPermission(item)` outside a
 * transaction): its Draft now is what will go live. Refused: a time in the past or more than ten
 * years ahead (`ScheduleInvalidError`), an item already scheduled to publish
 * (`ItemAlreadyScheduledError`), and a Draft that couldn't be published now, with the reason
 * publishing it would give.
 */
export async function scheduleItem(
	scope: SiteScope,
	item: PublishItem,
	at: Date,
	sources: ComponentSources,
): Promise<ScheduledPublish> {
	checkScheduleTime(at, scope.now());
	const frozen = await rolledBack(scope, async (tx) => {
		const frozen = await freeze(tx, [item]);
		await refuseScheduledAlready(tx, "publish", frozen);
		return frozen;
	});
	await checkPublishable(scope, frozen, sources);
	const id = await saveRefusingScheduledAlready(scope, "publish", frozen, () =>
		insertSchedule(scope, { action: "publish", kind: "item", at, frozen }),
	);
	return getScheduled(scope, id);
}

/**
 * Schedules an Entry's unpublish at `at` (open the Site with `entry.publish` outside a transaction):
 * at the time its pages answer 410 Gone and it leaves Loops and Site search, keeping its Draft and
 * Revisions; a Page takes the Pages under it along. Refused: anything but an Entry
 * (`ScheduleInvalidError`, `notAnEntry`), a time in the past or too far ahead, an Entry already
 * scheduled to unpublish, and the home page or a Page above it (`HomePageUnpublishError`).
 */
export async function scheduleUnpublish(scope: SiteScope, item: PublishItem, at: Date): Promise<ScheduledPublish> {
	if (item.kind !== "entry") throw new ScheduleInvalidError("notAnEntry");
	checkScheduleTime(at, scope.now());
	if (!can(scope.access.actor, "entry.publish", siteResource(scope))) throw new PermissionDeniedError("entry.publish");
	// Whether it could be unpublished now: it is the Site's, and isn't the home page.
	const frozen: Frozen[] = await rolledBack(scope, async (tx) => {
		const { summary } = await itemState(tx, item);
		const frozen = [{ item, content: null, version: null, name: summary.name }];
		await refuseScheduledAlready(tx, "unpublish", frozen);
		await unpublishEntry(tx, item.id);
		return frozen;
	});
	const id = await saveRefusingScheduledAlready(scope, "unpublish", frozen, () =>
		insertSchedule(scope, { action: "unpublish", kind: "item", at, frozen }),
	);
	return getScheduled(scope, id);
}

/**
 * "Publish all at…", in two calls like Publish all: without `confirmation` it answers the ticked
 * Drafts in the order they would go live and a confirmation id; with it, it schedules them as one
 * Scheduled publish at `at`, each frozen as its Draft is then, all or none. Open the Site with
 * `site.view` outside a transaction; each item needs its own Permission. Refused as Publish all is
 * (`PublishAllInvalidError`, `PublishAllRefusedError` for what couldn't be published now,
 * `ConfirmationInvalidError` for Drafts changed since the preview), and for a time in the past, too
 * far ahead, or an item already scheduled to publish.
 */
export async function scheduleAll(
	scope: SiteScope,
	items: readonly PublishItem[],
	at: Date,
	confirmation: string | undefined,
	sources: ComponentSources,
): Promise<ScheduleAllPreview | ScheduleAllDone> {
	checkScheduleTime(at, scope.now());
	requirePublishPermissions(scope, items);
	const chosen = async (reader: SiteScope) => {
		const drafts = await siteDrafts(reader);
		const byKey = new Map(drafts.map((draft) => [itemKey(draft.item), draft]));
		const unique = [...new Map(items.map((item) => [itemKey(item), item])).values()];
		const unknown = unique.filter((item) => !byKey.has(itemKey(item)));
		if (unknown.length > 0) throw new PublishAllInvalidError(unknown);
		const ordered = await orderForPublish(
			reader,
			unique.map((item) => byKey.get(itemKey(item))?.item as PublishItem),
		);
		return ordered.map((item) => byKey.get(itemKey(item)) as (typeof drafts)[number]);
	};
	const request = (frozen: readonly Frozen[]) => ({
		action: SCHEDULE_ALL_ACTION,
		target: scope.site.id,
		preview: { at: at.toISOString(), items: frozen.map((each) => ({ item: each.item, version: each.version })) },
	});
	if (!confirmation) {
		const { listed, frozen } = await rolledBack(scope, async (tx) => {
			const listed = await chosen(tx);
			return {
				listed,
				frozen: await freeze(
					tx,
					listed.map((draft) => draft.item),
				),
			};
		});
		return {
			scheduled: false,
			preview: {
				at,
				items: listed.map((draft) => ({ item: draft.item, name: draft.name, status: draft.status })),
			},
			confirmation: await askConfirmation(scope, request(frozen)),
		};
	}
	const { listed, frozen } = await rolledBack(scope, async (tx) => {
		const listed = await chosen(tx);
		const frozen = await freeze(
			tx,
			listed.map((draft) => draft.item),
		);
		await refuseScheduledAlready(tx, "publish", frozen);
		return { listed, frozen };
	});
	const names = new Map(listed.map((draft) => [itemKey(draft.item), draft.name]));
	await checkPublishable(scope, frozen, sources, setRefusal(names));
	const id = await saveRefusingScheduledAlready(scope, "publish", frozen, () =>
		scope.transaction(async (tx) => {
			await useConfirmation(tx, confirmation, request(frozen));
			return insertSchedule(tx, { action: "publish", kind: "set", at, frozen });
		}),
	);
	return { scheduled: await getScheduled(scope, id) };
}

function siteResource(scope: SiteScope) {
	return { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const;
}

/** The Permission needed for each item of a Scheduled publish: `entry.publish` for an unpublish, else each item's own. */
function changePermissions(action: string, items: readonly PublishItem[]): Permission[] {
	return action === "unpublish" ? ["entry.publish"] : items.map(publishPermission);
}

/** Whether the person may publish every item of a Scheduled publish (an unpublish: `entry.publish`). */
function mayChange(scope: SiteScope, action: string, items: readonly PublishItem[]): boolean {
	return changePermissions(action, items).every((permission) =>
		can(scope.access.actor, permission, siteResource(scope)),
	);
}

/**
 * The Site's Scheduled publishes waiting for their time, soonest first (open the Site with
 * `site.view`); with `item`, only those it waits in.
 */
export async function listScheduled(
	scope: SiteScope,
	filter: { item?: PublishItem } = {},
): Promise<ScheduledPublish[]> {
	const rows = await scope.select(
		scheduledPublishes,
		filter.item
			? inArray(
					scheduledPublishes.id,
					scope.db
						.select({ id: scheduledPublishItems.scheduleId })
						.from(scheduledPublishItems)
						.where(
							scope.where(
								scheduledPublishItems,
								and(
									eq(scheduledPublishItems.itemKind, filter.item.kind),
									scheduledItemId(filter.item) === null
										? isNull(scheduledPublishItems.itemId)
										: eq(scheduledPublishItems.itemId, scheduledItemId(filter.item) as string),
								),
							),
						),
				)
			: undefined,
		{ orderBy: [asc(scheduledPublishes.at), asc(scheduledPublishes.id)] },
	);
	return views(scope, rows);
}

/** One Scheduled publish of the Site; refused with `ScheduledPublishNotFoundError` when it isn't waiting. */
export async function getScheduled(scope: SiteScope, scheduleId: string): Promise<ScheduledPublish> {
	const row = isUuid(scheduleId)
		? await scope.first(scheduledPublishes, eq(scheduledPublishes.id, scheduleId))
		: undefined;
	if (!row) throw new ScheduledPublishNotFoundError();
	const [view] = await views(scope, [row]);
	return view as ScheduledPublish;
}

async function views(scope: SiteScope, rows: readonly Row[]): Promise<ScheduledPublish[]> {
	if (rows.length === 0) return [];
	const itemRows = await scope.select(
		scheduledPublishItems,
		inArray(
			scheduledPublishItems.scheduleId,
			rows.map((row) => row.id),
		),
		{ orderBy: [asc(scheduledPublishItems.position)] },
	);
	const names = await peopleNames(
		scope.db,
		rows.map((row) => row.createdBy),
	);
	const viewed: ScheduledPublish[] = [];
	for (const row of rows) {
		const items: ScheduledItem[] = [];
		for (const itemRow of itemRows.filter((each) => each.scheduleId === row.id)) {
			const item = itemOf(itemRow);
			try {
				const state = await itemState(scope, item);
				items.push({
					item,
					name: state.summary.name,
					postType: state.summary.postType,
					templateKind: state.summary.templateKind,
					scriptKind: state.summary.scriptKind,
					changedSinceScheduled: row.action === "publish" && itemRow.version !== draftVersion(state.draft),
					missing: false,
				});
			} catch {
				items.push({
					item,
					name: itemRow.name,
					postType: null,
					templateKind: null,
					scriptKind: null,
					changedSinceScheduled: false,
					missing: true,
				});
			}
		}
		const name = row.createdBy ? names.get(row.createdBy) : undefined;
		viewed.push({
			id: row.id,
			action: row.action === "unpublish" ? "unpublish" : "publish",
			kind: row.kind === "set" ? "set" : "item",
			at: row.at,
			items,
			createdBy:
				row.createdBy && name !== undefined
					? { id: row.createdBy, name, via: clientNameOf(storedVia(row.createdVia)) }
					: null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			canChange: mayChange(
				scope,
				row.action,
				items.map((each) => each.item),
			),
		});
	}
	return viewed;
}

/** Holds a waiting Scheduled publish until the transaction ends, checking the person may change it. */
async function lockForChange(scope: SiteScope, scheduleId: string): Promise<{ row: Row; items: ItemRow[] }> {
	const [row] = isUuid(scheduleId)
		? await scope.db
				.select()
				.from(scheduledPublishes)
				.where(scope.where(scheduledPublishes, eq(scheduledPublishes.id, scheduleId)))
				.for("update")
		: [];
	if (!row) throw new ScheduledPublishNotFoundError();
	const items = await scope.select(scheduledPublishItems, eq(scheduledPublishItems.scheduleId, row.id), {
		orderBy: [asc(scheduledPublishItems.position)],
	});
	const refused = changePermissions(row.action, items.map(itemOf)).find(
		(permission) => !can(scope.access.actor, permission, siteResource(scope)),
	);
	if (refused) throw new PermissionDeniedError(refused);
	return { row, items };
}

/**
 * Changes a Scheduled publish's time (open the Site with `site.view`; the person must be allowed to
 * publish every item of it). The versions it publishes stay as they were frozen; taking the current
 * Drafts is `updateScheduled`. Logged as `scheduledPublish.reschedule`.
 */
export async function reschedule(scope: SiteScope, scheduleId: string, at: Date): Promise<ScheduledPublish> {
	checkScheduleTime(at, scope.now());
	await scope.transaction(async (tx) => {
		const { row } = await lockForChange(tx, scheduleId);
		await tx.update(
			scheduledPublishes,
			{ at, updatedAt: tx.now(), updatedBy: personIdOf(tx.access.actor) },
			eq(scheduledPublishes.id, row.id),
		);
		await tx.audit("scheduledPublish.reschedule", {
			scheduleId: row.id,
			action: row.action,
			from: row.at.toISOString(),
			to: at.toISOString(),
		});
	});
	return getScheduled(scope, scheduleId);
}

/**
 * Takes each item's current Draft into a Scheduled publish, in place of the version frozen before
 * (open the Site with `site.view` outside a transaction; the person must be allowed to publish every
 * item). Checked as scheduling is: what couldn't be published now is refused, with its reason. Its
 * time stays. An unpublish has no Draft to take (`ScheduleInvalidError`, `nothingToTake`). Logged as
 * `scheduledPublish.update`.
 */
export async function updateScheduled(
	scope: SiteScope,
	scheduleId: string,
	sources: ComponentSources,
): Promise<ScheduledPublish> {
	const { row, frozen, names } = await rolledBack(scope, async (tx) => {
		const { row, items } = await lockForChange(tx, scheduleId);
		if (row.action !== "publish") throw new ScheduleInvalidError("nothingToTake");
		const ordered = await orderForPublish(tx, items.map(itemOf));
		const names = new Map<string, string | null>();
		for (const item of ordered) {
			const state = await itemState(tx, item).catch((error: unknown) => {
				throw row.kind === "set" ? new PublishAllRefusedError(item, null, error) : error;
			});
			names.set(itemKey(item), state.summary.name);
		}
		return { row, frozen: await freeze(tx, ordered), names };
	});
	await checkPublishable(scope, frozen, sources, row.kind === "set" ? setRefusal(names) : undefined);
	await scope.transaction(async (tx) => {
		const { row: locked } = await lockForChange(tx, scheduleId);
		await tx.delete(scheduledPublishItems, eq(scheduledPublishItems.scheduleId, locked.id));
		await insertItems(tx, locked.id, "publish", frozen);
		await tx.update(
			scheduledPublishes,
			{ updatedAt: tx.now(), updatedBy: personIdOf(tx.access.actor) },
			eq(scheduledPublishes.id, locked.id),
		);
		// The current Drafts of items In review are scheduled now: their Reviews end.
		await reviewsOnSchedule(
			tx,
			frozen.map((each) => each.item),
			locked.at,
			locked.id,
		);
		await tx.audit("scheduledPublish.update", {
			scheduleId: locked.id,
			items: frozen.map((each) => each.item),
			count: frozen.length,
		});
	});
	return getScheduled(scope, scheduleId);
}

/**
 * Cancels a Scheduled publish (open the Site with `site.view`; the person must be allowed to publish
 * every item of it): nothing is published, and the Drafts stay as they are. Logged as
 * `scheduledPublish.cancel`. Items it had put In review by scheduling them wait for a reviewer again
 * (`reopenReviewsOfSchedule`, logged as `review.reopen`), in the same transaction: a time that will
 * never come must not leave them stuck "Scheduled" forever.
 */
export async function cancelScheduled(scope: SiteScope, scheduleId: string): Promise<void> {
	await scope.transaction(async (tx) => {
		const { row, items } = await lockForChange(tx, scheduleId);
		// Found and reopened before the row leaves: deleting it would null `schedule_id` itself
		// (`ON DELETE SET NULL`), losing which Reviews to put back before this can find them.
		const reopened = await reopenReviewsOfSchedule(tx, row.id);
		await tx.delete(scheduledPublishes, eq(scheduledPublishes.id, row.id));
		for (const review of reopened) {
			await tx.audit("review.reopen", {
				reviewId: review.row.id,
				item: reviewItemOf(review.row),
				name: review.name,
				postTypeId: review.postTypeId,
				submittedBy: review.row.submittedBy,
				scheduleId: row.id,
				reason: "cancelled",
			});
		}
		await tx.audit("scheduledPublish.cancel", {
			scheduleId: row.id,
			action: row.action,
			kind: row.kind,
			at: row.at.toISOString(),
			items: items.map(itemOf),
			reason: "cancelled",
		});
	});
}

/** Why a Scheduled publish didn't go through, as its email words it. */
export type ScheduleFailure =
	| "deleted"
	| "invalid"
	| "pathTaken"
	| "parentUnpublished"
	| "structureChanged"
	| "access"
	| "homePage"
	| "other";

/** What stopped a run, from the error publishing (or unpublishing) gave. */
export function failureOf(error: unknown): ScheduleFailure {
	const name = (error as { name?: unknown } | null)?.name;
	switch (name) {
		case "EntryNotFoundError":
		case "TemplateNotFoundError":
		case "ComponentNotFoundError":
		case "LoopNotFoundError":
		case "FilterNotFoundError":
		case "FormNotFoundError":
		case "ScriptNotFoundError":
		case "PostTypeNotFoundError":
			return "deleted";
		case "EntryInvalidError":
		case "EntryIncompleteError":
		case "GlobalsInvalidError":
		case "GlobalsIncompleteError":
		case "LoopInvalidError":
		case "LoopIncompleteError":
		case "FilterInvalidError":
		case "FormInvalidError":
		case "ConsentBannerInvalidError":
		case "DesignSystemInvalidError":
			return "invalid";
		case "EntrySlugTakenError":
		case "PathTakenError":
			return "pathTaken";
		case "PageParentUnpublishedError":
			return "parentUnpublished";
		case "ElementTreeInvalidError":
		case "ComponentInUseError":
			return "structureChanged";
		case "PermissionDeniedError":
		case "SiteNotFoundError":
		case "WorkspaceNotFoundError":
			return "access";
		case "HomePageUnpublishError":
			return "homePage";
		default:
			return "other";
	}
}

/** What running Scheduled publishes needs. */
export type ScheduledPublishingDeps = {
	database: Database;
	data: DataLayer;
	clock: Clock;
	log: Logger;
	email: Email;
	actors: { person(personId: string): Promise<PersonActor> };
	componentSources: ComponentSources;
};

/** How a run ended: published (or unpublished), not this worker's to run, tried again later, or failed. */
export type RunOutcome = "done" | "skipped" | "retry" | "failed";

/** A Scheduled publish whose time came, as the worker finds it. */
type Due = Pick<Row, "id" | "siteId" | "createdBy" | "attempts">;

/**
 * Runs every Scheduled publish whose time came (the worker, every minute; at once when it is back
 * after being down, saying in the Audit log how late it was). Each in its own transaction, on behalf
 * of the person who scheduled it; one that fails never stops the others. Answers how each ended.
 */
export async function runDueScheduledPublishes(deps: ScheduledPublishingDeps): Promise<RunOutcome[]> {
	// Which are due, across the Install: ids only, each then opened through the data layer.
	const due: Due[] = await deps.database.db
		.select({
			id: scheduledPublishes.id,
			siteId: scheduledPublishes.siteId,
			createdBy: scheduledPublishes.createdBy,
			attempts: scheduledPublishes.attempts,
		})
		.from(scheduledPublishes)
		.where(lte(scheduledPublishes.at, deps.clock.now()))
		.orderBy(asc(scheduledPublishes.at), asc(scheduledPublishes.id))
		.limit(SCHEDULE_LIMITS.batch);
	const outcomes: RunOutcome[] = [];
	for (const row of due) outcomes.push(await runOne(deps, row));
	return outcomes;
}

async function runOne(deps: ScheduledPublishingDeps, due: Due): Promise<RunOutcome> {
	const via: AuditVia = { kind: "scheduledPublish" };
	let scope: SiteScope;
	try {
		if (!due.createdBy) throw new PermissionDeniedError("entry.publish");
		// The person who scheduled it, with their access as it is now.
		const actor = await deps.actors.person(due.createdBy);
		scope = await deps.data.site({ actor, via }, due.siteId, "site.view");
	} catch (error) {
		return fail(deps, due, error, null);
	}
	// The item that stopped the run, for the email.
	const blocked: { item: PublishItem | null } = { item: null };
	try {
		return await scope.transaction(async (tx): Promise<RunOutcome> => {
			// Held until this run commits: another worker skips it, and finds it gone afterwards.
			const [row] = await tx.db
				.select()
				.from(scheduledPublishes)
				.where(tx.where(scheduledPublishes, eq(scheduledPublishes.id, due.id)))
				.for("update", { skipLocked: true });
			if (!row || row.at.getTime() > tx.now().getTime()) return "skipped";
			const items = await tx.select(scheduledPublishItems, eq(scheduledPublishItems.scheduleId, row.id), {
				orderBy: [asc(scheduledPublishItems.position)],
			});
			if (row.action === "unpublish") {
				if (!can(tx.access.actor, "entry.publish", siteResource(tx))) throw new PermissionDeniedError("entry.publish");
				for (const each of items) {
					blocked.item = itemOf(each);
					// An Entry deleted since has no page left to end: nothing to do.
					if (each.itemId && (await tx.first(entries, eq(entries.id, each.itemId)))) {
						await unpublishEntry(tx, each.itemId);
					}
				}
			} else {
				const versions = new Map(items.map((each) => [itemKey(itemOf(each)), each.content]));
				await publishItems(
					tx,
					items.map(itemOf),
					deps.componentSources,
					(item, error) => {
						blocked.item = item;
						return error instanceof Error ? error : new Error(String(error));
					},
					(item) => versions.get(itemKey(item)),
				);
			}
			await tx.delete(scheduledPublishes, eq(scheduledPublishes.id, row.id));
			const lateByMs = tx.now().getTime() - row.at.getTime();
			const late = lateByMs > SCHEDULE_LIMITS.lateAfterMs;
			await tx.audit("scheduledPublish.run", {
				scheduleId: row.id,
				action: row.action,
				kind: row.kind,
				at: row.at.toISOString(),
				late,
				...(late ? { lateByMinutes: Math.round(lateByMs / 60_000) } : {}),
				items: items.map(itemOf),
				count: items.length,
			});
			if (late) {
				deps.log.warn("A Scheduled publish ran late: the worker wasn't running at its time", {
					siteId: row.siteId,
					scheduleId: row.id,
					lateByMinutes: Math.round(lateByMs / 60_000),
				});
			}
			return "done";
		});
	} catch (error) {
		if (isSerializationFailure(error) && due.attempts + 1 < SCHEDULE_LIMITS.maxAttempts) {
			// Postgres gave up on it (a deadlock or a serialization failure, two transactions at once): it
			// is tried again the next minute. Any other database failure (a constraint, a timeout, a lock
			// that gave up) is deterministic, so trying again wouldn't help: it fails at once, below.
			const background = await deps.data.background(due.siteId);
			await background?.update(scheduledPublishes, { attempts: due.attempts + 1 }, eq(scheduledPublishes.id, due.id));
			deps.log.warn("A Scheduled publish will be tried again", { siteId: due.siteId, scheduleId: due.id, error });
			return "retry";
		}
		return fail(deps, due, error, blocked.item);
	}
}

/**
 * A run that didn't go through: nothing of it was published. It is removed (never tried again; the
 * Drafts stay as they are), logged as `scheduledPublish.fail` with why, and the person who scheduled
 * it gets the `scheduled-publish-failed` email. Done once, by whichever worker holds it.
 */
async function fail(
	deps: ScheduledPublishingDeps,
	due: Due,
	error: unknown,
	blocked: PublishItem | null,
): Promise<RunOutcome> {
	const reason = failureOf(error instanceof PublishAllRefusedError ? error.cause : error);
	const background = await deps.data.background(due.siteId);
	if (!background) return "skipped";
	const failed = await background.transaction(async (tx) => {
		const [row] = await tx.db
			.select()
			.from(scheduledPublishes)
			.where(tx.where(scheduledPublishes, eq(scheduledPublishes.id, due.id)))
			.for("update", { skipLocked: true });
		if (!row) return null;
		const items = await tx.select(scheduledPublishItems, eq(scheduledPublishItems.scheduleId, row.id), {
			orderBy: [asc(scheduledPublishItems.position)],
		});
		const named = (blocked ? items.find((each) => itemKey(itemOf(each)) === itemKey(blocked)) : undefined) ?? items[0];
		const names = await itemNames(tx, named ? itemOf(named) : null, named?.name ?? null);
		// Found and reopened before the row leaves: deleting it would null `schedule_id` itself
		// (`ON DELETE SET NULL`), losing which Reviews to put back before this can find them.
		const reopened = await reopenReviewsOfSchedule(tx, row.id);
		await tx.delete(scheduledPublishes, eq(scheduledPublishes.id, row.id));
		// WebCraft failed it, on behalf of the person who scheduled it.
		await recordAudit(tx.db, deps.clock.now(), {
			personId: row.createdBy,
			via: { kind: "scheduledPublish" },
			workspaceId: row.workspaceId,
			siteId: row.siteId,
			action: "scheduledPublish.fail",
			details: {
				scheduleId: row.id,
				action: row.action,
				kind: row.kind,
				at: row.at.toISOString(),
				reason,
				...(blocked ? { item: blocked } : {}),
				error: (error as { name?: unknown } | null)?.name ?? null,
				items: items.map(itemOf),
				count: items.length,
			},
		});
		// Items it had put In review by scheduling them wait for a reviewer again: nothing of theirs
		// published, so a run that failed must not leave them stuck "Scheduled" for a time that won't come.
		for (const review of reopened) {
			await recordAudit(tx.db, deps.clock.now(), {
				personId: row.createdBy,
				via: { kind: "scheduledPublish" },
				workspaceId: row.workspaceId,
				siteId: row.siteId,
				action: "review.reopen",
				details: {
					reviewId: review.row.id,
					item: reviewItemOf(review.row),
					name: review.name,
					postTypeId: review.postTypeId,
					submittedBy: review.row.submittedBy,
					scheduleId: row.id,
					reason: "failed",
				},
			});
		}
		return { row, items, ...names };
	});
	if (!failed) return "skipped";
	deps.log.warn("A Scheduled publish didn't go through", { siteId: due.siteId, scheduleId: due.id, reason, error });
	const { row, items, title, entryPath } = failed;
	if (!row.createdBy) {
		deps.log.warn("Nobody to tell that a Scheduled publish didn't go through", { siteId: due.siteId });
		return "failed";
	}
	try {
		await deps.email.send({
			type: "scheduled-publish-failed",
			to: [{ personId: row.createdBy }],
			data: {
				siteName: background.site.name,
				action: row.action === "unpublish" ? "unpublish" : "publish",
				itemTitle: title,
				count: Math.max(items.length, 1),
				scheduledFor: utcText(row.at),
				reason,
				path: row.kind === "item" && entryPath ? entryPath : `/sites/${row.siteId}?publishAll=1`,
			},
			related: { kind: "scheduledPublish", id: row.id },
		});
	} catch (sendError) {
		deps.log.error("The email about a Scheduled publish that didn't go through couldn't be queued", {
			siteId: due.siteId,
			error: sendError,
		});
	}
	return "failed";
}

/** The name an email gives an item (an Entry's title, a Component's name), and where an Entry is edited. */
async function itemNames(
	scope: BackgroundScope,
	item: PublishItem | null,
	nameWhenScheduled: string | null,
): Promise<{ title: string | null; entryPath: string | null }> {
	if (!item) return { title: null, entryPath: null };
	// Its name now, else as it was when it was scheduled (it may be deleted since).
	const title = await itemState(scope, item).then(
		(state) => state.summary.name || nameWhenScheduled || null,
		() => nameWhenScheduled || null,
	);
	if (item.kind !== "entry") return { title, entryPath: null };
	const entry = isUuid(item.id) ? await scope.first(entries, eq(entries.id, item.id)) : undefined;
	return { title, entryPath: entry ? `/sites/${scope.site.id}/entries/${entry.postTypeId}/${entry.id}` : null };
}

/** A time as System emails show it, in UTC, as the admin does: `2026-03-02 09:00 UTC`. */
function utcText(at: Date): string {
	return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

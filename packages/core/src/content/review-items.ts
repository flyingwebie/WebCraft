import { reviews } from "@webcraft/db/schema";
import { and, desc, eq, isNull, or, type SQL } from "drizzle-orm";

import { clientNameOf } from "../audit.ts";
import { peopleNames, storedVia } from "../history/attribution.ts";
import { itemState } from "../history/items.ts";
import { can, personIdOf } from "../permissions/can.ts";
import type { BackgroundScope, SiteScope } from "../tenancy/data-layer.ts";
import { itemPermission } from "./item-permission.ts";
import { draftVersion } from "./json.ts";
import type { PublishItem } from "./publishing.ts";

/**
 * Reviews as the items under review see them, kept apart from `reviews.ts` so that the content store
 * (an Entry's answer), publishing and Scheduled publish can use them without importing it: what an
 * item's editor shows (In review, or sent back with its comment), and what publishing or scheduling
 * an item In review does to its Review.
 */

/**
 * What can be reviewed: the Content Authors change and can't publish (whose publish takes
 * `entry.publish`): Entries (Pages too), the Globals and the Consent banner's words. A Form's emails
 * are never Authors' to change, and Structure is Staff's.
 */
export type ReviewItem =
	| { kind: "entry"; id: string }
	| { kind: "globals" }
	| { kind: "consentBanner" }
	| { kind: "popupContent"; id: string };

export const REVIEW_KINDS: readonly ReviewItem["kind"][] = ["entry", "globals", "consentBanner", "popupContent"];

export function isReviewable(item: PublishItem): item is ReviewItem {
	return (REVIEW_KINDS as readonly string[]).includes(item.kind);
}

/**
 * Where a Review stands: `inReview` while it waits; then `withdrawn` (its Author took it back),
 * `sentBack` (with a comment), `published` or `scheduled` (a Scheduled publish will publish it).
 */
export type ReviewStatus = "inReview" | "withdrawn" | "sentBack" | "published" | "scheduled";

/** Someone who acted on a Review, and the API client or AI client they came through; null once they are gone. */
export type ReviewPerson = { id: string; name: string; via: string | null } | null;

/** A Review as the admin and API clients see it. */
export type Review = {
	id: string;
	item: ReviewItem;
	/** An Entry's title in the Default language, from its Draft; null for the Globals and the Consent banner's words. */
	name: string | null;
	/** An Entry's Post Type; null for the rest. */
	postType: { id: string; name: string } | null;
	status: ReviewStatus;
	submittedBy: ReviewPerson;
	submittedAt: Date;
	/** What its Author said when submitting it. */
	note: string | null;
	/**
	 * The Draft changed since it was submitted: the Draft stays shared while it waits (ADR 0025), and
	 * whoever acts on it publishes the Draft as it is then.
	 */
	changedSinceSubmitted: boolean;
	/** Who published, scheduled, sent it back or withdrew it, and when; null while it waits. */
	decidedBy: ReviewPerson;
	decidedAt: Date | null;
	/** Why it was sent back. */
	comment: string | null;
	/** When the Scheduled publish it went into publishes it. */
	scheduledAt: Date | null;
	/** Whether the person may publish it, schedule it or send it back: they may publish the item. */
	canAct: boolean;
	/** Whether the person may withdraw it: they submitted it, and it still waits. */
	canWithdraw: boolean;
};

type Row = typeof reviews.$inferSelect;

function reviewStatus(value: string): ReviewStatus {
	return value === "withdrawn" || value === "sentBack" || value === "published" || value === "scheduled"
		? value
		: "inReview";
}

/** The item a Review row names. */
export function reviewItemOf(row: Pick<Row, "itemKind" | "entryId" | "popupId">): ReviewItem {
	if (row.itemKind === "popupContent" && row.popupId) return { kind: "popupContent", id: row.popupId };
	if (row.itemKind === "entry" && row.entryId) return { kind: "entry", id: row.entryId };
	return { kind: row.itemKind === "consentBanner" ? "consentBanner" : "globals" };
}

/** The condition naming one item's Reviews. */
export function reviewItemWhere(item: ReviewItem): SQL {
	return and(
		eq(reviews.itemKind, item.kind),
		item.kind === "entry"
			? eq(reviews.entryId, item.id)
			: item.kind === "popupContent"
				? eq(reviews.popupId, item.id)
				: isNull(reviews.entryId),
	) as SQL;
}

/** A Review's item, as a string key: an Entry by id, else its kind alone (one per Site). */
export function itemKey(item: ReviewItem): string {
	return "id" in item ? `${item.kind}:${item.id}` : item.kind;
}

function siteResource(scope: SiteScope) {
	return { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const;
}

/** Whether the person may act on a Review of the item: publish it, schedule it or send it back. */
export function mayActOn(scope: SiteScope, item: ReviewItem): boolean {
	return can(scope.access.actor, itemPermission(item.kind, "entry.publish"), siteResource(scope));
}

/**
 * Reviews as the API shows them, each with its item's name and whether its Draft changed since it
 * was submitted (`drafts`: each item's Draft now, by `itemKey`, read when missing).
 */
export async function reviewViews(
	scope: SiteScope,
	rows: readonly Row[],
	drafts: ReadonlyMap<string, { draft: unknown; name: string | null; postType: Review["postType"] }> = new Map(),
): Promise<Review[]> {
	if (rows.length === 0) return [];
	const names = await peopleNames(
		scope.db,
		rows.flatMap((row) => [row.submittedBy, row.decidedBy]),
	);
	const person = (id: string | null, via: unknown): ReviewPerson => {
		const name = id ? names.get(id) : undefined;
		return id && name !== undefined ? { id, name, via: clientNameOf(storedVia(via)) } : null;
	};
	const me = personIdOf(scope.access.actor);
	const known = new Map(drafts);
	const viewed: Review[] = [];
	for (const row of rows) {
		const item = reviewItemOf(row);
		let state = known.get(itemKey(item));
		if (!state) {
			const found = await itemState(scope, item);
			state = { draft: found.draft, name: found.summary.name, postType: found.summary.postType };
			known.set(itemKey(item), state);
		}
		const status = reviewStatus(row.status);
		viewed.push({
			id: row.id,
			item,
			name: state.name,
			postType: state.postType,
			status,
			submittedBy: person(row.submittedBy, row.submittedVia),
			submittedAt: row.submittedAt,
			note: row.note,
			changedSinceSubmitted: draftVersion(state.draft) !== row.version,
			decidedBy: person(row.decidedBy, row.decidedVia),
			decidedAt: row.decidedAt,
			comment: row.comment,
			scheduledAt: row.scheduledAt,
			canAct: status === "inReview" && mayActOn(scope, item),
			canWithdraw: status === "inReview" && me !== null && row.submittedBy === me,
		});
	}
	return viewed;
}

/**
 * The Review each item's editor shows, by `itemKey`: its newest Review while it waits (In review), or
 * when it was sent back, until it is submitted again or published (the comment shows until then).
 */
export async function currentReviews(
	scope: SiteScope,
	items: readonly { item: ReviewItem; draft: unknown; name: string | null; postType: Review["postType"] }[],
): Promise<Map<string, Review>> {
	const found = new Map<string, Review>();
	if (items.length === 0) return found;

	const rows = await scope.db
		.selectDistinctOn([reviews.itemKind, reviews.entryId, reviews.popupId])
		.from(reviews)
		.where(scope.where(reviews, or(...items.map(({ item }) => reviewItemWhere(item)))))
		.orderBy(reviews.itemKind, reviews.entryId, reviews.popupId, desc(reviews.serial));
	const shown = rows.filter(
		(row) => row.status === "inReview" || (row.status === "sentBack" && row.clearedAt === null),
	);
	const drafts = new Map(items.map((each) => [itemKey(each.item), each]));
	for (const review of await reviewViews(scope, shown, drafts)) found.set(itemKey(review.item), review);
	return found;
}

/** The Reviews Entries' editors show, by Entry id, in one query. */
export async function entryReviews(
	scope: SiteScope,
	rows: readonly { id: string; draft: unknown; name: string; postType: { id: string; name: string } | null }[],
): Promise<Map<string, Review>> {
	const found = await currentReviews(
		scope,
		rows.map((row) => ({
			item: { kind: "entry" as const, id: row.id },
			draft: row.draft,
			name: row.name,
			postType: row.postType,
		})),
	);
	return new Map([...found.values()].map((review) => [(review.item as { id: string }).id, review]));
}

/** An item's waiting Review, held until the transaction ends; undefined when none waits. */
async function waitingReview(scope: SiteScope, item: ReviewItem): Promise<Row | undefined> {
	const [row] = await scope.db
		.select()
		.from(reviews)
		.where(scope.where(reviews, and(reviewItemWhere(item), eq(reviews.status, "inReview"))))
		.for("update");
	return row;
}

/** What the Audit log says about the item a Review is of. */
async function auditItem(scope: SiteScope, row: Row) {
	const item = reviewItemOf(row);
	const state = await itemState(scope, item);
	return {
		reviewId: row.id,
		item,
		name: state.summary.name,
		postTypeId: state.summary.postType?.id ?? null,
		submittedBy: row.submittedBy,
	};
}

/**
 * Publishing items ends their Reviews, whatever published them (the admin, Publish all, Edit mode, an
 * API client, a Scheduled publish), in the publish's transaction: a waiting Review is `published`
 * (logged as `review.publish`, which emails its Author), and a sent-back comment stops showing. A
 * Scheduled publish publishes a frozen version (`frozen`): only when that is the Draft as it is now
 * did it publish what was submitted; otherwise the Review keeps waiting.
 */
export async function reviewsOnPublish(
	scope: SiteScope,
	items: readonly PublishItem[],
	frozen?: (item: PublishItem) => unknown,
): Promise<void> {
	for (const item of items) {
		if (!isReviewable(item)) continue;
		const version = frozen?.(item);
		if (version !== undefined && draftVersion(version) !== draftVersion((await itemState(scope, item)).draft)) {
			continue;
		}
		const now = scope.now();
		await scope.update(
			reviews,
			{ clearedAt: now },
			and(reviewItemWhere(item), eq(reviews.status, "sentBack"), isNull(reviews.clearedAt)),
		);
		const row = await waitingReview(scope, item);
		if (!row) continue;
		await scope.update(
			reviews,
			{ status: "published", decidedBy: personIdOf(scope.access.actor), decidedVia: scope.access.via, decidedAt: now },
			eq(reviews.id, row.id),
		);
		await scope.audit("review.publish", await auditItem(scope, row));
	}
}

/**
 * Scheduling items to publish ends their waiting Reviews (`scheduled`, with the time; logged as
 * `review.schedule`, which emails its Author): the Scheduled publish holds the Draft as it is now, and
 * publishes it at its time on behalf of the person who scheduled it.
 */
export async function reviewsOnSchedule(
	scope: SiteScope,
	items: readonly PublishItem[],
	at: Date,
	scheduleId: string,
): Promise<void> {
	for (const item of items) {
		if (!isReviewable(item)) continue;
		const row = await waitingReview(scope, item);
		if (!row) continue;
		await scope.update(
			reviews,
			{
				status: "scheduled",
				decidedBy: personIdOf(scope.access.actor),
				decidedVia: scope.access.via,
				decidedAt: scope.now(),
				scheduledAt: at,
				scheduleId,
			},
			eq(reviews.id, row.id),
		);
		await scope.audit("review.schedule", { ...(await auditItem(scope, row)), at: at.toISOString(), scheduleId });
	}
}

/** A Review `reopenReviewsOfSchedule` put back to In review, with what the Audit log needs to say about it. */
export type ReopenedReview = { row: Row; name: string | null; postTypeId: string | null };

/**
 * Finds the Reviews a Scheduled publish ended by scheduling (`scheduled`, holding its id) and puts
 * them back to `inReview`, as if they had never been scheduled: cleared `decidedBy`/`decidedAt`/
 * `scheduledAt`/`scheduleId`. Called when that Scheduled publish is removed without ever publishing
 * them (cancelled, or a run that failed), in the same transaction as its own row leaving.
 *
 * Only the lookup and the row update: the caller writes its own Audit log entry (`review.reopen`),
 * since a Scheduled publish is cancelled through a `SiteScope` (a person acted) but a failed run is
 * found through a `BackgroundScope` (nobody did: `BackgroundScope` keeps no Audit log of its own).
 * Not emailed: nothing was decided, the Scheduled publish it waited in simply stopped existing, and
 * whoever removed it (cancelling it, or the `scheduled-publish-failed` email on a failed run) already
 * knows why; the item just waits for a reviewer again.
 */
export async function reopenReviewsOfSchedule(
	scope: SiteScope | BackgroundScope,
	scheduleId: string,
): Promise<ReopenedReview[]> {
	const rows = await scope.db
		.select()
		.from(reviews)
		.where(scope.where(reviews, and(eq(reviews.scheduleId, scheduleId), eq(reviews.status, "scheduled"))))
		.for("update");
	const reopened: ReopenedReview[] = [];
	for (const row of rows) {
		await scope.update(
			reviews,
			{
				status: "inReview",
				decidedBy: null,
				decidedVia: null,
				decidedAt: null,
				scheduledAt: null,
				scheduleId: null,
			},
			eq(reviews.id, row.id),
		);
		const state = await itemState(scope, reviewItemOf(row));
		reopened.push({ row, name: state.summary.name, postTypeId: state.summary.postType?.id ?? null });
	}
	return reopened;
}

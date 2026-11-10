import type { Database } from "@webcraft/db";
import { installRoles, membershipSites, memberships, reviews } from "@webcraft/db/schema";
import { and, desc, eq, inArray, isNotNull, or } from "drizzle-orm";

import type { RecordedAuditEntry } from "../audit.ts";
import { checkConsentTextReady } from "../consent/text.ts";
import { isUniqueViolation } from "../db-errors.ts";
import type { Email } from "../email/index.ts";
import { peopleNames } from "../history/attribution.ts";
import { saveCheckpoint } from "../history/checkpoints.ts";
import { itemState } from "../history/items.ts";
import { isUuid } from "../ids.ts";
import type { Logger } from "../log.ts";
import { personIdOf } from "../permissions/can.ts";
import { roleDefinition, SUPERADMIN_ROLE } from "../permissions/roles.ts";
import type { BackgroundScope, DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { siteStaff } from "../tenancy/site-owners.ts";
import {
	ItemInReviewError,
	ReviewDecidedError,
	ReviewInvalidError,
	ReviewNotFoundError,
	ReviewNotYoursError,
} from "./errors.ts";
import { checkGlobalsReady } from "./globals.ts";
import { draftVersion, sameJson } from "./json.ts";
import { checkEntryReady, type PublishItem } from "./publishing.ts";
import {
	isReviewable,
	mayActOn,
	type Review,
	type ReviewItem,
	reviewItemKey,
	reviewItemOf,
	reviewItemWhere,
	reviewStatus,
	reviewViews,
} from "./review-items.ts";

/**
 * Review (GLOSSARY.md › Review, spec stories 23 and 49): an Author submits a Draft, and someone who
 * may publish it (an Editor, an Owner, Staff, the Superadmin) publishes it, schedules it or sends it
 * back with a comment. While it waits the item is In review; its Author may withdraw it.
 *
 * - **What is reviewed**: the Content Authors change and can't publish: Entries (Pages too), the
 *   Globals and the Consent banner's words (`isReviewable`). Several items submitted together (Edit
 *   mode's page: its Entry and the Globals) are one submission: one email per reviewer.
 * - **The Draft stays shared** (ADR 0025): nobody's Draft is locked while it waits. Whoever acts on it
 *   publishes (or schedules) the Draft as it is then, through the normal publish (`publishItems`) or
 *   Scheduled publish, which end the Review themselves (`reviewsOnPublish`, `reviewsOnSchedule` in
 *   `review-items.ts`). The Review keeps the version submitted, so it says "Changed since submitted",
 *   and submitting saves a Checkpoint of the Draft (`review`), which history compares with the Draft.
 * - **Who**: submitting and withdrawing need `entry.edit` (only the person who submitted withdraws);
 *   sending back needs what publishing the item needs (`entry.publish`). Authors never publish: they
 *   hold no `entry.publish` on any path.
 * - **Who hears**: the Members who may publish the item on the Site (its Owners and Editors) get the
 *   `review-submitted` email; when no Member may, the Staff who reach the Site, and failing them the
 *   Superadmin, so a Review never waits unheard. Everyone who sees the Site sees what waits, in the
 *   admin. The Author gets `review-result` when it is published, scheduled or sent back. Emails go
 *   once the change is saved (`afterAudit`), never for one rolled back.
 */

/** How long a note and a comment may be, and how many items one submission holds. */
export const REVIEW_LIMITS = { noteMax: 2000, commentMax: 5000, itemsMax: 50 } as const;

type Row = typeof reviews.$inferSelect;

/** Checks an item's Draft could be published as far as its values go, with the error publishing gives. */
async function checkReady(scope: SiteScope, item: ReviewItem): Promise<void> {
	if (item.kind === "entry") await checkEntryReady(scope, item.id);
	else if (item.kind === "globals") await checkGlobalsReady(scope);
	else await checkConsentTextReady(scope);
}

/** Whether an item has a Draft that differs from what visitors see. */
function hasChanges(item: ReviewItem, draft: unknown, published: unknown): boolean {
	if (item.kind === "entry") return !sameJson(draft, published);
	return !sameJson(draft ?? null, published ?? { values: {} });
}

/** The item's waiting Review, if any. */
async function waitingOf(scope: SiteScope, item: ReviewItem): Promise<Row | undefined> {
	return scope.first(reviews, and(reviewItemWhere(item), eq(reviews.status, "inReview")));
}

/**
 * Submits items for Review together, with an optional note (open the Site with `entry.edit`): each
 * becomes In review, a Checkpoint of its Draft is saved, `review.submit` is logged once, and the people
 * who may publish them are emailed once. Refused: anything but an Entry, the Globals or the Consent
 * banner's words (`ReviewInvalidError`, `notReviewable`), an item whose Draft is what visitors see
 * (`nothingToReview`), a Draft publishing would refuse for its values (`EntryIncompleteError`,
 * `EntryInvalidError`, `GlobalsIncompleteError`, …), and an item In review already (`ItemInReviewError`).
 */
export async function submitForReview(
	scope: SiteScope,
	items: readonly PublishItem[],
	note: string | null,
): Promise<Review[]> {
	const unique = [...new Map(items.map((item) => [`${item.kind}:${"id" in item ? item.id : ""}`, item])).values()];
	for (const item of unique) if (!isReviewable(item)) throw new ReviewInvalidError("notReviewable", item);
	const chosen = unique as ReviewItem[];
	const text = note?.trim() ? note.trim() : null;
	try {
		const ids = await scope.transaction(async (tx) => {
			const submitted: { row: Row; name: string | null; postTypeId: string | null }[] = [];
			for (const item of chosen) {
				const state = await itemState(tx, item);
				if (!hasChanges(item, state.draft, state.published)) throw new ReviewInvalidError("nothingToReview", item);
				const waiting = await waitingOf(tx, item);
				if (waiting) throw new ItemInReviewError(item, waiting.id);
				await checkReady(tx, item);
				const row = await tx.insert(reviews, {
					itemKind: item.kind,
					entryId: item.kind === "entry" ? item.id : null,
					status: "inReview",
					submittedBy: personIdOf(tx.access.actor),
					submittedVia: tx.access.via,
					submittedAt: tx.now(),
					note: text,
					version: draftVersion(state.draft),
				});
				// The item's history shows what was submitted, to compare the Draft with later.
				await saveCheckpoint(tx, item, "review");
				submitted.push({ row, name: state.summary.name, postTypeId: state.summary.postType?.id ?? null });
			}
			await tx.audit("review.submit", {
				reviews: submitted.map(({ row, name, postTypeId }) => ({
					reviewId: row.id,
					item: reviewItemOf(row),
					name,
					postTypeId,
				})),
				count: submitted.length,
				note: text,
			});
			return submitted.map(({ row }) => row.id);
		});
		const rows = await scope.select(reviews, inArray(reviews.id, ids));
		const views = await reviewViews(scope, rows);
		return ids.map((id) => views.find((view) => view.id === id) as Review);
	} catch (error) {
		if (isUniqueViolation(error, "reviews_one_waiting")) {
			for (const item of chosen) {
				const waiting = await waitingOf(scope, item);
				if (waiting) throw new ItemInReviewError(item, waiting.id);
			}
		}
		throw error;
	}
}

/** Holds one of the Site's Reviews until the transaction ends. */
async function lockReview(scope: SiteScope, reviewId: string): Promise<Row> {
	const [row] = isUuid(reviewId)
		? await scope.db
				.select()
				.from(reviews)
				.where(scope.where(reviews, eq(reviews.id, reviewId)))
				.for("update")
		: [];
	if (!row) throw new ReviewNotFoundError();
	return row;
}

async function viewOf(scope: SiteScope, reviewId: string): Promise<Review> {
	const rows = await scope.select(reviews, eq(reviews.id, reviewId));
	const [view] = await reviewViews(scope, rows);
	if (!view) throw new ReviewNotFoundError();
	return view;
}

/**
 * Withdraws a Review its Author submitted, while it waits (open the Site with `entry.edit`): the item
 * is a Draft again, and nobody is emailed. Refused: someone else's (`ReviewNotYoursError`; those who
 * may publish it send it back instead) and one decided already (`ReviewDecidedError`).
 */
export async function withdrawReview(scope: SiteScope, reviewId: string): Promise<Review> {
	await scope.transaction(async (tx) => {
		const row = await lockReview(tx, reviewId);
		if (row.status !== "inReview") throw new ReviewDecidedError(row.status);
		const me = personIdOf(tx.access.actor);
		if (me === null || row.submittedBy !== me) throw new ReviewNotYoursError();
		await tx.update(
			reviews,
			{ status: "withdrawn", decidedBy: me, decidedVia: tx.access.via, decidedAt: tx.now() },
			eq(reviews.id, row.id),
		);
		const item = reviewItemOf(row);
		const state = await itemState(tx, item);
		await tx.audit("review.withdraw", { reviewId: row.id, item, name: state.summary.name });
	});
	return viewOf(scope, reviewId);
}

/**
 * Sends a waiting Review back with a comment saying why (open the Site with `site.view`; it needs what
 * publishing the item needs): the item is a Draft again, its editor shows the comment until it is
 * submitted again or published, and its Author gets the `review-result` email with it. Refused: an
 * empty comment (`ReviewInvalidError`, `commentRequired`), someone who may not publish it
 * (`PermissionDeniedError`) and one decided already (`ReviewDecidedError`).
 */
export async function sendBackReview(scope: SiteScope, reviewId: string, comment: string): Promise<Review> {
	const text = comment.trim();
	if (!text) throw new ReviewInvalidError("commentRequired");
	await scope.transaction(async (tx) => {
		const row = await lockReview(tx, reviewId);
		const item = reviewItemOf(row);
		if (!mayActOn(tx, item)) throw new PermissionDeniedError("entry.publish");
		if (row.status !== "inReview") throw new ReviewDecidedError(row.status);
		await tx.update(
			reviews,
			{
				status: "sentBack",
				decidedBy: personIdOf(tx.access.actor),
				decidedVia: tx.access.via,
				decidedAt: tx.now(),
				comment: text,
			},
			eq(reviews.id, row.id),
		);
		const state = await itemState(tx, item);
		await tx.audit("review.sendBack", {
			reviewId: row.id,
			item,
			name: state.summary.name,
			postTypeId: state.summary.postType?.id ?? null,
			submittedBy: row.submittedBy,
			comment: text,
		});
	});
	return viewOf(scope, reviewId);
}

/**
 * The Site's Reviews waiting for someone to act (open the Site with `site.view`), oldest first, so the
 * longest waiting comes first; with `item`, only that item's.
 */
export async function listReviews(scope: SiteScope, filter: { item?: PublishItem } = {}): Promise<Review[]> {
	if (filter.item && !isReviewable(filter.item)) return [];
	const rows = await scope.select(
		reviews,
		and(eq(reviews.status, "inReview"), filter.item ? reviewItemWhere(filter.item as ReviewItem) : undefined),
		{ orderBy: [reviews.serial] },
	);
	return reviewViews(scope, rows);
}

/** One of the Site's Reviews, whatever its state (open the Site with `site.view`). */
export async function getReview(scope: SiteScope, reviewId: string): Promise<Review> {
	if (!isUuid(reviewId)) throw new ReviewNotFoundError();
	return viewOf(scope, reviewId);
}

/** How many Reviews wait on the Site for the person to act on (what the admin's badges show). */
export async function countReviewsToAct(scope: SiteScope): Promise<number> {
	const rows = await scope.select(reviews, eq(reviews.status, "inReview"));
	return rows.filter((row) => mayActOn(scope, reviewItemOf(row))).length;
}

/** An item's Reviews, newest first: what history adds beside its copies. */
export async function itemReviewHistory(scope: SiteScope, item: PublishItem): Promise<Review[]> {
	if (!isReviewable(item)) return [];
	const rows = await scope.select(reviews, reviewItemWhere(item), {
		orderBy: [desc(reviews.serial)],
	});
	return reviewViews(scope, rows);
}

// -------------------------------------------------------------------------------------------------
// Who hears of a Review, and the emails

/** The Members of the Site's Workspace who reach it and whose role publishes Content (Owners and Editors). */
async function membersWhoPublish(scope: BackgroundScope): Promise<string[]> {
	const rows = await scope.db
		.selectDistinct({ personId: memberships.personId, role: memberships.role })
		.from(memberships)
		.leftJoin(
			membershipSites,
			and(eq(membershipSites.membershipId, memberships.id), eq(membershipSites.siteId, scope.site.id)),
		)
		.where(
			and(
				eq(memberships.workspaceId, scope.workspace.id),
				or(eq(memberships.allSites, true), isNotNull(membershipSites.siteId)),
			),
		);
	return rows
		.filter((row) => roleDefinition(row.role)?.permissions.includes("entry.publish") ?? false)
		.map((row) => row.personId);
}

/**
 * Who is emailed when something is submitted on a Site: its Members who may publish it; when there
 * are none, the Staff who reach it; when there are none either, the Superadmin.
 */
export async function reviewersOf(scope: BackgroundScope): Promise<string[]> {
	const members = await membersWhoPublish(scope);
	if (members.length > 0) return members;
	const staff = await siteStaff(scope);
	if (staff.length > 0) return staff;
	const rows = await scope.db
		.select({ personId: installRoles.personId })
		.from(installRoles)
		.where(eq(installRoles.role, SUPERADMIN_ROLE));
	return rows.map((row) => row.personId);
}

/** An item as Review emails name it. */
type EmailItem = { kind: ReviewItem["kind"]; title: string | null };

/** Where an item is edited in the admin, which Review emails link to. */
function itemPath(siteId: string, item: ReviewItem, postTypeId: string | null): string {
	if (item.kind === "entry") return `/sites/${siteId}/entries/${postTypeId ?? ""}/${item.id}`;
	return item.kind === "globals" ? `/sites/${siteId}/globals` : `/sites/${siteId}/consent-banner`;
}

/** A time as System emails show it, in UTC, as the admin does: `2026-03-02 09:00 UTC`. */
function utcText(at: Date): string {
	return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

type ReviewedItem = { reviewId: string; item: ReviewItem; name: string | null; postTypeId: string | null };

export type ReviewsDeps = { database: Database; data: DataLayer; email: Email; log: Logger };

export type Reviews = {
	/** Sends Review emails once what they are about is saved. */
	afterAudit(entry: RecordedAuditEntry): Promise<void>;
};

/** The emails Reviews send, heard from the Audit log once each change is saved. */
export function createReviews(deps: ReviewsDeps): Reviews {
	const names = (ids: readonly string[]) => peopleNames(deps.database.db, ids);

	const submitted = async (entry: RecordedAuditEntry, scope: BackgroundScope) => {
		const items = (entry.details.reviews ?? []) as ReviewedItem[];
		const [first] = items;
		if (!first) return;
		const authorName = entry.personId ? ((await names([entry.personId])).get(entry.personId) ?? "") : "";
		const to = (await reviewersOf(scope)).filter((personId) => personId !== entry.personId);
		if (to.length === 0) return;
		await deps.email.send({
			type: "review-submitted",
			to: to.map((personId) => ({ personId })),
			data: {
				authorName: authorName || "Someone",
				items: items.map((each): EmailItem => ({ kind: each.item.kind, title: each.name })),
				siteName: scope.site.name,
				note: typeof entry.details.note === "string" ? entry.details.note : null,
				reviewPath:
					items.length === 1 ? itemPath(scope.site.id, first.item, first.postTypeId) : `/sites/${scope.site.id}`,
			},
			related: { kind: "review", id: first.reviewId },
		});
	};

	const decided = async (entry: RecordedAuditEntry, scope: BackgroundScope) => {
		const details = entry.details as ReviewedItem & { submittedBy?: string | null; comment?: string; at?: string };
		const author = details.submittedBy ?? null;
		// Nobody to tell: the Author is gone, or acted themselves (someone who may publish submitted it).
		if (!author || author === entry.personId) return;
		const reviewerName = entry.personId ? ((await names([entry.personId])).get(entry.personId) ?? "") : "";
		const result =
			entry.action === "review.publish" ? "published" : entry.action === "review.schedule" ? "scheduled" : "sent-back";
		await deps.email.send({
			type: "review-result",
			to: [{ personId: author }],
			data: {
				item: { kind: details.item.kind, title: details.name },
				siteName: scope.site.name,
				result,
				reviewerName: reviewerName || "Someone",
				comment: result === "sent-back" ? (details.comment ?? null) : null,
				scheduledFor: result === "scheduled" && details.at ? utcText(new Date(details.at)) : null,
				itemPath: itemPath(scope.site.id, details.item, details.postTypeId),
			},
			related: { kind: "review", id: details.reviewId },
		});
	};

	return {
		async afterAudit(entry) {
			if (!entry.action.startsWith("review.") || !entry.siteId) return;
			if (!["review.submit", "review.publish", "review.schedule", "review.sendBack"].includes(entry.action)) return;
			try {
				const scope = await deps.data.background(entry.siteId);
				if (!scope) return;
				if (entry.action === "review.submit") await submitted(entry, scope);
				else await decided(entry, scope);
			} catch (error) {
				deps.log.error("A Review email couldn't be queued", { action: entry.action, siteId: entry.siteId, error });
			}
		},
	};
}

export { reviewItemKey, reviewStatus };

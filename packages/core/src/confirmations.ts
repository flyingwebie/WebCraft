import { confirmations } from "@webcraft/db/schema";
import { and, eq, lt } from "drizzle-orm";

import { sameJson } from "./content/json.ts";
import type { SiteScope } from "./tenancy/data-layer.ts";

/**
 * Two-step confirmation for destructive procedures (spec › Management API). The first call answers
 * a preview of what will happen (how many links deleting an Entry removes) and a confirmation id;
 * the second call passes the id back to go ahead. A confirmation is for one person, one action and
 * one target, lasts 5 minutes, works once, and only while the preview is still what the person saw:
 * when something changed in between, they look again.
 *
 *     const preview = await previewOf(entry);
 *     if (!input.confirmation) return { confirmation: await askConfirmation(site, { action, target, preview }) };
 *     await useConfirmation(site, input.confirmation, { action, target, preview });
 *     // … go ahead, in the same transaction
 */

/** How long a confirmation id works. */
export const CONFIRMATION_LIFETIME_MS = 5 * 60_000;

/** A confirmation id to send back, and until when it works. */
export type Confirmation = { id: string; expiresAt: Date };

/** What a confirmation is for. */
export type ConfirmationRequest = {
	/** The action, as the Audit log names it: `entry.delete`. */
	action: string;
	/** What it is done to, such as an Entry's id. */
	target: string;
	/** What the person is shown and agrees to, as JSON. */
	preview: unknown;
};

/** Why a confirmation can't be used. */
export type ConfirmationProblem = "unknown" | "expired" | "changed";

/**
 * The confirmation id doesn't work: it is unknown (or someone else's, or for another action or
 * target, or used already), expired, or what it confirmed has changed since. Ask again.
 */
export class ConfirmationInvalidError extends Error {
	override name = "ConfirmationInvalidError";
	readonly problem: ConfirmationProblem;
	constructor(problem: ConfirmationProblem) {
		super(
			problem === "changed"
				? "Something changed since you were asked to confirm; look again and confirm the new preview."
				: problem === "expired"
					? "The confirmation expired; ask again."
					: "There is no such confirmation; ask again.",
		);
		this.problem = problem;
	}
}

/** Asks the person to confirm `request`: answers the id they send back to go ahead. */
export async function askConfirmation(scope: SiteScope, request: ConfirmationRequest): Promise<Confirmation> {
	const now = scope.now();
	// Expired confirmations of the Site are of no use to anyone.
	await scope.delete(confirmations, lt(confirmations.expiresAt, now));
	const row = await scope.insert(confirmations, {
		personId: scope.access.actor.personId,
		action: request.action,
		target: request.target,
		preview: request.preview ?? null,
		createdAt: now,
		expiresAt: new Date(now.getTime() + CONFIRMATION_LIFETIME_MS),
	});
	return { id: row.id, expiresAt: row.expiresAt };
}

/**
 * Uses a confirmation for `request`, or throws `ConfirmationInvalidError`. Call it inside the
 * transaction that goes ahead, after working out the preview again; it is used up when that
 * transaction commits.
 */
export async function useConfirmation(scope: SiteScope, id: string, request: ConfirmationRequest): Promise<void> {
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const [row] = UUID.test(id)
		? await scope.db
				.delete(confirmations)
				.where(
					scope.where(
						confirmations,
						and(
							eq(confirmations.id, id),
							eq(confirmations.personId, scope.access.actor.personId),
							eq(confirmations.action, request.action),
							eq(confirmations.target, request.target),
						),
					),
				)
				.returning()
		: [];
	if (!row) throw new ConfirmationInvalidError("unknown");
	if (row.expiresAt.getTime() <= scope.now().getTime()) throw new ConfirmationInvalidError("expired");
	if (!sameJson(row.preview, request.preview ?? null)) throw new ConfirmationInvalidError("changed");
}

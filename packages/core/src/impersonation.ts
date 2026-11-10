import type { Session } from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";
import { impersonations, people } from "@webcraft/db/schema";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { type AuditDetails, type AuditVia, recordAudit } from "./audit.ts";
import type { Clock } from "./clock.ts";
import type { JobQueue } from "./jobs/define.ts";
import { defineJob } from "./jobs/define.ts";
import { type Actor, can, INSTALL, type PersonActor, personIdOf } from "./permissions/can.ts";
import { SUPERADMIN_ROLE } from "./permissions/roles.ts";
import type { Access } from "./tenancy/data-layer.ts";
import { PermissionDeniedError } from "./tenancy/errors.ts";

/**
 * Impersonation (ADR 0008): the Superadmin, or a Staff member, acting in the admin as another
 * person, to see exactly what they see.
 *
 * - **Who**: the Superadmin impersonates any Staff member or Member; Staff only Members of the
 *   Workspaces they are assigned to (`impersonation.start` there), and then only within those
 *   Workspaces: a Member who belongs to another Workspace too is impersonated without it. Nobody
 *   impersonates the Superadmin, Staff never another Staff member, Members never anyone.
 * - **Starting** needs the impersonator's own second factor (an authenticator app or a passkey) and
 *   a recent identity check (the Sensitive action `impersonation.start`).
 * - **It rides on the impersonator's own admin session**: while it goes on, that session acts as the
 *   person; Stop, the hour running out or signing out make it the impersonator's again. Edit mode and
 *   the Staging address never open while it goes on (they would outlast it on other hostnames).
 * - **Nothing about the person's account changes** while it goes on: their password, second
 *   factors, sessions, API tokens, AI clients, preferences; Sensitive actions are refused too, since
 *   the identity check would be the impersonator's (`NotWhileImpersonatingError`).
 * - **Everything is recorded under both names**: `via` is `impersonation`, with the impersonator's
 *   name and id, and the entry's person is the one impersonated, so it shows in their own activity.
 *   Starting and stopping are recorded the same way, in each Workspace it reaches (on the Install
 *   for Staff impersonated by the Superadmin).
 */

/** The longest an impersonation lasts: it ends by itself an hour after it started. */
export const IMPERSONATION_MAX_MS = 60 * 60 * 1000;

/** The longest reason the impersonator may give. */
export const IMPERSONATION_REASON_MAX_LENGTH = 200;

/** Why an impersonation ended. */
export type ImpersonationEnd = "stopped" | "time" | "signedOut" | "access";

/** An impersonation going on, as the admin shows it (the banner). */
export type ImpersonationView = {
	id: string;
	person: { id: string; name: string; email: string };
	impersonator: { id: string; name: string; email: string };
	startedAt: Date;
	endsAt: Date;
	/** The Workspaces it reaches; null for everything the person reaches. */
	workspaceIds: string[] | null;
};

/** Who an admin session acts as now: its own person, or the person it impersonates. */
export type ActingAs = {
	personId: string;
	access: Access;
	impersonation: ImpersonationView | null;
};

/** Why starting is refused, beside the Permission: the Superadmin, another Staff member, yourself. */
export type ImpersonationRefusal = "superadmin" | "staff" | "self";

/** Impersonating this person isn't allowed (`reason`). */
export class ImpersonationRefusedError extends Error {
	override name = "ImpersonationRefusedError";
	readonly reason: ImpersonationRefusal;
	constructor(reason: ImpersonationRefusal) {
		super(
			reason === "superadmin"
				? "Nobody impersonates the Superadmin."
				: reason === "staff"
					? "Only the Superadmin impersonates Staff."
					: "You can't impersonate yourself.",
		);
		this.reason = reason;
	}
}

/**
 * What can't be done while impersonating: changing anything about the person's account (`what`
 * says which), a Sensitive action, Edit mode, the Staging address, or another impersonation.
 */
export type NotWhileImpersonating =
	| "password"
	| "twoFactor"
	| "sessions"
	| "apiTokens"
	| "aiClients"
	| "preferences"
	| "identityCheck"
	| "sensitiveAction"
	| "editMode"
	| "staging"
	| "impersonation";

/** Refused while impersonating: the person's account stays theirs, and some things only the impersonator does as themselves. */
export class NotWhileImpersonatingError extends Error {
	override name = "NotWhileImpersonatingError";
	readonly what: NotWhileImpersonating;
	constructor(what: NotWhileImpersonating) {
		super(
			what === "sensitiveAction" || what === "editMode" || what === "staging" || what === "impersonation"
				? "Stop impersonating first: this is only for you, as yourself."
				: "While you impersonate someone, nothing about their account can change.",
		);
		this.what = what;
	}
}

/** There is no such person, or none the impersonator may see. */
export class PersonNotFoundError extends Error {
	override name = "PersonNotFoundError";
	constructor() {
		super("There is no such person.");
	}
}

/** The impersonator has no second factor: impersonating needs an authenticator app or a passkey. */
export class ImpersonationNeedsSecondFactorError extends Error {
	override name = "ImpersonationNeedsSecondFactorError";
	constructor() {
		super("Add an authenticator app or a passkey to your own account before you impersonate anyone.");
	}
}

/** Refuses what can't be done while `access` impersonates someone. */
export function assertNotImpersonating(access: Pick<Access, "via">, what: NotWhileImpersonating): void {
	if (access.via.kind === "impersonation") throw new NotWhileImpersonatingError(what);
}

export type Impersonation = {
	/** Who an admin session acts as now, read on every request (an ended impersonation no longer counts). */
	actingAs(session: Session): Promise<ActingAs>;
	/**
	 * Checks that `access` may impersonate `personId` now, without starting: the Permission and the
	 * rules about who (404 for a person they can't see), and their own second factor. Run before the
	 * identity check, so nobody confirms who they are for something they may not do.
	 */
	check(access: Access, personId: string): Promise<void>;
	/** Starts impersonating `personId` in `session`, for at most an hour, and records it. */
	start(
		access: Access,
		session: Session,
		input: { personId: string; reason?: string; returnTo?: string },
	): Promise<ImpersonationView>;
	/**
	 * Ends the impersonation going on in `session`, if any, and records it. Answers the page it was
	 * started from (`returnTo`), or null when none was going on.
	 */
	stop(
		session: Session,
		reason: Extract<ImpersonationEnd, "stopped" | "signedOut">,
	): Promise<{ returnTo: string | null } | null>;
	/** Ends every impersonation whose hour ran out, and records each: the `impersonation.end` job. */
	endDue(): Promise<number>;
};

type Deps = {
	database: Database;
	clock: Clock;
	jobs: JobQueue;
	actors: { person(personId: string): Promise<PersonActor> };
	hasSecondFactor(personId: string): Promise<boolean>;
};

type Row = typeof impersonations.$inferSelect;

export function createImpersonation({ database, clock, jobs, actors, hasSecondFactor }: Deps): Impersonation {
	const { db } = database;
	const impersonator = alias(people, "impersonator");
	const impersonated = alias(people, "impersonated");

	const ownAccess = async (session: Session): Promise<ActingAs> => ({
		personId: session.personId,
		access: {
			actor: await actors.person(session.personId),
			via: { kind: "admin" },
			identityCheckedAt: session.identityCheckedAt,
		},
		impersonation: null,
	});

	/**
	 * Who `by` may impersonate `personId` as, now: where (`workspaceIds`, null for everywhere), or
	 * the refusal. Workspaces `by` can't see answer as if the person didn't exist.
	 */
	const reachOf = async (by: Actor, target: PersonActor): Promise<string[] | null> => {
		const byId = personIdOf(by);
		if (target.personId === byId) throw new ImpersonationRefusedError("self");
		if (target.installRole?.role === SUPERADMIN_ROLE) throw new ImpersonationRefusedError("superadmin");
		const onInstall = can(by, "impersonation.start", INSTALL);
		if (target.installRole) {
			if (!onInstall) throw new ImpersonationRefusedError("staff");
			return null;
		}
		if (onInstall) return null;
		const workspaces = target.memberships.map((membership) => membership.workspaceId);
		const allowed = workspaces.filter((workspaceId) =>
			can(by, "impersonation.start", { level: "workspace", workspaceId }),
		);
		if (allowed.length > 0) return allowed;
		const seen = workspaces.some((workspaceId) => can(by, "workspace.view", { level: "workspace", workspaceId }));
		if (seen) throw new PermissionDeniedError("impersonation.start");
		throw new PersonNotFoundError();
	};

	/** The person's access, limited to the Workspaces the impersonation reaches. */
	const limited = (actor: PersonActor, workspaceIds: readonly string[] | null): PersonActor =>
		workspaceIds === null
			? actor
			: {
					...actor,
					memberships: actor.memberships.filter((membership) => workspaceIds.includes(membership.workspaceId)),
				};

	/** The Workspaces its start and stop are recorded in; empty for the Install itself. */
	const recordedIn = async (row: Pick<Row, "personId" | "workspaceIds">): Promise<(string | null)[]> => {
		if (row.workspaceIds) return row.workspaceIds.length > 0 ? row.workspaceIds : [null];
		const target = await actors.person(row.personId);
		const workspaces = target.installRole ? [] : target.memberships.map((membership) => membership.workspaceId);
		return workspaces.length > 0 ? workspaces : [null];
	};

	const record = async (
		tx: Transaction,
		row: Row,
		via: AuditVia,
		action: "impersonation.start" | "impersonation.stop",
		details: AuditDetails,
	) => {
		for (const workspaceId of await recordedIn(row)) {
			await recordAudit(tx, clock.now(), { personId: row.personId, via, workspaceId, siteId: null, action, details });
		}
	};

	/** Ends one impersonation (when nothing else ended it first) and records it, in one transaction. */
	const end = async (row: Row, reason: ImpersonationEnd): Promise<boolean> => {
		const names = await namesOf(row.impersonatorId, row.personId);
		return db.transaction(async (tx) => {
			const now = clock.now();
			const [ended] = await tx
				.update(impersonations)
				.set({ endedAt: now, endReason: reason })
				.where(and(eq(impersonations.id, row.id), isNull(impersonations.endedAt)))
				.returning();
			if (!ended) return false;
			const via: AuditVia = { kind: "impersonation", name: names.impersonator.name, by: row.impersonatorId };
			await record(tx, ended, via, "impersonation.stop", {
				reason,
				startedAt: row.startedAt.toISOString(),
				minutes: Math.max(
					0,
					Math.round((Math.min(now.getTime(), row.endsAt.getTime()) - row.startedAt.getTime()) / 60_000),
				),
			});
			return true;
		});
	};

	const namesOf = async (impersonatorId: string, personId: string) => {
		const rows = await db
			.select({ id: people.id, name: people.name, email: people.email })
			.from(people)
			.where(inArray(people.id, [impersonatorId, personId]));
		const byId = new Map(rows.map((row) => [row.id, row]));
		const named = (id: string) => byId.get(id) ?? { id, name: "", email: "" };
		return { impersonator: named(impersonatorId), person: named(personId) };
	};

	const viewOf = (row: Row, names: Awaited<ReturnType<typeof namesOf>>): ImpersonationView => ({
		id: row.id,
		person: names.person,
		impersonator: names.impersonator,
		startedAt: row.startedAt,
		endsAt: row.endsAt,
		workspaceIds: row.workspaceIds,
	});

	return {
		async actingAs(session) {
			const now = clock.now();
			const [found] = await db
				.select({
					row: impersonations,
					impersonator: { id: impersonator.id, name: impersonator.name, email: impersonator.email },
					person: { id: impersonated.id, name: impersonated.name, email: impersonated.email },
				})
				.from(impersonations)
				.innerJoin(impersonator, eq(impersonator.id, impersonations.impersonatorId))
				.innerJoin(impersonated, eq(impersonated.id, impersonations.personId))
				.where(
					and(eq(impersonations.sessionId, session.id), isNull(impersonations.endedAt), gt(impersonations.endsAt, now)),
				);
			if (!found) return ownAccess(session);
			const { row } = found;
			// The impersonator's access is read fresh too: one who may no longer impersonate the person
			// (Staff no longer assigned to the Workspace) is back to themselves at once.
			const [by, target] = await Promise.all([actors.person(row.impersonatorId), actors.person(row.personId)]);
			let reach: string[] | null;
			try {
				reach = await reachOf(by, target);
			} catch {
				await end(row, "access");
				return ownAccess(session);
			}
			const workspaceIds =
				row.workspaceIds === null
					? reach
					: (row.workspaceIds ?? []).filter((id) => reach === null || reach.includes(id));
			if (workspaceIds !== null && workspaceIds.length === 0) {
				await end(row, "access");
				return ownAccess(session);
			}
			return {
				personId: row.personId,
				access: {
					actor: limited(target, workspaceIds),
					via: { kind: "impersonation", name: found.impersonator.name, by: row.impersonatorId },
					// The person never confirmed who they are here: no Sensitive action is theirs to take.
					identityCheckedAt: null,
				},
				impersonation: viewOf({ ...row, workspaceIds }, found),
			};
		},

		async check(access, personId) {
			assertNotImpersonating(access, "impersonation");
			const [person] = await db.select({ id: people.id }).from(people).where(eq(people.id, personId));
			if (!person) throw new PersonNotFoundError();
			await reachOf(access.actor, await actors.person(personId));
			const byId = personIdOf(access.actor);
			if (!byId || !(await hasSecondFactor(byId))) throw new ImpersonationNeedsSecondFactorError();
		},

		async start(access, session, input) {
			await this.check(access, input.personId);
			const workspaceIds = await reachOf(access.actor, await actors.person(input.personId));
			const names = await namesOf(session.personId, input.personId);
			const now = clock.now();
			const row = await db.transaction(async (tx) => {
				const [inserted] = await tx
					.insert(impersonations)
					.values({
						sessionId: session.id,
						impersonatorId: session.personId,
						personId: input.personId,
						workspaceIds,
						reason: input.reason ?? null,
						returnTo: input.returnTo ?? null,
						startedAt: now,
						endsAt: new Date(now.getTime() + IMPERSONATION_MAX_MS),
					})
					.returning();
				if (!inserted) throw new Error("The impersonation was not saved.");
				const via: AuditVia = { kind: "impersonation", name: names.impersonator.name, by: session.personId };
				await record(tx, inserted, via, "impersonation.start", {
					impersonator: names.impersonator,
					person: names.person,
					endsAt: inserted.endsAt.toISOString(),
					...(input.reason ? { reason: input.reason } : {}),
				});
				return inserted;
			});
			await jobs.send(impersonationEnd, {}, { startAfter: row.endsAt });
			return viewOf(row, names);
		},

		async stop(session, reason) {
			const [row] = await db
				.select()
				.from(impersonations)
				.where(and(eq(impersonations.sessionId, session.id), isNull(impersonations.endedAt)));
			if (!row) return null;
			await end(row, row.endsAt <= clock.now() ? "time" : reason);
			return { returnTo: row.returnTo };
		},

		async endDue() {
			const due = await db
				.select()
				.from(impersonations)
				.where(and(isNull(impersonations.endedAt), lte(impersonations.endsAt, clock.now())));
			let ended = 0;
			for (const row of due) if (await end(row, row.sessionId === null ? "signedOut" : "time")) ended++;
			return ended;
		},
	};
}

/**
 * Ends the impersonations whose hour ran out and records them: sent for the moment each one ends.
 * (Requests stop acting as the person at that moment by themselves; this writes it down.)
 */
export const impersonationEnd = defineJob({
	name: "impersonation.end",
	payload: z.object({}),
	async run(_payload, { impersonation, log }) {
		const ended = await impersonation.endDue();
		if (ended > 0) log.info("Impersonations ended at the end of their hour", { ended });
	},
});

import {
	type Auth,
	type PasskeyCreationOptions,
	type PasskeySummary,
	type RegistrationCredential,
	type SecondFactorMethod,
	type SecondFactorSummary,
	type Session,
	TwoFactorOffError,
} from "@webcraft/auth";
import type { Database, Transaction } from "@webcraft/db";
import {
	authenticators,
	installRoles,
	installSettings,
	memberships,
	passkeys,
	people,
	workspaces,
} from "@webcraft/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { revokeEveryToken } from "../api-tokens.ts";
import { type AuditDetails, type AuditVia, recordAudit } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { Email } from "../email/index.ts";
import { writeSettingsRow } from "../install-settings.ts";
import { revokeEveryGrant } from "../oauth.ts";
import { actingPerson, can } from "../permissions/can.ts";
import { STAFF_ROLE } from "../permissions/roles.ts";
import type { Access, InstallScope, WorkspaceScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { MemberNotFoundError } from "../tenancy/members.ts";
import { StaffNotFoundError } from "../tenancy/staff.ts";

/** How long "Remind me later" hides the reminder to add two-factor authentication. */
export const TWO_FACTOR_REMINDER_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a person must use two-factor authentication, and whether they do. `requiredBy` says who
 * requires it: the Install (the Superadmin's switch) and the Workspaces they are a Member of whose
 * Owners or Staff switched it on. Staff and the Superadmin follow the Install's switch only.
 */
export type TwoFactorStatus = {
	/** They have an authenticator app or a passkey. */
	on: boolean;
	methods: SecondFactorMethod[];
	required: boolean;
	requiredBy: { install: boolean; workspaces: { id: string; name: string }[] };
	/** Show the reminder to add it: off, not required, and not put off with "Remind me later". */
	reminder: boolean;
};

/** Two-factor authentication is required for the person and they have none: they must add it first. */
export class TwoFactorSetupRequiredError extends Error {
	override name = "TwoFactorSetupRequiredError";
	constructor() {
		super("Add two-factor authentication to your account to continue.");
	}
}

/** Removing this would leave a person who must use two-factor authentication without it. */
export class TwoFactorRequiredError extends Error {
	override name = "TwoFactorRequiredError";
	constructor() {
		super("Two-factor authentication is required for your account: add another way first.");
	}
}

/** A Workspace's Members and which second factors each has, for the Members screen. */
export type WorkspaceTwoFactor = {
	required: boolean;
	members: { personId: string; methods: SecondFactorMethod[] }[];
};

export type TwoFactor = {
	status(personId: string): Promise<TwoFactorStatus>;
	/**
	 * Whether the person must use two-factor authentication and has none yet. One query, made on
	 * every admin request, and on every Edit mode and Staging address request from an admin session.
	 */
	mustSetUp(personId: string): Promise<boolean>;
	/**
	 * Refuses everything but setting up two-factor authentication (`TwoFactorSetupRequiredError`)
	 * for a person who must use it and has none.
	 */
	assertSetUpWhenRequired(personId: string): Promise<void>;
	/** The person's second factors, as Your account shows them. */
	factors(personId: string): Promise<SecondFactorSummary>;
	startAuthenticator(access: Access, person: { email: string }): Promise<{ secret: string; uri: string }>;
	confirmAuthenticator(access: Access, session: Session, code: string): Promise<{ backupCodes: string[] | null }>;
	removeAuthenticator(access: Access, session: Session): Promise<{ signedOutSessions: number }>;
	regenerateBackupCodes(access: Access): Promise<{ backupCodes: string[] }>;
	/** Options for the person's device to make a passkey for the admin. */
	passkeyOptions(access: Access, person: { email: string; name: string }): Promise<PasskeyCreationOptions>;
	addPasskey(
		access: Access,
		session: Session,
		credential: RegistrationCredential,
		name: string,
	): Promise<{ passkey: PasskeySummary; backupCodes: string[] | null }>;
	removePasskey(access: Access, session: Session, passkeyId: string): Promise<{ signedOutSessions: number }>;
	/** Records that the person signed in with a backup code (it is used up). */
	backupCodeUsed(personId: string, via: AuditVia): Promise<void>;
	/** Hides the reminder for a while (`TWO_FACTOR_REMINDER_PAUSE_MS`). */
	remindLater(personId: string): Promise<{ until: Date }>;
	/** Install settings › Security: requires it for everyone on the Install. Open the Install with `install.manage`. */
	setInstallRequirement(scope: InstallScope, required: boolean): Promise<{ required: boolean }>;
	/** Requires it for a Workspace's Members. Open the Workspace with `twoFactor.require`. */
	setWorkspaceRequirement(scope: WorkspaceScope, required: boolean): Promise<{ required: boolean }>;
	/** Which second factors each of these people has (people with none answer `[]`), for the Staff screen. */
	methodsOf(personIds: readonly string[]): Promise<Map<string, SecondFactorMethod[]>>;
	/** The Members screen's column: open the Workspace with `member.manage`. */
	workspaceStatus(scope: WorkspaceScope): Promise<WorkspaceTwoFactor>;
	/**
	 * Resets a Member's two-factor authentication. Open the Workspace with `twoFactor.reset`; it is
	 * refused (`PermissionDeniedError`) unless the caller may reset it in every Workspace the person
	 * belongs to, since one account's second factor guards them all.
	 */
	resetMember(scope: WorkspaceScope, personId: string): Promise<void>;
	/** Resets a Staff member's two-factor authentication. Open the Install with `staff.manage`. */
	resetStaff(scope: InstallScope, personId: string): Promise<void>;
	/**
	 * `webcraft admin reset-2fa <email>`: resets anyone's two-factor authentication from the server,
	 * such as a Superadmin who lost theirs. Answers who it was, or null for an unknown address.
	 */
	resetByCommand(email: string): Promise<{ personId: string; email: string } | null>;
};

export function createTwoFactor({
	database,
	auth,
	clock,
	email,
	issuer,
}: {
	database: Database;
	auth: Auth;
	clock: Clock;
	email: Email;
	/** The name authenticator apps show for the Install's accounts: its own name, or WebCraft. */
	issuer: () => Promise<string>;
}): TwoFactor {
	const { db } = database;

	const personalAudit = (
		executor: Database["db"] | Transaction,
		access: Access,
		action: string,
		details: AuditDetails,
	) =>
		recordAudit(executor, clock.now(), {
			personId: actingPerson(access.actor),
			via: access.via,
			workspaceId: null,
			siteId: null,
			action,
			details,
		});

	const tellPerson = (personId: string, method: SecondFactorMethod, change: "added" | "removed") =>
		email.send({
			type: "two-factor-changed",
			to: [{ personId }],
			data: { method, change },
			related: { kind: "person", id: personId },
		});

	const methodsInSummary = (summary: SecondFactorSummary): SecondFactorMethod[] => [
		...(summary.authenticator ? (["authenticator"] as const) : []),
		...(summary.passkeys.length > 0 ? (["passkey"] as const) : []),
	];

	const status = async (personId: string): Promise<TwoFactorStatus> => {
		const [summary, [settings], [person], requiring] = await Promise.all([
			auth.secondFactors(personId),
			db.select({ required: installSettings.requireTwoFactor }).from(installSettings).where(eq(installSettings.id, 1)),
			db.select({ reminderUntil: people.twoFactorReminderUntil }).from(people).where(eq(people.id, personId)),
			db
				.select({ id: workspaces.id, name: workspaces.name })
				.from(memberships)
				.innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
				.where(and(eq(memberships.personId, personId), eq(workspaces.requireTwoFactor, true)))
				.orderBy(asc(workspaces.name), asc(workspaces.id)),
		]);
		const methods = methodsInSummary(summary);
		const install = settings?.required ?? false;
		const required = install || requiring.length > 0;
		const paused = person?.reminderUntil ? person.reminderUntil.getTime() > clock.now().getTime() : false;
		return {
			on: methods.length > 0,
			methods,
			required,
			requiredBy: { install, workspaces: requiring },
			reminder: methods.length === 0 && !required && !paused,
		};
	};

	const mustSetUp = async (personId: string): Promise<boolean> => {
		const result = await db.execute<{ must: boolean }>(sql`
			select (
				(coalesce((select ${installSettings.requireTwoFactor} from ${installSettings} where ${installSettings.id} = 1), false)
					or exists (
						select 1 from ${memberships} join ${workspaces} on ${workspaces.id} = ${memberships.workspaceId}
						where ${memberships.personId} = ${personId} and ${workspaces.requireTwoFactor}
					))
				and not exists (select 1 from ${authenticators} where ${authenticators.personId} = ${personId})
				and not exists (select 1 from ${passkeys} where ${passkeys.personId} = ${personId})
			) as must
		`);
		return result.rows[0]?.must === true;
	};

	const methodsOf = async (personIds: readonly string[]) => {
		const ids = [...new Set(personIds)];
		const [apps, keys] =
			ids.length === 0
				? [[], []]
				: await Promise.all([
						db
							.select({ personId: authenticators.personId })
							.from(authenticators)
							.where(inArray(authenticators.personId, ids)),
						db.selectDistinct({ personId: passkeys.personId }).from(passkeys).where(inArray(passkeys.personId, ids)),
					]);
		const withApp = new Set(apps.map((row) => row.personId));
		const withPasskey = new Set(keys.map((row) => row.personId));
		return new Map(
			ids.map((personId): [string, SecondFactorMethod[]] => [
				personId,
				[
					...(withApp.has(personId) ? (["authenticator"] as const) : []),
					...(withPasskey.has(personId) ? (["passkey"] as const) : []),
				],
			]),
		);
	};

	/** Refuses to remove a person's last second factor while they must use one. */
	const assertMayRemoveLast = async (personId: string, remainingAfter: number) => {
		if (remainingAfter > 0) return;
		if ((await status(personId)).required) throw new TwoFactorRequiredError();
	};

	/** Requiring it of others starts with having it yourself: a switch would otherwise lock its own setter in setup. */
	const assertOwnFirst = async (access: Access, required: boolean) => {
		if (required && !(await auth.hasSecondFactor(actingPerson(access.actor)))) throw new TwoFactorOffError();
	};

	/**
	 * Resets a person's second factors, logged as `twoFactor.reset` by `by` (null: WebCraft, from a
	 * server command) through `via`, in `workspaceId` (null: Install-level), and emails them.
	 */
	const reset = async (
		personId: string,
		{ by, via, workspaceId }: { by: string | null; via: AuditVia; workspaceId: string | null },
	) => {
		const [person] = await db.select({ email: people.email }).from(people).where(eq(people.id, personId));
		await auth.resetSecondFactors(personId, async (tx, change) => {
			// A reset answers "someone else may have had this account": the API tokens and AI clients
			// made with it act as the person just the same, so they end with the sessions.
			const now = clock.now();
			const revokedTokens = await revokeEveryToken(tx, personId, now, { personId: by, via });
			const revokedAiClients = await revokeEveryGrant(tx, personId, now, { personId: by, via });
			await recordAudit(tx, now, {
				personId: by,
				via,
				workspaceId,
				siteId: null,
				action: "twoFactor.reset",
				details: { personId, email: person?.email ?? null, ...change, revokedTokens, revokedAiClients },
			});
		});
		const resetBy = by ? await nameOf(by) : null;
		await email.send({
			type: "two-factor-reset",
			to: [{ personId }],
			data: { resetBy },
			related: { kind: "person", id: personId },
		});
	};

	const nameOf = async (personId: string) =>
		(await db.select({ name: people.name }).from(people).where(eq(people.id, personId)))[0]?.name ?? null;

	return {
		status,

		mustSetUp,

		async assertSetUpWhenRequired(personId) {
			if (await mustSetUp(personId)) throw new TwoFactorSetupRequiredError();
		},

		factors: (personId) => auth.secondFactors(personId),

		async startAuthenticator(access, person) {
			return auth.startAuthenticator(actingPerson(access.actor), { issuer: await issuer(), accountName: person.email });
		},

		async confirmAuthenticator(access, session, code) {
			const result = await auth.confirmAuthenticator(session, code, (tx, change) =>
				personalAudit(tx, access, "twoFactor.add", { method: "authenticator", ...change }),
			);
			await tellPerson(session.personId, "authenticator", "added");
			return { backupCodes: result.backupCodes };
		},

		async removeAuthenticator(access, session) {
			const summary = await auth.secondFactors(session.personId);
			await assertMayRemoveLast(session.personId, summary.passkeys.length);
			const result = await auth.removeAuthenticator(session, (tx, change) =>
				personalAudit(tx, access, "twoFactor.remove", { method: "authenticator", ...change }),
			);
			await tellPerson(session.personId, "authenticator", "removed");
			return { signedOutSessions: result.signedOutSessions };
		},

		async passkeyOptions(access, person) {
			return auth.passkeyRegistrationOptions(
				actingPerson(access.actor),
				{ name: person.email, displayName: person.name },
				await issuer(),
			);
		},

		async addPasskey(access, session, credential, name) {
			const result = await auth.addPasskey(session, credential, name, (tx, change) =>
				personalAudit(tx, access, "twoFactor.add", { method: "passkey", name, ...change }),
			);
			await tellPerson(session.personId, "passkey", "added");
			return { passkey: result.passkey, backupCodes: result.backupCodes };
		},

		async removePasskey(access, session, passkeyId) {
			const summary = await auth.secondFactors(session.personId);
			const others = summary.passkeys.filter((passkey) => passkey.id !== passkeyId).length;
			await assertMayRemoveLast(session.personId, others + (summary.authenticator ? 1 : 0));
			const result = await auth.removePasskey(session, passkeyId, (tx, change) =>
				personalAudit(tx, access, "twoFactor.remove", { method: "passkey", ...change }),
			);
			await tellPerson(session.personId, "passkey", "removed");
			return { signedOutSessions: result.signedOutSessions };
		},

		async regenerateBackupCodes(access) {
			const backupCodes = await auth.regenerateBackupCodes(actingPerson(access.actor), (tx) =>
				personalAudit(tx, access, "backupCodes.regenerate", {}),
			);
			return { backupCodes };
		},

		async backupCodeUsed(personId, via) {
			const { backupCodesLeft } = await auth.secondFactors(personId);
			await recordAudit(db, clock.now(), {
				personId,
				via,
				workspaceId: null,
				siteId: null,
				action: "backupCode.use",
				details: { left: backupCodesLeft },
			});
		},

		async remindLater(personId) {
			const until = new Date(clock.now().getTime() + TWO_FACTOR_REMINDER_PAUSE_MS);
			await db.update(people).set({ twoFactorReminderUntil: until }).where(eq(people.id, personId));
			return { until };
		},

		async setInstallRequirement(scope, required) {
			await assertOwnFirst(scope.access, required);
			await scope.transaction(async (tx) => {
				const [before] = await tx.db
					.select({ required: installSettings.requireTwoFactor })
					.from(installSettings)
					.where(eq(installSettings.id, 1));
				await writeSettingsRow(tx.db, { requireTwoFactor: required });
				await tx.audit("twoFactorRequirement.change", { from: before?.required ?? false, to: required });
			});
			return { required };
		},

		async setWorkspaceRequirement(scope, required) {
			await assertOwnFirst(scope.access, required);
			await scope.transaction(async (tx) => {
				const [before] = await tx.db
					.select({ required: workspaces.requireTwoFactor })
					.from(workspaces)
					.where(eq(workspaces.id, tx.workspace.id))
					.for("update");
				await tx.db.update(workspaces).set({ requireTwoFactor: required }).where(eq(workspaces.id, tx.workspace.id));
				await tx.audit("twoFactorRequirement.change", { from: before?.required ?? false, to: required });
			});
			return { required };
		},

		methodsOf,

		async workspaceStatus(scope) {
			const [workspace] = await scope.db
				.select({ required: workspaces.requireTwoFactor })
				.from(workspaces)
				.where(eq(workspaces.id, scope.workspace.id));
			const ids = (await scope.select(memberships)).map((member) => member.personId);
			const methods = await methodsOf(ids);
			return {
				required: workspace?.required ?? false,
				members: ids.map((personId) => ({ personId, methods: methods.get(personId) ?? [] })),
			};
		},

		async resetMember(scope, personId) {
			const member = await scope.first(memberships, eq(memberships.personId, personId));
			if (!member) throw new MemberNotFoundError();
			// A person has one account, so its second factor guards each of their Memberships: only
			// someone who may reset it in every Workspace they belong to resets it (else the Superadmin).
			const theirs = await db
				.select({ workspaceId: memberships.workspaceId })
				.from(memberships)
				.where(eq(memberships.personId, personId));
			for (const { workspaceId } of theirs) {
				if (!can(scope.access.actor, "twoFactor.reset", { level: "workspace", workspaceId })) {
					throw new PermissionDeniedError("twoFactor.reset");
				}
			}
			await reset(personId, {
				by: actingPerson(scope.access.actor),
				via: scope.access.via,
				workspaceId: scope.workspace.id,
			});
		},

		async resetStaff(scope, personId) {
			const [staff] = await scope.db
				.select({ personId: installRoles.personId })
				.from(installRoles)
				.where(and(eq(installRoles.personId, personId), eq(installRoles.role, STAFF_ROLE)));
			if (!staff) throw new StaffNotFoundError();
			await reset(personId, { by: actingPerson(scope.access.actor), via: scope.access.via, workspaceId: null });
		},

		async resetByCommand(address) {
			const normalised = address.trim().toLowerCase();
			const [person] = await db
				.select({ id: people.id, email: people.email })
				.from(people)
				.where(eq(people.email, normalised));
			if (!person) return null;
			await reset(person.id, { by: null, via: { kind: "command", name: "reset-2fa" }, workspaceId: null });
			return { personId: person.id, email: person.email };
		},
	};
}

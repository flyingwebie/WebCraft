import type { Access } from "../tenancy/data-layer.ts";

/**
 * Sensitive actions: the one list. Each needs a fresh identity check (a password, passkey or 2FA
 * check within the last 10 minutes) in the admin session it comes from, and is refused for good to
 * everything that isn't an admin session, such as API tokens and OAuth grants (ADR 0030).
 *
 * A procedure takes one with `.use(sensitive("<action>"))` after its permission check (see
 * `packages/api/src/context.ts`). Adding one: add it here with the reason, mark its procedure, and
 * add its row to `tests/auth/sensitive-actions.test.ts` (a guard test fails until you do).
 */
export const SENSITIVE_ACTIONS = {
	/** The Install SMTP: its password is a secret. */
	"installSmtp.change": "changes a secret",
	/** Inviting Staff. */
	"staff.invite": "grants a role",
	/** Which Workspaces a Staff member reaches. */
	"staff.changeWorkspaces": "changes what a person can reach",
	/** Inviting a Member into a Workspace. */
	"member.invite": "grants a role",
	/** A Member's role and Sites. */
	"member.changeAccess": "changes what a person can reach",
	/** Removing a Member from a Workspace. */
	"member.remove": "changes what a person can reach",
	/** Confirming the running Master key is stored outside the server ends the reminder for good. */
	"masterKey.confirmStored": "vouches for the Master key backup",
	/** A person's own password. */
	"password.change": "changes how a person signs in",
	/** The leaked-password check on new passwords, Install-wide. */
	"leakedPasswordCheck.change": "changes how passwords are checked",
	/** Approving a Module: what it asks for (Permissions, outside hosts, email) is granted. */
	"module.approve": "grants a Module access",
} as const satisfies Record<string, string>;

export type SensitiveAction = keyof typeof SENSITIVE_ACTIONS;

/** Every Sensitive action, in the order of `SENSITIVE_ACTIONS`. */
export const ALL_SENSITIVE_ACTIONS = Object.keys(SENSITIVE_ACTIONS) as SensitiveAction[];

/** How recent an identity check must be for a Sensitive action. */
export const RECENT_IDENTITY_CHECK_MS = 10 * 60 * 1000;

/** A Sensitive action without an identity check in the last 10 minutes: confirm, then try again. */
export class IdentityCheckRequiredError extends Error {
	override name = "IdentityCheckRequiredError";
	readonly action: SensitiveAction;
	constructor(action: SensitiveAction) {
		super("Confirm it's you to continue: this action needs a password check within the last 10 minutes.");
		this.action = action;
	}
}

/** A Sensitive action from anything other than a person's admin session, such as an API token. Never allowed. */
export class SensitiveActionRefusedError extends Error {
	override name = "SensitiveActionRefusedError";
	readonly action: SensitiveAction;
	constructor(action: SensitiveAction) {
		super("This action is only available to a person signed in to the admin.");
		this.action = action;
	}
}

/**
 * Refuses a Sensitive action that `access` may not take now: anything but a person in an admin
 * session for good (`SensitiveActionRefusedError`), and a person whose last identity check in that
 * session is more than 10 minutes old (`IdentityCheckRequiredError`). Check the Permission first.
 */
export function assertSensitiveActionAllowed(access: Access, action: SensitiveAction, now: Date): void {
	const { actor, via, identityCheckedAt } = access;
	if (actor.kind !== "person" || via.kind !== "admin" || identityCheckedAt === undefined) {
		throw new SensitiveActionRefusedError(action);
	}
	const age = identityCheckedAt ? now.getTime() - identityCheckedAt.getTime() : Number.POSITIVE_INFINITY;
	if (age > RECENT_IDENTITY_CHECK_MS) throw new IdentityCheckRequiredError(action);
}

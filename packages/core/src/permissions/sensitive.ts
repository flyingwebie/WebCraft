import { assertNotImpersonating } from "../impersonation.ts";
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
	/** A live Import login, bound to its source. */
	"import.connect": "changes a secret",
	/** The Install SMTP: its password is a secret. */
	"installSmtp.change": "changes a secret",
	/** Inviting Staff. */
	"staff.invite": "grants a role",
	/** Which Workspaces a Staff member reaches. */
	"staff.changeWorkspaces": "changes what a person can reach",
	/** Ending a Staff member's role: everything they hold ends with it. */
	"staff.remove": "changes what a person can reach",
	/** Deactivating anyone's account: they can no longer sign in, and everything they hold ends. */
	"account.deactivate": "changes what a person can reach",
	/** Reactivating an account: the person signs in again, with the roles they had. */
	"account.reactivate": "changes what a person can reach",
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
	/**
	 * A person's own second factors: adding or removing an authenticator app or a passkey, and making
	 * new backup codes. Each also ends the person's other sessions.
	 */
	"twoFactor.change": "changes how a person signs in",
	/** Resetting someone else's two-factor authentication (the Superadmin, or Staff for their Workspaces' Members). */
	"twoFactor.reset": "changes how a person signs in",
	/** Requiring two-factor authentication, or no longer requiring it: on the Install, or for a Workspace's Members. */
	"twoFactorRequirement.change": "changes how people sign in",
	/** The leaked-password check on new passwords, Install-wide. */
	"leakedPasswordCheck.change": "changes how passwords are checked",
	/** Where the Install stores Media: an S3-compatible bucket's secret key is a secret. */
	"storage.change": "changes a secret",
	/** Install settings › Backups: where Backups go (a bucket's secret access key is a secret), and whether they are taken. */
	"backups.change": "changes a secret",
	/** Approving a Module: what it asks for (Permissions, outside hosts, email) is granted. */
	"module.approve": "grants a Module access",
	/**
	 * Adding a Webhook, or changing where it is sent, what it receives or its signing secret: it sends
	 * the Site's data to an outside address, signed with a secret. Never for an API token or AI client,
	 * which could otherwise open a channel out of the Site. Switching one off, removing it, a test
	 * send and a redelivery only use what was confirmed.
	 */
	"webhook.change": "sends Site data to an outside address",
	/**
	 * Changing who receives a Form's Submissions: a Notification's recipients or routing, in its emails
	 * Draft (saved, or restored from their history). Every later Submission goes to those addresses once
	 * the emails are published. Never for an API token or AI client, which could otherwise read every
	 * Submission without the Submissions Toolset. Their words and the Auto-reply stay a plain change.
	 */
	"formRecipients.change": "sends Form Submissions to an outside address",
	/**
	 * Changing who receives a Report: making one with recipients, or adding or removing an address.
	 * Each Report sends a Dashboard's figures to its recipients. Never for an API token or AI client,
	 * which could otherwise send a client's figures to any address. Checked in core where recipients
	 * are written; the Report's other settings stay a plain change.
	 */
	"reportRecipients.change": "sends a Dashboard's figures to an outside address",
	/** A Site's CAPTCHA for its Forms: its secret key is a secret. */
	"formCaptcha.change": "changes a secret",
	/** A Site's email settings: its own mail server's password is a secret, and it decides where the Site's mail comes from. */
	"siteSmtp.change": "changes a secret",
	/**
	 * An AI key: setting, replacing or removing a Workspace's own key or a shared Install key (each a
	 * secret, and where it is sent), and letting shared keys reach endpoints inside the Install's network.
	 */
	"aiKey.change": "changes a secret",
	/**
	 * A Site's staging password: a shared secret that lets people without an account see the Site's
	 * Drafts on its Staging address.
	 */
	"stagingPassword.change": "changes a secret",
	/**
	 * Making a Share link, or changing its password or expiry: the link opens a Dashboard to anyone who
	 * holds it (and its password, when it has one), outside the admin. Never for an API token or AI
	 * client, which could otherwise hand a client's figures to anyone. Revoking one isn't Sensitive.
	 */
	"shareLink.change": "sends a Dashboard to anyone holding a link",
	/**
	 * Impersonating a person (ADR 0008): the admin acts as them for up to an hour. It also needs the
	 * impersonator's own second factor.
	 */
	"impersonation.start": "acts as another person",
	/** How long the Audit log keeps entries: a shorter time removes older ones. */
	"auditRetention.change": "removes Audit log entries",
	/**
	 * Exporting a Site (ADR 0033): the archive carries all of the Site's data out of the Install, and its
	 * secrets under a passphrase.
	 */
	"site.export": "carries a Site's data out of the Install",
	/** Importing a Site export: it brings a Site's data and secrets in, and invites its Members. */
	"site.import": "brings a Site's data and secrets into the Workspace",
	/**
	 * Making a Content key, or switching a Site's Content API on: a frontend holding a key reads the
	 * Site's published Fields from outside, the ones no page shows too, and the key outlives whoever
	 * made it. Never for an API token or AI client, which could otherwise mint a credential that keeps
	 * working after it is revoked. Switching it off, hiding, renaming, origins and revoking stay plain.
	 */
	"contentApi.open": "creates a credential",
	/** Creating an API token: a credential that acts as the person, outside the admin. */
	"apiToken.create": "creates a credential",
	/** Approving an AI client: its grant's tokens act as the person, outside the admin. */
	"aiClient.approve": "creates a credential",
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
	// The identity check would be the impersonator's, never the person's.
	assertNotImpersonating(access, "sensitiveAction");
	if (actor.kind !== "person" || via.kind !== "admin" || identityCheckedAt === undefined) {
		throw new SensitiveActionRefusedError(action);
	}
	const age = identityCheckedAt ? now.getTime() - identityCheckedAt.getTime() : Number.POSITIVE_INFINITY;
	if (age > RECENT_IDENTITY_CHECK_MS) throw new IdentityCheckRequiredError(action);
}

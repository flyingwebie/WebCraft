/** Where a code was given: setting up an authenticator app, signing in, or confirming who you are. */
export type CodeUse = "setup" | "sign-in" | "identity";

/**
 * A code from an authenticator app, or a backup code, is wrong: not the app's code now (or a step
 * either side), already used, or not one of the person's unused backup codes.
 */
export class TwoFactorCodeInvalidError extends Error {
	override name = "TwoFactorCodeInvalidError";
	readonly during: CodeUse;
	constructor(during: CodeUse) {
		super("The code is wrong or was already used. Check it and try again.");
		this.during = during;
	}
}

/**
 * The second step of signing in came without a right password first in this browser, or more than
 * 5 minutes after it: sign in again from the start.
 */
export class SignInExpiredError extends Error {
	override name = "SignInExpiredError";
	constructor() {
		super("Sign in again with your email and password.");
	}
}

/** The person already has an authenticator app: remove it first to add another. */
export class AuthenticatorExistsError extends Error {
	override name = "AuthenticatorExistsError";
	constructor() {
		super("An authenticator app is already added. Remove it first to add another one.");
	}
}

/** The person has no such second factor (no authenticator app, or no such passkey). */
export class SecondFactorNotFoundError extends Error {
	override name = "SecondFactorNotFoundError";
	constructor(what: "authenticator" | "passkey") {
		super(what === "authenticator" ? "No authenticator app is added." : "There is no such passkey.");
	}
}

/** Backup codes go with two-factor authentication: the person has no second factor yet. */
export class TwoFactorOffError extends Error {
	override name = "TwoFactorOffError";
	constructor() {
		super("Add an authenticator app or a passkey first.");
	}
}

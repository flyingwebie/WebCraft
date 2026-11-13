import { hashPassword as libraryHash, verifyPassword as libraryVerify } from "better-auth/crypto";

/** The shortest password a person may choose, in characters. */
export const MIN_PASSWORD_LENGTH = 12;

/** The longest password WebCraft accepts, in characters; longer ones only slow hashing down. */
export const MAX_PASSWORD_LENGTH = 128;

/** Why a new password was refused. */
export type PasswordProblem = "too-short" | "too-long" | "leaked";

/**
 * An extra check on new passwords, such as the leaked-password lookup: it answers the problem it
 * found, or null. Checks run after the length rules, in order.
 */
export type PasswordCheck = (password: string) => Promise<PasswordProblem | null>;

/** A new password was refused. `problem` says why; the message never contains the password. */
export class PasswordRefusedError extends Error {
	override name = "PasswordRefusedError";
	readonly problem: PasswordProblem;
	constructor(problem: PasswordProblem) {
		super(
			problem === "too-short"
				? `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`
				: problem === "too-long"
					? `Passwords can have at most ${MAX_PASSWORD_LENGTH} characters.`
					: "This password appears in lists of leaked passwords. Choose another one.",
		);
		this.problem = problem;
	}
}

/** Refuses a password a person may not choose, with `PasswordRefusedError`. */
export async function assertNewPasswordAllowed(password: string, checks: readonly PasswordCheck[] = []): Promise<void> {
	const length = Array.from(password).length;
	if (length < MIN_PASSWORD_LENGTH) throw new PasswordRefusedError("too-short");
	if (length > MAX_PASSWORD_LENGTH) throw new PasswordRefusedError("too-long");
	for (const check of checks) {
		const problem = await check(password);
		if (problem) throw new PasswordRefusedError(problem);
	}
}

/** Hashes a password for storage (scrypt). Every stored password goes through this one function. */
export function hashPassword(password: string): Promise<string> {
	return libraryHash(password);
}

/** Checks a password against a stored hash. */
export function verifyPassword(hash: string, password: string): Promise<boolean> {
	return libraryVerify({ hash, password });
}

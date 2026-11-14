import type { Transaction } from "@webcraft/db";
import { credentials, people } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { assertNewPasswordAllowed, hashPassword, type PasswordCheck } from "./passwords.ts";

declare const checked: unique symbol;

/**
 * A new person's password, already checked against the password rules (the leaked-password check
 * among them) and hashed: what `createPerson` stores. Only `newPassword` makes one, and it runs
 * outside any transaction: the checks may call out and read Install settings, and hashing takes a
 * while, none of which may happen while a transaction holds a database connection.
 */
export type NewPassword = { readonly hash: string; readonly [checked]: true };

/** Checks a new person's password and hashes it (`PasswordRefusedError` when the rules refuse it). */
export async function newPassword(password: string, passwordChecks?: readonly PasswordCheck[]): Promise<NewPassword> {
	await assertNewPasswordAllowed(password, passwordChecks);
	return { hash: await hashPassword(password) } as NewPassword;
}

/** The provider id the sign-in library gives password credentials. */
export const PASSWORD_PROVIDER = "credential";

export type NewPerson = {
	name: string;
	email: string;
	/** Made by `newPassword` before the transaction. */
	password: NewPassword;
	/** The person's own Admin language; omit to follow the Install's default. */
	adminLanguage?: string;
};

/** Another person already has this email address. */
export class EmailInUseError extends Error {
	override name = "EmailInUseError";
}

/** The email address can't be used to sign in. */
export class InvalidEmailError extends Error {
	override name = "InvalidEmailError";
}

/** Emails are compared and stored in this form. */
export function normaliseEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** Deliberately loose: one `@`, something on each side, a dot in the domain, no spaces. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Refuses an email address that can't be someone's sign-in, with `InvalidEmailError`. */
export function assertValidEmail(email: string): void {
	const normalised = normaliseEmail(email);
	if (normalised.length > 254 || !EMAIL_SHAPE.test(normalised)) {
		throw new InvalidEmailError("Enter an email address such as name@example.com.");
	}
}

/**
 * Creates a person who signs in with an email and password, inside the caller's transaction, so
 * whatever else the caller records (a role, a Membership) is saved together with them or not at all.
 * The password was checked and hashed before (`newPassword`). Refuses a malformed email
 * (`InvalidEmailError`) and one another person already has (`EmailInUseError`).
 */
export async function createPerson(
	tx: Transaction,
	person: NewPerson,
	options: { now: Date },
): Promise<{ personId: string }> {
	assertValidEmail(person.email);
	const email = normaliseEmail(person.email);
	const [existing] = await tx.select({ id: people.id }).from(people).where(eq(people.email, email));
	if (existing) throw new EmailInUseError(`Another person already signs in with ${email}.`);

	const [created] = await tx
		.insert(people)
		.values({
			name: person.name.trim(),
			email,
			emailVerified: false,
			adminLanguage: person.adminLanguage ?? null,
			createdAt: options.now,
			updatedAt: options.now,
		})
		.returning({ id: people.id });
	if (!created) throw new Error("The new person was not saved.");
	await tx.insert(credentials).values({
		personId: created.id,
		// The library identifies a password credential by the person's own id.
		accountId: created.id,
		providerId: PASSWORD_PROVIDER,
		password: person.password.hash,
		createdAt: options.now,
		updatedAt: options.now,
	});
	return { personId: created.id };
}

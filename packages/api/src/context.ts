import { ORPCError, os } from "@orpc/server";
import { type InstallServices, type Person, SUPERADMIN_ROLE } from "@webcraft/core";

import { toApiError } from "./errors.ts";

/** What every procedure receives. It grows with the actor kinds (API tokens, OAuth grants). */
export type ApiContext = {
	services: InstallServices;
	/** The request's headers: cookies, origin, language. */
	headers: Headers;
	/** Headers the answer will carry, such as the `Set-Cookie` that starts or ends a session. */
	resHeaders?: Headers;
};

const base = os.$context<ApiContext>();

/** The builder every procedure starts from. Errors from WebCraft's modules leave it as API errors. */
export const procedure = base.use(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		throw toApiError(error);
	}
});

/** Adds `Set-Cookie` lines to the answer. */
export function setCookies(context: ApiContext, lines: readonly string[]): void {
	for (const line of lines) context.resHeaders?.append("set-cookie", line);
}

/**
 * Reads the session the request carries and the person it belongs to (`context.person`, null when
 * signed out). An ended session's cookie is cleared in the answer.
 */
export const withPerson = base.middleware(async ({ context, next }) => {
	const { session, setCookie } = await context.services.auth.session(context.headers);
	setCookies(context, setCookie);
	const person: Person | null = session ? await context.services.people.get(session.personId) : null;
	return next({ context: { person, sessionId: session?.id ?? null } });
});

/** Procedures for signed-in people: refuses everyone else with `UNAUTHORIZED`. */
export const signedIn = procedure.use(withPerson).use(async ({ context, next }) => {
	if (!context.person) throw new ORPCError("UNAUTHORIZED", { message: "Sign in first." });
	return next({ context: { person: context.person } });
});

/**
 * Procedures only the Superadmin may call: refuses everyone else with `FORBIDDEN`. The permission
 * check (`can()`) replaces this when roles arrive.
 */
export const superadminOnly = signedIn.use(async ({ context, next }) => {
	if (context.person.installRole !== SUPERADMIN_ROLE) {
		throw new ORPCError("FORBIDDEN", { message: "Only the Superadmin can do this." });
	}
	return next();
});

/**
 * Sensitive actions, such as changing an SMTP server or another secret. The recent identity check
 * (#55) goes here, and refuses API tokens and OAuth grants; until then it lets every caller through.
 */
export const sensitive = base.middleware(({ next }) => next());

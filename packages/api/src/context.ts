import { ORPCError, os } from "@orpc/server";
import type { Access, AuditVia, InstallServices, Permission, Person } from "@webcraft/core";

import { toApiError } from "./errors.ts";

/** What every procedure receives. It grows with the actor kinds (API tokens, OAuth grants). */
export type ApiContext = {
	services: InstallServices;
	/** The request's headers: cookies, origin, language. */
	headers: Headers;
	/** Headers the answer will carry, such as the `Set-Cookie` that starts or ends a session. */
	resHeaders?: Headers;
	/** How the call came in, for the Audit log: `admin` at `/api/rpc`. */
	via: AuditVia;
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

/**
 * Procedures for signed-in people: refuses everyone else with `UNAUTHORIZED`. Gives the procedure
 * `context.access`, the person as `can()` sees them and how they came in, which opens the data layer:
 *
 *     const workspace = await context.services.data.workspace(context.access, input.workspaceId, "site.create");
 */
export const signedIn = procedure.use(withPerson).use(async ({ context, next }) => {
	if (!context.person) throw new ORPCError("UNAUTHORIZED", { message: "Sign in first." });
	const actor = await context.services.actors.person(context.person.id);
	const access: Access = { actor, via: context.via };
	return next({ context: { person: context.person, access } });
});

/**
 * Procedures that need one Permission on the Install, such as `install.manage`: refuses everyone
 * else with `FORBIDDEN`. Gives the procedure `context.install`, the Install scope it opened.
 */
export function onInstall(permission: Permission) {
	return signedIn.use(async ({ context, next }) => {
		const install = await context.services.data.install(context.access, permission);
		return next({ context: { install } });
	});
}

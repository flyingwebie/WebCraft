import { ORPCError, os } from "@orpc/server";
import type { Session } from "@webcraft/auth";
import {
	type Access,
	type ActingAs,
	type ApiClientUse,
	type AuditVia,
	assertNotImpersonating,
	assertSensitiveActionAllowed,
	type ImpersonationView,
	type InstallServices,
	type NotWhileImpersonating,
	type Permission,
	type Person,
	type PersonActor,
	type RateLimitName,
	type SensitiveAction,
} from "@webcraft/core";

import { toApiError } from "./errors.ts";

/** What every procedure receives. */
export type ApiContext = {
	services: InstallServices;
	/** The request's headers: cookies, origin, language. */
	headers: Headers;
	/** The address of the client the request came from, or null when the web process can't tell. */
	clientAddress: string | null;
	/** Headers the answer will carry, such as the `Set-Cookie` that starts or ends a session. */
	resHeaders?: Headers;
	/**
	 * How the call came in, for the Audit log: `admin` at `/api/rpc`, `token` at `/api/v1` (or the
	 * MCP server, with an API token), `aiClient` through the MCP server with an OAuth grant.
	 */
	via: AuditVia;
	/**
	 * The API client a call at `/api/v1` or through the MCP server came with (an API token, or an AI
	 * client's OAuth grant), already checked: the call acts as its person within its limits, and
	 * never reads a session cookie.
	 */
	client?: ApiClientUse;
};

const base = os.$context<ApiContext>();

/** The builder every procedure starts from. Errors from WebCraft's modules leave it as API errors. */
export const procedure = base.use(async ({ context, next }) => {
	try {
		return await next();
	} catch (error) {
		const answer = toApiError(error);
		// Refusals that pass with time (a locked account, too many requests) say when to try again.
		const retryAfter =
			answer instanceof ORPCError ? (answer.data as { retryAfterSeconds?: unknown })?.retryAfterSeconds : undefined;
		if (typeof retryAfter === "number") context.resHeaders?.set("retry-after", String(retryAfter));
		throw answer;
	}
});

/** Adds `Set-Cookie` lines to the answer. */
export function setCookies(context: ApiContext, lines: readonly string[]): void {
	for (const line of lines) context.resHeaders?.append("set-cookie", line);
}

/**
 * Counts the request against a rate limit for its client address (`RATE_LIMITS` in
 * `@webcraft/core`), refusing it with `TOO_MANY_REQUESTS` and a `Retry-After` once the address used
 * the limit up. Auth endpoints (anything that checks a password, a setup token or an invite link)
 * use `rateLimited("auth")`.
 */
export function rateLimited(name: RateLimitName) {
	return base.middleware(async ({ context, next }) => {
		await context.services.rateLimits.hit(name, context.clientAddress);
		return next();
	});
}

/** The auth endpoints: procedures that check a password, a setup token or an invite link. */
export const authEndpoint = procedure.use(rateLimited("auth"));

/**
 * Reads the session the request carries and the person it acts as (`context.person`, null when
 * signed out): its own person, or the person it impersonates while an impersonation goes on
 * (`context.acting.impersonation`). An ended session's cookie is cleared in the answer.
 */
export const withPerson = base.middleware(async ({ context, next }) => {
	if (context.client) {
		return next({ context: { person: context.client.person as Person | null, session: null, acting: null } });
	}
	const { session, setCookie } = await context.services.auth.session(context);
	setCookies(context, setCookie);
	const acting: ActingAs | null = session ? await context.services.impersonation.actingAs(session) : null;
	const person: Person | null = acting ? await context.services.people.get(acting.personId) : null;
	return next({ context: { person, session: person ? session : null, acting: person ? acting : null } });
});

/**
 * Signed-in people, before the check that someone who must use two-factor authentication has it:
 * only for what they need to add it. Everything else starts from `signedIn`.
 */
export const signedInBeforeTwoFactor = procedure.use(withPerson).use(async ({ context, next }) => {
	const { person, session, client, acting } = context;
	if (client && person) {
		return next({
			context: {
				person,
				session: null as Session | null,
				access: client.access,
				impersonation: null as ImpersonationView | null,
			},
		});
	}
	if (!person || !session || !acting) throw new ORPCError("UNAUTHORIZED", { message: "Sign in first." });
	return next({
		context: { person, session: session as Session | null, access: acting.access, impersonation: acting.impersonation },
	});
});

/**
 * Procedures for signed-in people, in the admin or through an API token: refuses everyone else with
 * `UNAUTHORIZED`. Gives the procedure `context.access`, the person (or their token) as `can()` sees
 * them and how they came in, which opens the data layer:
 *
 *     const workspace = await context.services.data.workspace(context.access, input.workspaceId, "site.create");
 *
 * A person in the admin who must use two-factor authentication and has none yet is refused
 * everything here (`TWO_FACTOR_SETUP_REQUIRED`) until they add it: the few procedures they need for
 * that start from `signedInBeforeTwoFactor` instead.
 *
 * `context.session` is the admin session, null for a token: procedures that need one (a person's
 * own sessions, confirming who they are) start from `inAdminSession` instead. While the session
 * impersonates someone, `context.person` and `context.access` are theirs and `context.session` stays
 * the impersonator's own (`context.impersonation` says who is who): a procedure that changes a
 * person's account refuses then (`notWhileImpersonating`).
 */
export const signedIn = signedInBeforeTwoFactor.use(async ({ context, next }) => {
	// The requirement is about whoever signed in: an impersonated person's isn't the impersonator's.
	if (context.session) await context.services.twoFactor.assertSetUpWhenRequired(context.session.personId);
	return next();
});

/**
 * The person as `can()` sees them in this call: while impersonating, limited to the Workspaces the
 * impersonation reaches.
 */
export async function personActorOf(context: {
	access: Access;
	person: Person;
	services: InstallServices;
}): Promise<PersonActor> {
	return context.access.actor.kind === "person"
		? context.access.actor
		: context.services.actors.person(context.person.id);
}

/** Procedures for a person in an admin session (never an API token): `context.session` is theirs. */
export const inAdminSession = signedIn.use(({ context, next }) => {
	const { session } = context;
	if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Sign in to the admin first." });
	return next({ context: { session } });
});

/**
 * Procedures for a person in an admin session that stay open while they must still add two-factor
 * authentication: adding it, and confirming who they are first.
 */
export const inAdminSessionBeforeTwoFactor = signedInBeforeTwoFactor.use(({ context, next }) => {
	const { session } = context;
	if (!session) throw new ORPCError("UNAUTHORIZED", { message: "Sign in to the admin first." });
	return next({ context: { session } });
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

/**
 * Procedures in one Workspace that need one Permission there, such as `member.manage`: opens the
 * Workspace from the input's `workspaceId` for the person (404 when they can't see it, 403 when they
 * may not do this) and gives the procedure `context.workspace`. Put `sensitive(…)` after it.
 */
export function onWorkspace(permission: Permission) {
	return base
		.$context<ApiContext & { access: Access }>()
		.middleware(async ({ context, next }, input: { workspaceId: string }) => {
			const workspace = await context.services.data.workspace(context.access, input.workspaceId, permission);
			return next({ context: { workspace } });
		});
}

/**
 * Procedures on one Site that need one Permission there, such as `structure.edit`: opens the Site
 * from the input's `siteId` for the person (404 when they can't see it, 403 when they may not do
 * this) and gives the procedure `context.site`. Put `sensitive(…)` after it.
 */
export function onSite(permission: Permission) {
	return base
		.$context<ApiContext & { access: Access }>()
		.middleware(async ({ context, next }, input: { siteId: string }) => {
			const site = await context.services.data.site(context.access, input.siteId, permission);
			return next({ context: { site } });
		});
}

/**
 * Refuses a procedure while the admin session impersonates someone (`NOT_WHILE_IMPERSONATING`,
 * `data.what`): changes to the person's account (their password, second factors, sessions, API
 * tokens, AI clients, preferences), confirming who they are, Edit mode and the Staging address.
 */
/**
 * The items within reach: while impersonating, only those in the Workspaces the impersonation
 * reaches (`workspaceOf` names an item's Workspace); otherwise all of them.
 */
export function withinImpersonationReach<Item>(
	context: { impersonation: ImpersonationView | null },
	items: readonly Item[],
	workspaceOf: (item: Item) => string,
): Item[] {
	const reach = context.impersonation?.workspaceIds;
	return reach ? items.filter((item) => reach.includes(workspaceOf(item))) : [...items];
}

export function notWhileImpersonating(what: NotWhileImpersonating) {
	return base.$context<ApiContext & { access: Access }>().middleware(({ context, next }) => {
		assertNotImpersonating(context.access, what);
		return next();
	});
}

/**
 * Marks a procedure as a Sensitive action from the one list (`SENSITIVE_ACTIONS` in
 * `@webcraft/core`): it is refused unless the person confirmed who they are in this admin session
 * within the last 10 minutes (`IDENTITY_CHECK_REQUIRED`; the admin asks for their password, then
 * tries again), and always for API tokens and OAuth grants. Use it after the permission check, so
 * nobody is asked to confirm something they may not do:
 *
 *     invite: onInstall("staff.manage").use(sensitive("staff.invite")).input(…).handler(…)
 */
export function sensitive(action: SensitiveAction) {
	const middleware = base.$context<ApiContext & { access: Access }>().middleware(({ context, next }) => {
		assertSensitiveActionAllowed(context.access, action, context.services.clock.now());
		return next();
	});
	// The Management API's document marks a procedure carrying it as Sensitive (`sensitiveActionOf`).
	return Object.assign(middleware, { [SENSITIVE_ACTION]: action });
}

const SENSITIVE_ACTION = Symbol("the Sensitive action a middleware checks");

/** The Sensitive action a procedure's middleware checks (`sensitive(…)`), or null when it takes none. */
export function sensitiveActionOf(middlewares: readonly unknown[]): SensitiveAction | null {
	for (const middleware of middlewares) {
		const action = (middleware as { [SENSITIVE_ACTION]?: SensitiveAction })[SENSITIVE_ACTION];
		if (action) return action;
	}
	return null;
}

import { type AnyProcedure, isProcedure, ORPCError, onError, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import {
	type Access,
	type ApiClientUse,
	BUILDING_AREA_PATH,
	type EditSession,
	type EditSessionActor,
	type InstallServices,
	type SensitiveAction,
	SensitiveActionRefusedError,
	SiteNotFoundError,
} from "@webcraft/core";

import { BUILDING_AREA_PROCEDURES, type BuildingAreaProcedure } from "./building-area-list.ts";
import { type ApiContext, sensitiveActionOf } from "./context.ts";
import { logUnexpectedFailure, toApiError } from "./errors.ts";
import { type ApiRouter, apiRouter } from "./router.ts";
import { bodyWithinLimit } from "./rpc.ts";

/** Where a Site's own address serves the Management API to the building area (ADR 0037). */
export const BUILDING_AREA_API_PREFIX = `${BUILDING_AREA_PATH}api/rpc`;

/** The listed procedures, as a router: what the building area's shell calls. */
export type BuildingAreaRouter = Picked<ApiRouter, BuildingAreaProcedure>;

/** A typed client for the Management API on a Site's address, as the building area's shell uses it. */
export type BuildingAreaApiClient = RouterClient<BuildingAreaRouter>;

type Picked<Router, Path extends string> = {
	[Key in keyof Router & string as Path extends Key | `${Key}.${string}`
		? Key
		: never]: Router[Key] extends AnyProcedure
		? Router[Key]
		: Picked<Router[Key], Path extends `${Key}.${infer Rest}` ? Rest : never>;
};

/** One call to the Management API on a Site's address, from a request whose edit-request checks passed. */
export type BuildingAreaCall = {
	/** `POST <Site origin>/_webcraft/build/api/rpc/<path>`, in the oRPC protocol the admin uses. */
	request: Request;
	/** The Edit mode session the request carries, checked again for this request. */
	session: EditSession;
	clientAddress: string | null;
};

type BuildingAreaContext = ApiContext & { client: ApiClientUse; pinnedSiteId: string };

/**
 * The Management API on a Site's own address, for the building area (ADR 0037): the procedures on
 * `BUILDING_AREA_PROCEDURES` at `POST /_webcraft/build/api/rpc/<path>`, in the oRPC protocol the
 * admin uses (`/api/rpc`). The caller (the Site pipeline) has already checked the request as an edit
 * request (from the Site's own pages, the edit cookie, the header token); here the Edit mode session
 * acts as an API client pinned to its Site:
 *
 * - only the listed procedures answer: anything else is `NOT_FOUND`, and a Sensitive action is
 *   `SENSITIVE_ACTION_REFUSED` (as for an API token), listed or not; neither runs;
 * - every call must name the session's Site as its `siteId` (`SITE_NOT_FOUND` otherwise, before
 *   anything of the procedure runs, its middlewares included), and its person acts through an actor
 *   that reaches that Site and nothing else (`EditSessionActor`);
 * - the person's Permissions are checked by each procedure as in the admin (`can()`), and changes are
 *   recorded in the Audit log as Edit mode;
 * - bodies are kept to the admin's limits (an upload to the Install's largest file).
 *
 * Refusals answer as the procedures' own, in the oRPC protocol: `{ json: { code, status, message, data } }`.
 */
export function createBuildingAreaApi(services: InstallServices): (call: BuildingAreaCall) => Promise<Response> {
	const handler = new RPCHandler<BuildingAreaContext>(LISTED.router as unknown as ApiRouter, {
		plugins: [new ResponseHeadersPlugin()],
		clientInterceptors: [
			onError((error, { path }) => {
				logUnexpectedFailure(services, error, path);
			}),
			// The pin, before the procedure's middlewares and input checks: nothing of a call that names
			// another Site (or none) runs.
			async ({ context, input, path, procedure, next }) => {
				if (LISTED.procedures.get(path.join(".")) !== procedure) throw notHere();
				const siteId = typeof input === "object" && input !== null ? (input as { siteId?: unknown }).siteId : undefined;
				if (siteId !== context.pinnedSiteId) throw toApiError(new SiteNotFoundError());
				return next();
			},
		],
	});

	return async ({ request, session, clientAddress }) => {
		const path = new URL(request.url).pathname
			.slice(BUILDING_AREA_API_PREFIX.length + 1)
			.split("/")
			.join(".");
		const action = SENSITIVE.get(path);
		if (action) return refused(toApiError(new SensitiveActionRefusedError(action)));
		if (!LISTED.procedures.has(path)) return refused(notHere());
		const client = await sessionClient(services, session);
		if (!client) return refused(new ORPCError("EDIT_MODE_ENDED", { status: 401, message: ENDED }));
		const body = await bodyWithinLimit(services, request, path);
		if (body instanceof Response) return body;
		const { matched, response } = await handler.handle(body.request, {
			prefix: BUILDING_AREA_API_PREFIX,
			context: {
				services,
				headers: request.headers,
				clientAddress,
				via: client.access.via,
				client,
				pinnedSiteId: session.scope.site.id,
			},
		});
		if (!matched) return refused(notHere());
		if (body.overflowed()) return body.tooLarge();
		response.headers.set("cache-control", "no-store");
		return response;
	};
}

const ENDED = "Edit mode has ended. Open it again from the admin.";

/**
 * The Edit mode session as an API client: its person, read fresh, acting through an actor pinned to
 * the session's Site, recorded as Edit mode. Null when the person is gone.
 */
async function sessionClient(services: InstallServices, session: EditSession): Promise<ApiClientUse | null> {
	const { actor } = session.access;
	// The session opens the Site for its person (`EditMode.session`); anything else is refused.
	if (actor.kind !== "person") return null;
	const person = await services.people.get(session.personId);
	if (!person || person.id !== actor.personId) return null;
	const pinned: EditSessionActor = {
		kind: "editSession",
		sessionId: session.id,
		person: actor,
		workspaceId: session.scope.site.workspaceId,
		siteId: session.scope.site.id,
	};
	const access: Access = { actor: pinned, via: { kind: "editMode" } };
	return {
		client: { kind: "editSession", id: session.id, name: "Edit mode", readOnly: false, toolsets: [], mayPublish: true },
		person,
		access,
	};
}

/** A path the Site's address doesn't serve. */
function notHere(): ORPCError<"NOT_FOUND", undefined> {
	return new ORPCError("NOT_FOUND", { status: 404, message: "There is no such procedure on the Site's address." });
}

/** A call refused before its procedure ran, as a procedure answers it in the oRPC protocol. */
function refused(error: unknown): Response {
	const { code, status, message, data } =
		error instanceof ORPCError ? error : new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 });
	return Response.json(
		{ json: { defined: false, code, status, message, data } },
		{ status, headers: { "cache-control": "no-store" } },
	);
}

/** Every procedure of the Management API, by dotted path. */
function proceduresOf(router: object, prefix: readonly string[] = []): Map<string, AnyProcedure> {
	const found = new Map<string, AnyProcedure>();
	for (const [key, value] of Object.entries(router)) {
		const path = [...prefix, key];
		if (isProcedure(value)) found.set(path.join("."), value);
		else if (typeof value === "object" && value !== null) {
			for (const [inner, procedure] of proceduresOf(value, path)) found.set(inner, procedure);
		}
	}
	return found;
}

const ALL = proceduresOf(apiRouter);

/** The Sensitive action of every procedure that takes one, by dotted path: never served here. */
const SENSITIVE = new Map<string, SensitiveAction>(
	Array.from(ALL).flatMap(([path, procedure]) => {
		const action = sensitiveActionOf(procedure["~orpc"].middlewares);
		return action ? [[path, action] as const] : [];
	}),
);

/**
 * The listed procedures, by dotted path and as a router. Built once, refusing to build (so the web
 * process fails its first call and the tests fail) if a line names a procedure that takes a Sensitive
 * action or doesn't take the Site it is pinned to.
 */
const LISTED = (() => {
	const procedures = new Map<string, AnyProcedure>();
	const router: Record<string, unknown> = {};
	for (const path of BUILDING_AREA_PROCEDURES) {
		const procedure = ALL.get(path);
		if (!procedure) throw new Error(`The building area lists ${path}, which isn't a procedure.`);
		if (SENSITIVE.has(path)) throw new Error(`The building area lists ${path}, a Sensitive action.`);
		const shape = (procedure["~orpc"].inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape;
		if (!shape || !("siteId" in shape) || "workspaceId" in shape) {
			throw new Error(`The building area lists ${path}, which doesn't take one Site (siteId).`);
		}
		procedures.set(path, procedure);
		const parts = path.split(".");
		let group = router;
		for (const part of parts.slice(0, -1)) {
			group[part] ??= {};
			group = group[part] as Record<string, unknown>;
		}
		group[parts.at(-1) ?? path] = procedure;
	}
	return { procedures, router };
})();

import { ORPCError, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import type { InstallServices } from "@webcraft/core";

import type { ApiContext } from "./context.ts";

import { adminRouter } from "./module-router.ts";

/** Where the admin calls the Management API, on the admin host. */
export const ADMIN_API_PREFIX = "/api/rpc";

/** What the web process knows about a request besides the request itself. */
export type RequestFacts = {
	/** The address of the client it came from (`clientAddress` in the web process), or null. */
	clientAddress: string | null;
};

/**
 * The Management API as the admin's own pages call it (oRPC's RPC protocol), signed in with the
 * session cookie. Answers null for paths outside `/api/rpc`.
 */
export function createAdminApi(
	services: InstallServices,
): (request: Request, facts: RequestFacts) => Promise<Response | null> {
	const handlers = new WeakMap<object, RPCHandler<ApiContext>>();
	/** The handler for the Install's Modules now: a restarted Install may load other Modules. */
	const handlerFor = () => {
		const router = adminRouter(services);
		let handler = handlers.get(router);
		if (!handler) {
			handler = new RPCHandler<ApiContext>(router, {
				plugins: [new ResponseHeadersPlugin()],
				clientInterceptors: [
					// Refusals (bad input, no session, a wrong token) are answers; anything else is a failure to log.
					// The caller only gets a plain 500.
					onError((error, { path }) => {
						if (error instanceof ORPCError && error.status < 500) return;
						services.log.error("A Management API call failed unexpectedly", { error, procedure: path.join(".") });
					}),
				],
			});
			handlers.set(router, handler);
		}
		return handler;
	};
	return async (request, { clientAddress }) => {
		const handler = handlerFor();
		const { matched, response } = await handler.handle(request, {
			prefix: ADMIN_API_PREFIX,
			context: { services, headers: request.headers, clientAddress, via: { kind: "admin" } },
		});
		if (!matched) return null;
		response.headers.set("cache-control", "no-store");
		return response;
	};
}

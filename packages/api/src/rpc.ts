import { RPCHandler } from "@orpc/server/fetch";
import { ResponseHeadersPlugin } from "@orpc/server/plugins";
import type { InstallServices } from "@webcraft/core";

import { apiRouter } from "./router.ts";

/** Where the admin calls the Management API, on the admin host. */
export const ADMIN_API_PREFIX = "/api/rpc";

/**
 * The Management API as the admin's own pages call it (oRPC's RPC protocol), signed in with the
 * session cookie. Answers null for paths outside `/api/rpc`.
 */
export function createAdminApi(services: InstallServices): (request: Request) => Promise<Response | null> {
	const handler = new RPCHandler(apiRouter, { plugins: [new ResponseHeadersPlugin()] });
	return async (request) => {
		const { matched, response } = await handler.handle(request, {
			prefix: ADMIN_API_PREFIX,
			context: { services, headers: request.headers },
		});
		if (!matched) return null;
		response.headers.set("cache-control", "no-store");
		return response;
	};
}

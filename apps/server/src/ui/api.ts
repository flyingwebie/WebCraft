import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { createIsomorphicFn } from "@tanstack/react-start";
import type { ApiClient } from "@webcraft/api";

/** Where the admin calls the Management API (see `ADMIN_API_PREFIX` in `@webcraft/api`). */
const API_PATH = "/api/rpc";

let browserClient: ApiClient | undefined;

/**
 * The Management API for admin pages. While a page renders on the server it calls the procedures
 * in-process, with the request's cookies; in the browser it calls `/api/rpc` on the admin host.
 */
export const getApi = createIsomorphicFn()
	.server(async (): Promise<ApiClient> => {
		const { serverApi } = await import("./api.server.ts");
		return serverApi();
	})
	.client(async (): Promise<ApiClient> => {
		browserClient ??= createORPCClient(new RPCLink({ url: new URL(API_PATH, window.location.origin).toString() }));
		return browserClient;
	});

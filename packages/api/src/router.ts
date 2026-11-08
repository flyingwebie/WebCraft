import type { RouterClient } from "@orpc/server";

import { session } from "./procedures/session.ts";
import { setup } from "./procedures/setup.ts";

/**
 * Every procedure, by name. The admin calls them all; the public ones will also be served under
 * `/api/v1` with an OpenAPI spec. All procedures here so far are internal to the admin.
 */
export const apiRouter = {
	setup,
	session,
};

export type ApiRouter = typeof apiRouter;

/** A typed client for the Management API, as the admin and tests use it. */
export type ApiClient = RouterClient<ApiRouter>;

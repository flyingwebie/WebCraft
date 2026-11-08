import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen.ts";

/** The admin app's router. TanStack Start calls this once per request on the server. */
export function getRouter() {
	return createRouter({
		routeTree,
		scrollRestoration: true,
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}

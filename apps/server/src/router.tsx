// First: the routes below make their schemas as they load.
import "./no-eval.ts";

import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";

import { routeTree } from "./routeTree.gen.ts";

/** The nonce in a request's context, as `server.ts` gave it to the page being rendered; none in the browser. */
function nonceIn(context: { nonce?: unknown } | undefined): string | undefined {
	return typeof context?.nonce === "string" ? context.nonce : undefined;
}

/**
 * The admin app's router. TanStack Start calls this once per request on the server, where the
 * request's nonce (`server.ts`) goes on every inline script the page is rendered with, as the admin's
 * Content Security Policy asks (`admin/security-headers.ts`); in the browser the router reads the
 * nonce back from the page itself.
 */
export function getRouter() {
	return createRouter({
		routeTree,
		scrollRestoration: true,
		ssr: { nonce: nonceIn(getGlobalStartContext()) },
	});
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}

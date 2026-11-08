import type { InstallServices } from "@webcraft/core";

import { type Handler, notFound } from "../responses.ts";
import { healthz, readyz } from "./health.ts";

/**
 * Everything served on the admin host. The web process answers its own paths first (`/healthz`,
 * `/readyz`, and later `/api/v1`, `/mcp`, OAuth and the Caddy ask endpoint); the admin app
 * renders the rest.
 */
export function createAdminSide(services: InstallServices, adminApp?: Handler): Handler {
	return async (request) => {
		const { pathname } = new URL(request.url);
		switch (pathname) {
			case "/healthz":
				return healthz(request);
			case "/readyz":
				return readyz(request, services);
		}
		return adminApp ? adminApp(request) : notFound();
	};
}

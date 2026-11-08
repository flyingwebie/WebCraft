import { ADMIN_API_PREFIX, createAdminApi } from "@webcraft/api";
import type { InstallServices } from "@webcraft/core";
import { normaliseHostname } from "@webcraft/core";

import { type Handler, json, notFound, plainText } from "../responses.ts";
import { healthz, readyz } from "./health.ts";

/**
 * Everything served on the admin host. The web process answers its own paths first (`/healthz`,
 * `/readyz`, the Management API at `/api/rpc`, and later `/api/v1`, `/mcp`, OAuth and the Caddy ask
 * endpoint); the admin app renders the rest.
 */
export function createAdminSide(services: InstallServices, adminApp?: Handler): Handler {
	const adminApi = createAdminApi(services);
	return async (request) => {
		const { pathname } = new URL(request.url);
		switch (pathname) {
			case "/healthz":
				return healthz(request);
			case "/readyz":
				return readyz(request, services);
		}
		if (pathname === ADMIN_API_PREFIX || pathname.startsWith(`${ADMIN_API_PREFIX}/`)) {
			// Only POST: a link or a top-level navigation from another site (which carries the
			// SameSite=Lax cookie) can never call a procedure.
			if (request.method !== "POST") return plainText(405, "Method Not Allowed", { allow: "POST" });
			if (!fromAdminPages(request, services.config.adminHost)) {
				return json(403, { code: "FORBIDDEN", message: "Requests to the admin must come from the admin's own pages." });
			}
			return (await adminApi(request)) ?? notFound();
		}
		return adminApp ? adminApp(request) : notFound();
	};
}

/**
 * Whether a request could have come from the admin's own pages. Browsers say where a request comes
 * from (`Origin`, `Sec-Fetch-Site`); a request another site's page makes is refused, so no other site
 * can act with a signed-in person's cookie. Requests without either header don't come from a browser.
 */
function fromAdminPages(request: Request, adminHost: string): boolean {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none") return false;
	const origin = request.headers.get("origin");
	if (origin === null) return true;
	try {
		return normaliseHostname(new URL(origin).hostname) === adminHost;
	} catch {
		return false;
	}
}

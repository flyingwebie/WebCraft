import { ADMIN_API_PREFIX, createAdminApi } from "@webcraft/api";
import {
	type InstallServices,
	normaliseHostname,
	PermissionDeniedError,
	SiteNotFoundError,
	type SiteScope,
} from "@webcraft/core";

import { clientAddress } from "../client-address.ts";
import { mediaFileResponse } from "../media-response.ts";
import { type Handler, json, notFound, plainText, readOnly } from "../responses.ts";
import { healthz, readyz } from "./health.ts";

/**
 * Everything served on the admin host. The web process answers its own paths first (`/healthz`,
 * `/readyz`, the Management API at `/api/rpc`, Media previews at `/api/media/…`, and later
 * `/api/v1`, `/mcp`, OAuth and the Caddy ask endpoint); the admin app renders the rest.
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
			return (await adminApi(request, { clientAddress: clientAddress(request, services.config) })) ?? notFound();
		}
		if (pathname.startsWith(MEDIA_PREVIEW_PREFIX)) {
			return readOnly(request, () => mediaPreview(services, request, pathname.slice(MEDIA_PREVIEW_PREFIX.length)));
		}
		return adminApp ? adminApp(request) : notFound();
	};
}

/** Where the admin shows a Site's Media files (thumbnails and previews): `/api/media/<site id>/<name>`. */
const MEDIA_PREVIEW_PREFIX = "/api/media/";

/**
 * A Media file of a Site, for the admin's own pages: only to a signed-in person who can see the Site,
 * so it works whether or not the Site has an address visitors reach. Anyone else gets the plain 404.
 */
async function mediaPreview(services: InstallServices, request: Request, rest: string): Promise<Response> {
	const [siteId = "", name = "", ...more] = rest.split("/");
	if (more.length > 0 || !name) return notFound();
	const { session } = await services.auth.session({
		headers: request.headers,
		clientAddress: clientAddress(request, services.config),
	});
	if (!session) return notFound();
	let site: SiteScope;
	try {
		const actor = await services.actors.person(session.personId);
		site = await services.data.site({ actor, via: { kind: "admin" } }, siteId, "site.view");
	} catch (error) {
		if (error instanceof SiteNotFoundError || error instanceof PermissionDeniedError) return notFound();
		throw error;
	}
	const file = await services.media.file(site, name);
	const response = file
		? await mediaFileResponse(request, file, { "cache-control": "private, max-age=31536000, immutable" })
		: null;
	return response ?? notFound();
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

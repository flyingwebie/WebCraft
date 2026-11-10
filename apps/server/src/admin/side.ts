import { ADMIN_API_PREFIX, createAdminApi, createPublicApi, PUBLIC_API_PREFIX } from "@webcraft/api";
import {
	type InstallServices,
	mediaPolicy,
	normaliseHostname,
	PermissionDeniedError,
	SiteNotFoundError,
	type SiteScope,
} from "@webcraft/core";
import { createMcpEndpoint, createOAuthEndpoints } from "@webcraft/mcp";

import { clientAddress } from "../client-address.ts";
import { mediaFileResponse } from "../media-response.ts";
import { type Handler, json, notFound, plainText, readOnly } from "../responses.ts";
import { BUILDER_CANVAS_PATH, builderCanvas } from "./builder-canvas.ts";
import { CADDY_ASK_PATH, caddyAsk } from "./caddy-ask.ts";
import { healthz, readyz } from "./health.ts";

/**
 * Everything served on the admin host. The web process answers its own paths first (`/healthz`,
 * `/readyz`, Caddy's ask at `/caddy/ask`, the Management API at `/api/rpc` for the admin's pages
 * and at `/api/v1` for API tokens, the MCP server at `/mcp`, the OAuth endpoints its AI clients use
 * (`/.well-known/…`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`), Media previews at
 * `/api/media/…`, the builder's canvas at `/api/builder/canvas`); the admin app renders the rest,
 * the approval pages at `/oauth/authorize` and `/oauth/device` included.
 */
export function createAdminSide(services: InstallServices, adminApp?: Handler): Handler {
	const adminApi = createAdminApi(services);
	const publicApi = createPublicApi(services);
	const mcp = createMcpEndpoint(services);
	const oauth = createOAuthEndpoints(services);
	return async (request) => {
		const { pathname } = new URL(request.url);
		switch (pathname) {
			case "/healthz":
				return healthz(request);
			case "/readyz":
				return readyz(request, services);
			case CADDY_ASK_PATH:
				return caddyAsk(services, request);
			case BUILDER_CANVAS_PATH:
				return readOnly(request, builderCanvas);
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
		if (pathname === PUBLIC_API_PREFIX || pathname.startsWith(`${PUBLIC_API_PREFIX}/`)) {
			// API tokens only, in the Authorization header: cookies are never read here, so another
			// site's page can't act with a signed-in person's session.
			return (await publicApi(request, { clientAddress: clientAddress(request, services.config) })) ?? notFound();
		}
		if (pathname === "/mcp" || pathname === "/mcp/") {
			// Bearer tokens only (an AI client's or an API token): cookies are never read here.
			return (await mcp(request, { clientAddress: clientAddress(request, services.config) })) ?? notFound();
		}
		const oauthAnswer = await oauth(request, { clientAddress: clientAddress(request, services.config) });
		if (oauthAnswer) return oauthAnswer;
		if ((pathname === APPROVAL_PAGE_PATH || pathname === DEVICE_PAGE_PATH) && adminApp) {
			return neverFramed(await adminApp(request));
		}
		if (pathname.startsWith(MEDIA_PREVIEW_PREFIX)) {
			return readOnly(request, () => mediaPreview(services, request, pathname.slice(MEDIA_PREVIEW_PREFIX.length)));
		}
		return adminApp ? adminApp(request) : notFound();
	};
}

/** The approval page an AI client sends the person to (`routes/oauth.authorize.tsx`). */
const APPROVAL_PAGE_PATH = "/oauth/authorize";

/** Where a device sign-in's code is approved (`routes/oauth.device.tsx`): `webcraft login` names it. */
const DEVICE_PAGE_PATH = "/oauth/device";

/** The approval page never shows inside another site's frame, where a click could be stolen. */
function neverFramed(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("x-frame-options", "DENY");
	headers.set("content-security-policy", "frame-ancestors 'none'");
	headers.set("cache-control", "no-store");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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
		// As whoever the session acts as: the person it impersonates sees their own Sites' files only.
		const { access } = await services.impersonation.actingAs(session);
		site = await services.data.site(access, siteId, "site.view");
	} catch (error) {
		if (error instanceof SiteNotFoundError || error instanceof PermissionDeniedError) return notFound();
		throw error;
	}
	const file = await services.media.file(site, name);
	const response = file
		? await mediaFileResponse(request, file, {
				"cache-control": "private, max-age=31536000, immutable",
				"content-security-policy": mediaPolicy(file.contentType),
			})
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

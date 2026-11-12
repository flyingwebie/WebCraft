import { ADMIN_API_PREFIX, createAdminApi, createPublicApi, PUBLIC_API_PREFIX } from "@webcraft/api";
import {
	FORM_UPLOADS_PATH,
	type InstallServices,
	mediaPolicy,
	normaliseHostname,
	PermissionDeniedError,
	SITE_EXPORT_DOWNLOAD_PREFIX,
	SiteExportNotFoundError,
	SiteNotFoundError,
	type SiteScope,
} from "@webcraft/core";
import { createMcpEndpoint, createOAuthEndpoints } from "@webcraft/mcp";

import { clientAddress } from "../client-address.ts";
import { mediaFileResponse } from "../media-response.ts";
import { recordedAddress } from "../recorded-address.ts";
import { type Handler, json, notFound, plainText, readOnly, withinBodyCeiling } from "../responses.ts";
import { BUILDER_CANVAS_PATH, builderCanvas } from "./builder-canvas.ts";
import { CADDY_ASK_PATH, caddyAsk } from "./caddy-ask.ts";
import { healthz, readyz } from "./health.ts";
import { type AdminApp, withAdminHeaders } from "./security-headers.ts";

/**
 * Everything served on the admin host. The web process answers its own paths first (`/healthz`,
 * `/readyz`, Caddy's ask at `/caddy/ask`, the Management API at `/api/rpc` for the admin's pages
 * and at `/api/v1` for API tokens, the MCP server at `/mcp`, the OAuth endpoints its AI clients use
 * (`/.well-known/…`, `/oauth/register`, `/oauth/token`, `/oauth/revoke`), Media previews at
 * `/api/media/…`, Form uploads at `/api/forms/uploads/…`, the builder's canvas at
 * `/api/builder/canvas`); the admin app renders the rest,
 * the approval pages at `/oauth/authorize` and `/oauth/device` included.
 *
 * Every answer leaves with the admin's security headers (`withAdminHeaders`), an unexpected failure's
 * included.
 */
export function createAdminSide(services: InstallServices, adminApp?: AdminApp): Handler {
	const adminApi = createAdminApi(services);
	const publicApi = createPublicApi(services);
	const mcp = createMcpEndpoint(services);
	const oauth = createOAuthEndpoints(services);
	const answer: AdminApp = async (request, page) => {
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
			return neverStored(await adminApp(request, page));
		}
		if (pathname.startsWith(SITE_EXPORT_DOWNLOAD_PREFIX)) {
			return readOnly(request, () =>
				siteExportDownload(services, request, pathname.slice(SITE_EXPORT_DOWNLOAD_PREFIX.length)),
			);
		}
		if (pathname.startsWith(FORM_UPLOADS_PATH)) {
			return readOnly(request, () => formUpload(services, request, pathname.slice(FORM_UPLOADS_PATH.length)));
		}
		if (pathname.startsWith(MEDIA_PREVIEW_PREFIX)) {
			return readOnly(request, () => mediaPreview(services, request, pathname.slice(MEDIA_PREVIEW_PREFIX.length)));
		}
		return adminApp ? adminApp(request, page) : notFound();
	};
	return withAdminHeaders(services.config.adminOrigin, async (request, page) => {
		try {
			return await withinBodyCeiling(request, () => answer(request, page));
		} catch (error) {
			services.log.error("A request failed unexpectedly", {
				error,
				method: request.method,
				url: recordedAddress(request, services),
			});
			return plainText(500, "Internal Server Error");
		}
	});
}

/** The approval page an AI client sends the person to (`routes/oauth.authorize.tsx`). */
const APPROVAL_PAGE_PATH = "/oauth/authorize";

/** Where a device sign-in's code is approved (`routes/oauth.device.tsx`): `webcraft login` names it. */
const DEVICE_PAGE_PATH = "/oauth/device";

/** An approval page is made for one request to approve: no browser or proxy keeps a copy. */
function neverStored(response: Response): Response {
	const headers = new Headers(response.headers);
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

/** What a downloaded Form upload may do when opened: nothing (no scripts, no requests, sandboxed). */
const UPLOAD_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/**
 * A Form upload (ADR 0026), downloaded through the admin: only for a signed-in person who may read
 * the Site's Submissions, as an attachment that is never cached, and recorded in the Audit log.
 * Anyone else gets the plain 404, so nobody learns which files exist.
 */
async function formUpload(services: InstallServices, request: Request, rest: string): Promise<Response> {
	const [siteId = "", uploadId = "", ...more] = rest.split("/");
	if (more.length > 0 || !uploadId) return notFound();
	const { session } = await services.auth.session({
		headers: request.headers,
		clientAddress: clientAddress(request, services.config),
	});
	if (!session) return notFound();
	let site: SiteScope;
	try {
		const { access } = await services.impersonation.actingAs(session);
		site = await services.data.site(access, siteId, "site.view");
	} catch (error) {
		if (error instanceof SiteNotFoundError || error instanceof PermissionDeniedError) return notFound();
		throw error;
	}
	if (!(await services.modules.maySeeSubmissions(site))) return notFound();
	if (request.method === "HEAD") return new Response(null, { status: 405, headers: { allow: "GET" } });
	const file = await services.forms.uploads.download(site, uploadId);
	if (!file) return notFound();
	return new Response(file.stream, {
		headers: {
			"content-type": file.contentType,
			"content-length": String(file.size),
			"content-disposition": attachmentDisposition(file.name),
			"cache-control": "private, no-store",
			"content-security-policy": UPLOAD_POLICY,
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
		},
	});
}

/** `Content-Disposition` for a download: a plain name for old clients, the exact one encoded. */
function attachmentDisposition(name: string): string {
	const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
	return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/**
 * Whether a request could have come from the admin's own pages. Browsers say where a request comes
 * from (`Origin`, `Sec-Fetch-Site`); a request another site's page makes is refused, so no other site
 * can act with a signed-in person's cookie. The `Origin` must be the admin's own: its hostname, on
 * the port this request came to (as Edit mode checks), so another service on the same hostname is
 * refused too, even by a browser that doesn't send `Sec-Fetch-Site`. Requests without either header
 * don't come from a browser (scripts and the CLI use API tokens at `/api/v1`, never this cookie).
 */
function fromAdminPages(request: Request, adminHost: string): boolean {
	const site = request.headers.get("sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none") return false;
	const origin = request.headers.get("origin");
	if (origin === null) return true;
	try {
		const from = new URL(origin);
		return normaliseHostname(from.hostname) === adminHost && from.port === new URL(request.url).port;
	} catch {
		return false;
	}
}

/**
 * A Site export's archive, through its signed download link (`siteExports.get` answers it): only while
 * the link holds (24 hours), and only to a signed-in person who may export that Site. Anyone else gets
 * the plain 404, so nobody learns which exports exist.
 */
async function siteExportDownload(services: InstallServices, request: Request, rest: string): Promise<Response> {
	const [siteId = "", exportId = "", ...more] = rest.split("/");
	if (more.length > 0) return notFound();
	const { session } = await services.auth.session({
		headers: request.headers,
		clientAddress: clientAddress(request, services.config),
	});
	if (!session) return notFound();
	const url = new URL(request.url);
	try {
		// As whoever the session acts as: someone impersonated may export only their own Sites.
		const { access } = await services.impersonation.actingAs(session);
		const file = await services.siteTransfer.download(access, {
			siteId,
			exportId,
			expires: url.searchParams.get("expires") ?? "",
			signature: url.searchParams.get("signature") ?? "",
		});
		return new Response(file.body, {
			status: 200,
			headers: {
				"content-type": "application/x-tar",
				"content-length": String(file.size),
				"content-disposition": `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
				"cache-control": "private, no-store",
				"x-content-type-options": "nosniff",
			},
		});
	} catch (error) {
		if (
			error instanceof SiteExportNotFoundError ||
			error instanceof SiteNotFoundError ||
			error instanceof PermissionDeniedError
		) {
			return notFound();
		}
		throw error;
	}
}

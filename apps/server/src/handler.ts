import {
	type InstallServices,
	normaliseHostname,
	type SitemapLimits,
	underBodyCeiling,
	withLogContext,
} from "@webcraft/core";

import { healthz, readyz } from "./admin/health.ts";
import type { AdminApp } from "./admin/security-headers.ts";
import { createAdminSide } from "./admin/side.ts";
import { sameClient } from "./client-address.ts";
import {
	ADMIN_DRAFTS_PREFIX,
	createDraftSockets,
	EDIT_DRAFTS_PREFIX,
	type UpgradeAnswer,
} from "./co-editing/sockets.ts";
import { requestIdOf, withRequestId } from "./request-ids.ts";
import { type Handler, notFound, plainText } from "./responses.ts";
import { createPageCache } from "./site/page-cache.ts";
import { createSitePipeline } from "./site/pipeline.ts";

export type { AdminApp } from "./admin/security-headers.ts";
export type { SocketUpgrade, UpgradeAnswer } from "./co-editing/sockets.ts";
export type { Handler } from "./responses.ts";

/**
 * The web process's request handler, with what serving it needs besides answering requests: WebSocket
 * upgrades (Co-editing, ADR 0025), answered as a refusal or a socket to open, and stopping.
 */
export type WebHandler = Handler & {
	/** Answers a WebSocket upgrade request: a refusal, or what to do with the socket once it is open. */
	upgrade(request: Request): Promise<UpgradeAnswer>;
	/** Closes every open socket and stops listening for other processes' changes. */
	stop(): Promise<void>;
};

/**
 * The hostname Railway's health checks always use, whatever the service's domains. On Railway
 * (`WEBCRAFT_EDGE=railway`) `/healthz` and `/readyz` answer there too, and nothing else does.
 */
export const RAILWAY_HEALTH_CHECK_HOST = "healthcheck.railway.app";

export type WebHandlerOptions = {
	services: InstallServices;
	/**
	 * Renders the admin app (TanStack Start) for admin-host requests the web process doesn't
	 * answer itself, with the nonce its inline scripts must carry (`admin/security-headers.ts`).
	 * Absent in tests, where those requests get a 404.
	 */
	adminApp?: AdminApp;
	/**
	 * How many filtered pages (variants) the page cache keeps per Site at a time: the default
	 * (`DEFAULT_FILTER_VARIANTS`) unless given, as a test of the limit needs fewer.
	 */
	filterVariants?: number;
	/** How much one sitemap file holds: the protocol's limits unless given, as a test of splitting needs fewer. */
	sitemapLimits?: Partial<SitemapLimits>;
};

/**
 * The web process's request handler: a plain `(Request) => Promise<Response>`. It routes every
 * request by hostname: the admin host to the admin side, every other hostname to the Site pipeline.
 */
export function createWebHandler({ services, adminApp, filterVariants, sitemapLimits }: WebHandlerOptions): WebHandler {
	const adminSide = createAdminSide(services, adminApp);
	const sitePipeline = createSitePipeline(services, {
		pageCache: createPageCache({ maxVariants: filterVariants }),
		sitemapLimits,
	});
	const sockets = createDraftSockets(services);

	const upgrade = (request: Request): Promise<UpgradeAnswer> =>
		withLogContext({ requestId: requestIdOf(request, services.config) }, () => answerUpgrade(request));

	const answerUpgrade = async (request: Request): Promise<UpgradeAnswer> => {
		try {
			const url = new URL(request.url);
			const hostname = normaliseHostname(url.hostname);
			if (hostname === services.config.adminHost) {
				return url.pathname.startsWith(ADMIN_DRAFTS_PREFIX) ? await sockets.admin(request) : notFound();
			}
			if (!url.pathname.startsWith(EDIT_DRAFTS_PREFIX)) return notFound();
			const host = await services.sitePages.resolveHost(hostname);
			if (!host || host.address === "redirect") return notFound();
			return await sockets.site(request, host);
		} catch (error) {
			services.log.error("A WebSocket upgrade failed unexpectedly", { error, url: request.url });
			return plainText(500, "Internal Server Error");
		}
	};

	// Every line a request writes, and the jobs it queues, carry its request id; so does its answer.
	// Every request's body comes under one ceiling (`request-body.ts` in `@webcraft/core`): a route
	// reads more only by setting its own limit, and each side answers 413 for a body cut off there.
	const handler = (incoming: Request): Promise<Response> => {
		const requestId = requestIdOf(incoming, services.config);
		const request = underBodyCeiling(incoming);
		if (request !== incoming) sameClient(incoming, request);
		return withLogContext({ requestId }, () => answer(request)).then((response) => withRequestId(response, requestId));
	};

	const answer = async (request: Request): Promise<Response> => {
		try {
			const hostname = normaliseHostname(new URL(request.url).hostname);
			if (hostname === services.config.adminHost) {
				return await adminSide(request);
			}
			if (hostname === RAILWAY_HEALTH_CHECK_HOST && services.config.edge === "railway") {
				return await railwayHealthCheck(request, services);
			}
			return await sitePipeline(request);
		} catch (error) {
			services.log.error("A request failed unexpectedly", { error, method: request.method, url: request.url });
			return plainText(500, "Internal Server Error");
		}
	};
	return Object.assign(handler, { upgrade, stop: () => sockets.stop() });
}

/** Railway's health check of a new deployment: only `/healthz` and `/readyz`, as on the admin host. */
function railwayHealthCheck(request: Request, services: InstallServices): Promise<Response> {
	switch (new URL(request.url).pathname) {
		case "/healthz":
			return healthz(request);
		case "/readyz":
			return readyz(request, services);
		default:
			return Promise.resolve(notFound());
	}
}

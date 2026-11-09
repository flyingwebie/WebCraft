import { type InstallServices, normaliseHostname } from "@webcraft/core";

import { healthz, readyz } from "./admin/health.ts";
import { createAdminSide } from "./admin/side.ts";
import { type Handler, notFound, plainText } from "./responses.ts";
import type { PageCache } from "./site/page-cache.ts";
import { createSitePipeline } from "./site/pipeline.ts";

export type { Handler } from "./responses.ts";

/**
 * The hostname Railway's health checks always use, whatever the service's domains. On Railway
 * (`WEBCRAFT_EDGE=railway`) `/healthz` and `/readyz` answer there too, and nothing else does.
 */
export const RAILWAY_HEALTH_CHECK_HOST = "healthcheck.railway.app";

export type WebHandlerOptions = {
	services: InstallServices;
	/**
	 * Renders the admin app (TanStack Start) for admin-host requests the web process doesn't
	 * answer itself. Absent in tests, where those requests get a 404.
	 */
	adminApp?: Handler;
	/** The Site pipeline's page cache; a new one holding the default amounts unless given. */
	pageCache?: PageCache;
};

/**
 * The web process's request handler: a plain `(Request) => Promise<Response>`. It routes every
 * request by hostname: the admin host to the admin side, every other hostname to the Site pipeline.
 */
export function createWebHandler({ services, adminApp, pageCache }: WebHandlerOptions): Handler {
	const adminSide = createAdminSide(services, adminApp);
	const sitePipeline = createSitePipeline(services, { pageCache });

	return async (request) => {
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

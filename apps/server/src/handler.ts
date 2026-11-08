import { type InstallServices, normaliseHostname } from "@webcraft/core";

import { createAdminSide } from "./admin/side.ts";
import { type Handler, plainText } from "./responses.ts";
import { createSitePipeline } from "./site/pipeline.ts";

export type { Handler } from "./responses.ts";

export type WebHandlerOptions = {
	services: InstallServices;
	/**
	 * Renders the admin app (TanStack Start) for admin-host requests the web process doesn't
	 * answer itself. Absent in tests, where those requests get a 404.
	 */
	adminApp?: Handler;
};

/**
 * The web process's request handler: a plain `(Request) => Promise<Response>`. It routes every
 * request by hostname: the admin host to the admin side, every other hostname to the Site pipeline.
 */
export function createWebHandler({ services, adminApp }: WebHandlerOptions): Handler {
	const adminSide = createAdminSide(services, adminApp);
	const sitePipeline = createSitePipeline(services);

	return async (request) => {
		try {
			const hostname = normaliseHostname(new URL(request.url).hostname);
			if (hostname === services.config.adminHost) {
				return await adminSide(request);
			}
			return await sitePipeline(request);
		} catch (error) {
			services.log.error("A request failed unexpectedly", { error, method: request.method, url: request.url });
			return plainText(500, "Internal Server Error");
		}
	};
}

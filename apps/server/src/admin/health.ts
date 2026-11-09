import type { InstallServices } from "@webcraft/core";
import { checkSchema } from "@webcraft/db";

import { json, readOnly } from "../responses.ts";

/** `/healthz`: the web process is up and answering. It checks nothing else. */
export function healthz(request: Request): Promise<Response> {
	return readOnly(request, () => json(200, { status: "ok" }));
}

/**
 * `/readyz`: the web process can serve traffic: the database is reachable and has had every
 * migration this version expects. Answers 503 otherwise, so a load balancer holds traffic back.
 */
export function readyz(request: Request, services: InstallServices): Promise<Response> {
	return readOnly(request, async () => {
		const check = await checkSchema(services.database, { modules: services.modules.schemas });
		switch (check.state) {
			case "current":
				return json(200, { status: "ready", checks: { database: "ok", schema: "current" } });
			case "behind":
				return json(503, { status: "not ready", checks: { database: "ok", schema: "behind" } });
			case "job-queue-newer":
				// After going back a version: the job queue can't run on a newer version's schema.
				return json(503, { status: "not ready", checks: { database: "ok", schema: "job-queue-newer" } });
			case "unreachable":
				services.log.warn("The readiness check cannot reach the database", { error: check.error });
				return json(503, { status: "not ready", checks: { database: "unreachable", schema: "unknown" } });
		}
	});
}

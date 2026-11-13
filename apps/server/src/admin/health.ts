import type { InstallServices } from "@webcraft/core";
import { checkSchema, type SchemaCheck } from "@webcraft/db";

import { json, readOnly } from "../responses.ts";

/** `/healthz`: the web process is up and answering. It checks nothing else. */
export function healthz(request: Request): Promise<Response> {
	return readOnly(request, () => json(200, { status: "ok" }));
}

/** How long a ready answer is kept before the database is asked again, in milliseconds. */
const READY_KEPT_MS = 2_000;

/** One schema check: the one under way, and until when the last ready answer is kept. */
type Readiness = { checking: Promise<SchemaCheck> | null; readyUntil: number };

/** By what the check compares the database with: the Modules a process started with. */
const readiness = new WeakMap<object, Readiness>();

/**
 * The schema check behind `/readyz`, which anyone may ask as often as they like: it reads the applied
 * migrations, each Module's and the job queue's version, so it must never be what uses up the web
 * process's database connections. Requests arriving together share one check, and a ready answer is
 * kept for `READY_KEPT_MS`. An answer that isn't ready is never kept: the moment the database is, the
 * next request says so.
 */
function schemaCheck(services: InstallServices): Promise<SchemaCheck> {
	const { schemas } = services.modules;
	let state = readiness.get(schemas);
	if (!state) {
		state = { checking: null, readyUntil: 0 };
		readiness.set(schemas, state);
	}
	if (performance.now() < state.readyUntil) return Promise.resolve({ state: "current" });
	const own = state;
	own.checking ??= checkSchema(services.database, { modules: schemas })
		.then((check) => {
			if (check.state === "current") own.readyUntil = performance.now() + READY_KEPT_MS;
			return check;
		})
		.finally(() => {
			own.checking = null;
		});
	return own.checking;
}

/**
 * `/readyz`: the web process can serve traffic: the database is reachable and has had every
 * migration this version expects. Answers 503 otherwise, so a load balancer holds traffic back.
 */
export function readyz(request: Request, services: InstallServices): Promise<Response> {
	return readOnly(request, async () => {
		const check = await schemaCheck(services);
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

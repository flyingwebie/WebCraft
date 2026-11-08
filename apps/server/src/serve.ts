// The web process in production: `bun run build`, then `bun run start` from the repo root.
// (Not named start.ts: TanStack Start reserves that name for its own entry.)
// It serves the bundle `vite build` made from src/server.ts on Bun.
import { createLogger } from "@webcraft/core";

import { loadWebSettings } from "./web-services.ts";

type ServerEntry = { fetch(request: Request): Response | Promise<Response> };

const log = createLogger({ fields: { process: "web" } });
const bundle = new URL("../dist/server/server.js", import.meta.url);

let entry: ServerEntry;
try {
	// A missing or malformed setting is reported before anything else is loaded.
	loadWebSettings(process.env);
	// Loading the bundle starts the services; it fails on an old schema too.
	entry = (await import(bundle.href)).default;
} catch (error) {
	log.error("The web process could not start", { error });
	process.exit(1);
}

const server = Bun.serve({
	port: Number(process.env.PORT ?? 3000),
	fetch: (request) => entry.fetch(request),
});
log.info("The web process is listening", { port: server.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, async () => {
		log.info("The web process is stopping", { signal });
		await server.stop();
		process.exit(0);
	});
}

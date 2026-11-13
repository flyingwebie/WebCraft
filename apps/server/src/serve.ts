// The web process in production: `bun run build`, then `bun run start` from the repo root.
// (Not named start.ts: TanStack Start reserves that name for its own entry.)
// It serves the bundle `vite build` made from src/server.ts on Bun.
import { createLogger, logSettings } from "@webcraft/core";

import { type ServerEntry, serveWeb } from "./serving.ts";
import { checkWebSettings } from "./web-services.ts";

const log = createLogger({ fields: { process: "web" }, ...logSettings(process.env) });
const bundle = new URL("../dist/server/server.js", import.meta.url);

let entry: ServerEntry;
try {
	// A missing or malformed setting, an old schema or the wrong Master key is reported before
	// anything else is loaded.
	await checkWebSettings(process.env);
	// Loading the bundle starts the services; it fails on an old schema too.
	entry = (await import(bundle.href)).default;
} catch (error) {
	log.error("The web process could not start", { error });
	process.exit(1);
}

const server = serveWeb(entry, { port: Number(process.env.PORT ?? 3000) });
log.info("The web process is listening", { port: server.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, async () => {
		log.info("The web process is stopping", { signal });
		await entry.stop?.();
		await server.stop();
		process.exit(0);
	});
}

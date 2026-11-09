// The web process in production: `bun run build`, then `bun run start` from the repo root.
// (Not named start.ts: TanStack Start reserves that name for its own entry.)
// It serves the bundle `vite build` made from src/server.ts on Bun.
import { createLogger } from "@webcraft/core";

import { setConnectionAddress } from "./client-address.ts";
import type { UpgradeAnswer } from "./handler.ts";
import { answerUpgrade, isUpgrade, type SocketData, socketHandlers } from "./socket-serving.ts";
import { checkWebSettings } from "./web-services.ts";

type ServerEntry = {
	fetch(request: Request): Response | Promise<Response>;
	upgrade?(request: Request): Promise<UpgradeAnswer>;
	stop?(): Promise<void>;
};

const log = createLogger({ fields: { process: "web" } });
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

const server = Bun.serve<SocketData>({
	port: Number(process.env.PORT ?? 3000),
	fetch: (request, bun) => {
		setConnectionAddress(request, bun.requestIP(request)?.address);
		// Co-editing's sockets: the handler checks the upgrade (who, which Draft, from where) first.
		if (isUpgrade(request) && entry.upgrade) return answerUpgrade(entry.upgrade, request, bun);
		return entry.fetch(request);
	},
	websocket: socketHandlers,
});
log.info("The web process is listening", { port: server.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, async () => {
		log.info("The web process is stopping", { signal });
		await entry.stop?.();
		await server.stop();
		process.exit(0);
	});
}

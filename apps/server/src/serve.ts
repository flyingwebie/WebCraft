// The web process in production: `bun run build`, then `bun run start` from the repo root.
// (Not named start.ts: TanStack Start reserves that name for its own entry.)
// It serves the bundle `vite build` made from src/server.ts on Bun.
import { createLogger, DRAFT_LIMITS, type SocketSession } from "@webcraft/core";

import { setConnectionAddress } from "./client-address.ts";
import type { UpgradeAnswer } from "./handler.ts";
import { checkWebSettings } from "./web-services.ts";

type ServerEntry = {
	fetch(request: Request): Response | Promise<Response>;
	upgrade?(request: Request): Promise<UpgradeAnswer>;
	stop?(): Promise<void>;
};

/** What a WebSocket carries: the upgrade the handler accepted, and its session once open. */
type SocketData = { answer: Exclude<UpgradeAnswer, Response>; session: SocketSession | null };

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
	fetch: async (request, bun) => {
		setConnectionAddress(request, bun.requestIP(request)?.address);
		// Co-editing's sockets: the handler checks the upgrade (who, which Draft, from where) first.
		if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && entry.upgrade) {
			const answer = await entry.upgrade(request);
			if (answer instanceof Response) return answer;
			const upgraded = bun.upgrade(request, {
				data: { answer, session: null },
				headers: { "Sec-WebSocket-Protocol": answer.protocol },
			});
			return upgraded ? undefined : new Response("Bad Request", { status: 400 });
		}
		return entry.fetch(request);
	},
	websocket: {
		// The handler refuses frames over the limit itself, saying why; Bun drops anything far over it.
		maxPayloadLength: DRAFT_LIMITS.messageBytes * 2,
		open(socket) {
			socket.data.session = socket.data.answer.open({
				send: (data) => void socket.send(data),
				close: (code, reason) => socket.close(code, reason),
			});
		},
		message(socket, message) {
			socket.data.session?.receive(typeof message === "string" ? message : new Uint8Array(message));
		},
		close(socket) {
			socket.data.session?.closed();
		},
	},
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

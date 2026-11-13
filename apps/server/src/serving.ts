// The web process on Bun: what `serve.ts` starts in production. Tests of the server's own limits start
// the same server on a local port, in front of a test Install's handler.
import { MEDIA_MAX_FILE_BYTES } from "@webcraft/core";
import type { Server } from "bun";

import { setConnectionAddress } from "./client-address.ts";
import type { UpgradeAnswer } from "./handler.ts";
import { answerUpgrade, isUpgrade, type SocketData, socketHandlers } from "./socket-serving.ts";

/** What the server serves: the server bundle's default export (`server.ts`). */
export type ServerEntry = {
	fetch(request: Request): Response | Promise<Response>;
	upgrade?(request: Request): Promise<UpgradeAnswer>;
	stop?(): Promise<void>;
};

/**
 * The most the server itself takes in one request: the largest file Install settings › Storage can
 * allow (1 GB), with room for the multipart body around it. Bun refuses anything larger with a bare
 * 413 before the handler sees it (128 MB unless told, which kept a larger file out whatever the setting
 * said). It is not what a request may carry: the handler reads every body under its own ceiling
 * (`request-body.ts` in `@webcraft/core`), 1 MB unless the route sets a limit, and only a signed-in
 * upload's limit follows the setting.
 */
export const SERVER_BODY_MAX_BYTES = MEDIA_MAX_FILE_BYTES.max + 1024 * 1024;

/** Starts serving `entry` on `port`. */
export function serveWeb(entry: ServerEntry, options: { port: number; hostname?: string }): Server<SocketData> {
	return Bun.serve<SocketData>({
		...options,
		maxRequestBodySize: SERVER_BODY_MAX_BYTES,
		fetch: (request, bun) => {
			setConnectionAddress(request, bun.requestIP(request)?.address);
			// Co-editing's sockets: the handler checks the upgrade (who, which Draft, from where) first.
			if (isUpgrade(request) && entry.upgrade) return answerUpgrade(entry.upgrade, request, bun);
			return entry.fetch(request);
		},
		websocket: socketHandlers,
	});
}

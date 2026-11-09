// Co-editing's WebSockets on Bun (ADR 0025): what `serve.ts` (production) and the development server's
// plugin (`vite.config.ts`) share, so both answer an upgrade the same way. The handler decides
// (`upgrade`: who, which Draft, from where); Bun only carries the frames.
import { DRAFT_LIMITS, type SocketSession } from "@webcraft/core";
import type { Server, WebSocketHandler } from "bun";

import type { UpgradeAnswer } from "./handler.ts";

/** What a WebSocket carries: the upgrade the handler accepted, and its session once open. */
export type SocketData = { answer: Exclude<UpgradeAnswer, Response>; session: SocketSession | null };

/** Whether a request asks to become a WebSocket. */
export function isUpgrade(request: Request): boolean {
	return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/**
 * Answers a WebSocket upgrade with the handler's `upgrade`: its refusal, or nothing once Bun upgraded
 * the connection (with the subprotocol the handler chose).
 */
export async function answerUpgrade(
	upgrade: (request: Request) => Promise<UpgradeAnswer>,
	request: Request,
	server: Server<SocketData>,
): Promise<Response | undefined> {
	const answer = await upgrade(request);
	if (answer instanceof Response) return answer;
	const upgraded = server.upgrade(request, {
		data: { answer, session: null },
		headers: { "Sec-WebSocket-Protocol": answer.protocol },
	});
	return upgraded ? undefined : new Response("Bad Request", { status: 400 });
}

/** Bun's side of each socket: frames to the handler's session, and back. */
export const socketHandlers: WebSocketHandler<SocketData> = {
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
};

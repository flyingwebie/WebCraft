/**
 * How an editor and the web process talk about a shared document over the WebSocket (ADR 0025).
 * The server and the admin's editors share this file, so it imports nothing.
 *
 * Binary frames carry Yjs data, their first byte saying which:
 * - `sync` (both ways): the sender's state vector, asking for what it lacks. An editor sends one as
 *   it connects (and after starting again); the server answers it with `state`, then sends its own.
 * - `state` (both ways): what the other side lacked. An editor's `state` holds the changes it made
 *   while offline, which merge like any change.
 * - `change` (editor to server): a change the editor made, after a 4-byte number counting its changes,
 *   which the server's `saved` and `refused` name.
 * - `changed` (server to editor): a change someone else made.
 *
 * Text frames carry JSON messages (`ServerMessage`, `EditorMessage`): who is here and where, a
 * change saved or refused, a publish, the end of the session.
 */

/** The WebSocket subprotocol both sides speak. */
export const DRAFTS_PROTOCOL = "webcraft-drafts";

/** A WebSocket subprotocol carrying Edit mode's header token, which a browser can't send as a header. */
export const EDIT_TOKEN_PROTOCOL_PREFIX = "webcraft-edit-token.";

export const FRAME = { sync: 0, state: 1, change: 2, changed: 3 } as const;

export type FrameKind = keyof typeof FRAME;

/** Limits on what one editor's connection may send (`DRAFT_LIMITS` on the server). */
export const DRAFT_LIMITS = {
	/** The largest frame an editor may send. */
	messageBytes: 1024 * 1024,
	/** At most this many frames a minute from one connection. */
	messagesPerMinute: 600,
	/** At most this many documents one person has open at once, in one web process. */
	openPerPerson: 20,
	/** The longest place (`at`) an editor may name. */
	placeLength: 200,
} as const;

/** How an editor batches its changes: at most one change frame this often while its person types. */
export const SEND_EVERY_MS = 400;

/** How long an editor keeps editing without the server; after that it turns read-only until it is back. */
export const OFFLINE_EDITING_MS = 5 * 60 * 1000;

/**
 * Someone in a document: a person with an editor open, or a person's API client or AI client that
 * changed it a moment ago (`via` names the client: "<person> via <client>").
 */
export type Participant = {
	/** This participant in this document (a connection, or a client that wrote). */
	id: string;
	personId: string | null;
	name: string;
	/** The client a person came through (an API token's or AI client's name); null in the admin and Edit mode. */
	via: string | null;
	/** AI translation writing for the person who asked for it (who published, or pressed Translate now). */
	translation?: boolean;
	/** One of 8 colours, the same for a person everywhere; shown with the name, never alone. */
	colour: number;
	/** Where they are: a value's key (`title`, `price`), an element's id, or null. */
	at: string | null;
	/** Whether this is the editor itself (in `welcome`) or someone else. */
	self?: boolean;
};

/** Messages the server sends an editor. */
export type ServerMessage =
	| {
			type: "welcome";
			/** The document's id: an editor holding another one starts again from this one. */
			document: string;
			you: Participant;
			/** Whether this person may change it; read-only otherwise. */
			editable: boolean;
	  }
	| { type: "presence"; participants: Participant[] }
	| { type: "saved"; seq: number }
	| {
			/**
			 * A change the server refused (its code and data as the Management API answers them). It was
			 * dropped for everyone: a `state` frame with the whole document follows, which the editor
			 * starts again from, then answers with `sync`.
			 */
			type: "refused";
			seq: number;
			code: string;
			message: string;
			data?: unknown;
	  }
	| { type: "published"; by: { personId: string; name: string; via: string | null } | null }
	| {
			/** The session ended (signed out, access lost) or the connection broke a limit: the server closes it. */
			type: "ended";
			code: "SESSION_ENDED" | "ACCESS_LOST" | "TOO_MANY_MESSAGES" | "MESSAGE_TOO_LARGE" | "BAD_MESSAGE";
	  };

/** Messages an editor sends the server. */
export type EditorMessage = { type: "presence"; at: string | null };

/** A binary frame: its kind byte, then its data. */
export function encodeFrame(kind: FrameKind, data: Uint8Array, seq?: number): Uint8Array {
	const head = kind === "change" ? 5 : 1;
	const frame = new Uint8Array(head + data.length);
	frame[0] = FRAME[kind];
	if (kind === "change") new DataView(frame.buffer).setUint32(1, seq ?? 0);
	frame.set(data, head);
	return frame;
}

/** Reads a binary frame; null when it isn't one. */
export function decodeFrame(frame: Uint8Array): { kind: FrameKind; data: Uint8Array; seq: number } | null {
	if (frame.length < 1) return null;
	const kind = (Object.keys(FRAME) as FrameKind[]).find((name) => FRAME[name] === frame[0]);
	if (!kind) return null;
	if (kind === "change") {
		if (frame.length < 5) return null;
		const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
		return { kind, data: frame.subarray(5), seq };
	}
	return { kind, data: frame.subarray(1), seq: 0 };
}

/** One of 8 colours for a person, the same everywhere they appear. */
export function colourOf(personId: string | null): number {
	if (!personId) return 0;
	let hash = 0;
	for (let index = 0; index < personId.length; index++) hash = (hash * 31 + personId.charCodeAt(index)) >>> 0;
	return hash % 8;
}

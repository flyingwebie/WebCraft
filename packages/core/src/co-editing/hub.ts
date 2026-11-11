import { type Database, type Listener, listen } from "@webcraft/db";
import { draftDocuments, people } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";

import { type AuditVia, impersonatorNameOf } from "../audit.ts";
import type { Clock } from "../clock.ts";
import type { ComponentSources } from "../content/components.ts";
import { sameJson } from "../content/json.ts";
import { isSerializationFailure } from "../db-errors.ts";
import type { HistoryService } from "../history/index.ts";
import { type HistoryItem, itemIdOf, itemState } from "../history/items.ts";
import type { Logger } from "../log.ts";
import { can, personIdOf, type Resource } from "../permissions/can.ts";
import type { Access, DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { changeDocument, copyDocument, readDocument, sameValue } from "./document.ts";
import { editPermission, isLiveKind, readPermission, saveLiveChange } from "./items.ts";
import { lockItem } from "./locks.ts";
import {
	colourOf,
	DRAFT_LIMITS,
	decodeFrame,
	type EditorMessage,
	encodeFrame,
	type FrameKind,
	type Participant,
	type ServerMessage,
} from "./protocol.ts";
import {
	applyChanges,
	bringIn,
	DRAFTS_CHANNEL,
	type DraftsNotice,
	documentOf,
	ensureDocument,
	lockDocument,
	notify,
	recordChange,
	writingFromDocument,
} from "./store.ts";
import { documentView } from "./view.ts";

/**
 * Co-editing in the web process (ADR 0025): the shared documents people have open here, their
 * editors' connections, and what passes between them.
 *
 * - **Opening** a document checks the person may read the item (`can()` through the data layer) and
 *   loads it from Postgres, making it from the Draft the first time.
 * - **Every change** an editor sends is checked before anyone else sees it: the person's session and
 *   access are read again, then the change is tried on a copy of the document and saved through the
 *   item's own save, as that person (`can()` again, the item's rules), in one transaction with the
 *   change itself. Only once that commits does it reach the other editors. A change that is refused
 *   is dropped for everyone, and its editor starts again from the document as the server holds it.
 * - **Other processes** hear of each change through Postgres LISTEN/NOTIFY and read it from Postgres.
 *   So does this one for the API's, AI clients' and AI translation's writes (`mirrorDraftChange`),
 *   whose people show among the participants for a moment, as "<person> via <client>".
 * - **Presence**: who has each document open, and where they are in it, here and in other processes.
 * - A document nobody has open any more is let go after a while; when its last participant leaves,
 *   its Draft is saved as a Checkpoint (`history.leave`).
 */

/** A connection's way to its editor: a WebSocket, or the test harness's stand-in for one. */
export type SocketPeer = {
	send(data: string | Uint8Array): void;
	close(code: number, reason: string): void;
};

/** What the web process tells a connection's document: a frame arrived, the socket closed. */
export type SocketSession = {
	receive(data: string | Uint8Array): void;
	closed(): void;
};

/** A refusal as the Management API words it. */
export type DraftRefusal = { code: string; message: string; data?: unknown };

/** Opening a document for an editor: who, the item, and how to check them again. */
export type OpenDraft = {
	siteId: string;
	item: HistoryItem;
	/** The person as the upgrade found them. */
	access: Access;
	/** The person's session and access read again; null once the session has ended. */
	recheck(): Promise<Access | null>;
};

/** A document opened for an editor: attaching its socket starts the conversation. */
export type OpenedDraft = { attach(peer: SocketPeer): SocketSession };

export type CoEditing = {
	/**
	 * Opens an item's shared document for a person: refuses an item they may not read (the data
	 * layer's not-found and denied errors), one that can't be co-edited (`DraftNotLiveError`) and a
	 * person with too many open (`TooManyDraftsError`).
	 */
	open(request: OpenDraft): Promise<OpenedDraft>;
	/** Closes every connection and stops listening. */
	stop(): Promise<void>;
};

/** An item that has no shared document to open: one that can't be co-edited live. */
export class DraftNotLiveError extends Error {
	override name = "DraftNotLiveError";
	constructor() {
		super("This item can't be edited live.");
	}
}

/** A person has as many documents open as one person may at once. */
export class TooManyDraftsError extends Error {
	override name = "TooManyDraftsError";
	constructor() {
		super(`One person may have at most ${DRAFT_LIMITS.openPerPerson} Drafts open at once.`);
	}
}

/** The document was made again (or removed) since the editor opened it. */
class DocumentReplacedError extends Error {}

/** A change that builds on changes the server doesn't have. */
class MissingChangesError extends Error {}

export type CoEditingDeps = {
	database: Database;
	databaseUrl: string;
	data: DataLayer;
	history: HistoryService;
	clock: Clock;
	log: Logger;
	components: ComponentSources;
	/** Words a refusal as the Management API does; null for anything unexpected. */
	describe(error: unknown): DraftRefusal | null;
	/** How long a document nobody has open stays in memory (real time); 30 seconds unless given. */
	unloadAfterMs?: number;
};

/** How long an API client, AI client or AI translation shows among the participants after a change. */
const CLIENT_SHOWN_MS = 15_000;
/** How often each process tells the others who has its documents open, and checks idle editors again. */
const HEARTBEAT_MS = 30_000;
/** How long another process's participants count without word from it. */
const REMOTE_PRESENCE_MS = 3 * HEARTBEAT_MS;

type LiveDocument = {
	id: string;
	key: string;
	workspaceId: string;
	siteId: string;
	item: HistoryItem;
	doc: Y.Doc;
	/** The last change (`draft_document_changes.id`) the document holds. */
	through: number;
	connections: Set<Connection>;
	/** Other web processes' editors of it, by process. */
	remote: Map<string, { list: Participant[]; until: number }>;
	/** API clients, AI clients and AI translation that changed it a moment ago. */
	clients: Map<string, Participant & { until: number }>;
	queue: Promise<void>;
	unload?: ReturnType<typeof setTimeout>;
};

type Connection = {
	id: string;
	live: LiveDocument;
	peer: SocketPeer;
	participant: Participant;
	access: Access;
	recheck: () => Promise<Access | null>;
	editable: boolean;
	pending: { seq: number; update: Uint8Array }[];
	/** After a refusal: changes are ignored until the editor starts again (`sync`). */
	awaitingSync: boolean;
	window: { start: number; count: number };
	closed: boolean;
};

const CLOSE_CODES: Record<Extract<ServerMessage, { type: "ended" }>["code"], number> = {
	SESSION_ENDED: 4401,
	ACCESS_LOST: 4403,
	TOO_MANY_MESSAGES: 1008,
	MESSAGE_TOO_LARGE: 1009,
	BAD_MESSAGE: 1003,
};

export function createCoEditing(deps: CoEditingDeps): CoEditing {
	const { clock, log } = deps;
	const processId = crypto.randomUUID();
	const documents = new Map<string, LiveDocument>();
	const byItem = new Map<string, LiveDocument>();
	const loading = new Map<string, Promise<LiveDocument>>();
	const names = new Map<string, string>();
	let listener: Promise<Listener> | null = null;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let stopped = false;

	const keyOf = (siteId: string, item: HistoryItem) => `${siteId}/${item.kind}/${itemIdOf(item) ?? ""}`;
	const resourceOf = (live: LiveDocument): Resource => ({
		level: "site",
		workspaceId: live.workspaceId,
		siteId: live.siteId,
	});

	// ----------------------------------------------------------------------------------------------
	// Listening to the other processes

	const startListening = () => {
		if (listener) return listener;
		listener = listen(deps.databaseUrl, DRAFTS_CHANNEL, {
			applicationName: "webcraft-web-drafts",
			onNotice: (payload) =>
				void hear(payload).catch((error: unknown) => log.warn("A Drafts notice failed", { error })),
			onReconnect: () => {
				for (const live of documents.values()) enqueue(live, () => catchUp(live));
			},
			onError: (error) => log.warn("Listening for Drafts changes failed; trying again", { error }),
		});
		heartbeat = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS);
		heartbeat.unref?.();
		return listener;
	};

	const hear = async (payload: string) => {
		const notice = JSON.parse(payload) as DraftsNotice;
		if (notice.t === "change") {
			const live = documents.get(notice.d);
			if (!live) return;
			if (notice.v && notice.v.kind !== "admin" && notice.v.kind !== "editMode") {
				await showClient(live, notice.p, notice.v);
			}
			if (notice.c > live.through) enqueue(live, () => catchUp(live));
		} else if (notice.t === "presence") {
			if (notice.from === processId) return;
			const live = documents.get(notice.d);
			if (!live) return;
			if (notice.list.length === 0) live.remote.delete(notice.from);
			else live.remote.set(notice.from, { list: notice.list as Participant[], until: Date.now() + REMOTE_PRESENCE_MS });
			sendPresence(live);
		} else if (notice.t === "published") {
			const live = byItem.get(keyOf(notice.s, { kind: notice.k, id: notice.i ?? "" } as HistoryItem));
			const same = live && (itemIdOf(live.item) ?? null) === notice.i ? live : undefined;
			if (!same) return;
			const impersonator = notice.v ? impersonatorNameOf(notice.v) : null;
			const by = notice.p
				? {
						personId: notice.p,
						name: await nameOf(notice.p),
						via: clientOf(notice.v),
						...(impersonator ? { impersonator } : {}),
					}
				: null;
			for (const connection of same.connections) send(connection, { type: "published", by });
		}
	};

	/** The client an API change came through, for "<person> via <client>". */
	const clientOf = (via: AuditVia | null): string | null =>
		via?.kind === "token" || via?.kind === "aiClient" ? via.name : null;

	const showClient = async (live: LiveDocument, personId: string | null, via: AuditVia) => {
		const client = clientOf(via);
		const translation = via.kind === "translation";
		if (!client && !translation) return;
		const id = `client:${personId ?? ""}:${via.kind}:${client ?? ""}`;
		live.clients.set(id, {
			id,
			personId,
			name: personId ? await nameOf(personId) : "",
			via: client,
			...(translation ? { translation: true } : {}),
			colour: colourOf(personId),
			at: null,
			until: Date.now() + CLIENT_SHOWN_MS,
		});
		sendPresence(live);
		const timer = setTimeout(() => sendPresence(live), CLIENT_SHOWN_MS + 50);
		timer.unref?.();
	};

	/** Reads the changes this process hasn't applied yet (made elsewhere) and passes them on. */
	const catchUp = async (live: LiveDocument) => {
		const scope = await deps.data.background(live.siteId);
		if (!scope) return;
		await catchUpIn(scope, live);
	};

	const catchUpIn = async (scope: Pick<SiteScope, "db" | "where">, live: LiveDocument) => {
		const [row] = await scope.db
			.select({ state: draftDocuments.state, stateThrough: draftDocuments.stateThrough })
			.from(draftDocuments)
			.where(scope.where(draftDocuments, eq(draftDocuments.id, live.id)));
		if (!row) return;
		const vector = Y.encodeStateVector(live.doc);
		let after = live.through;
		if (row.stateThrough > live.through) {
			Y.applyUpdate(live.doc, row.state, "server");
			after = row.stateThrough;
		}
		live.through = await applyChanges(scope, live.doc, live.id, after, "server");
		const update = Y.encodeStateAsUpdate(live.doc, vector);
		if (!sameBytes(vector, Y.encodeStateVector(live.doc))) {
			for (const connection of live.connections) sendFrame(connection, "changed", update);
		}
	};

	const beat = async () => {
		const now = Date.now();
		for (const live of documents.values()) {
			let expired = false;
			for (const [from, remote] of live.remote) if (remote.until < now) expired = live.remote.delete(from) || expired;
			for (const [id, client] of live.clients) if (client.until < now) expired = live.clients.delete(id) || expired;
			if (expired) sendPresence(live);
			if (live.connections.size > 0) await announce(live).catch(() => {});
			// Also the only moment a connection sitting idle (no change, no presence update) learns that
			// access moved: `stillReading` ends it, or keeps `editable` fresh and tells it if it changed.
			for (const connection of [...live.connections]) await stillReading(connection);
		}
	};

	// ----------------------------------------------------------------------------------------------
	// Documents

	const enqueue = (live: LiveDocument, work: () => Promise<void>) => {
		live.queue = live.queue.then(work).catch((error: unknown) => log.error("Co-editing work failed", { error }));
		return live.queue;
	};

	const load = async (scope: SiteScope, item: HistoryItem): Promise<LiveDocument> => {
		const key = keyOf(scope.site.id, item);
		const known = byItem.get(key);
		if (known) return known;
		const pending = loading.get(key);
		if (pending) return pending;
		const made = (async () => {
			await startListening();
			const loaded = await scope.transaction(async (tx) => {
				await lockItem(tx, item);
				const state = await itemState(tx, item);
				let row = await ensureDocument(tx, item, state.draft);
				// A Draft written some other way while nobody had the document open comes in first.
				if (!sameJson(row.draft, state.draft)) {
					await bringIn(tx, item, row, row.draft, state.draft, { personId: null, via: null });
					row = (await lockDocument(tx, item)) ?? row;
				}
				return { id: row.id, ...(await documentOf(tx, row)) };
			});
			const live: LiveDocument = {
				id: loaded.id,
				key,
				workspaceId: scope.workspace.id,
				siteId: scope.site.id,
				item,
				doc: loaded.doc,
				through: loaded.through,
				connections: new Set(),
				remote: new Map(),
				clients: new Map(),
				queue: Promise.resolve(),
			};
			documents.set(live.id, live);
			byItem.set(key, live);
			return live;
		})();
		loading.set(key, made);
		try {
			return await made;
		} finally {
			loading.delete(key);
		}
	};

	/** Drops a document that no longer exists: its editors' sockets close, and they open it again. */
	const letGo = (live: LiveDocument) => {
		documents.delete(live.id);
		if (byItem.get(live.key) === live) byItem.delete(live.key);
		clearTimeout(live.unload);
		for (const connection of [...live.connections]) {
			connection.closed = true;
			connection.peer.close(4409, "DOCUMENT_REPLACED");
		}
		live.connections.clear();
	};

	const unloadLater = (live: LiveDocument) => {
		clearTimeout(live.unload);
		live.unload = setTimeout(() => {
			if (live.connections.size > 0) return;
			documents.delete(live.id);
			if (byItem.get(live.key) === live) byItem.delete(live.key);
			live.doc.destroy();
		}, deps.unloadAfterMs ?? 30_000);
		live.unload.unref?.();
	};

	const nameOf = async (personId: string): Promise<string> => {
		const known = names.get(personId);
		if (known !== undefined) return known;
		const [row] = await deps.database.db.select({ name: people.name }).from(people).where(eq(people.id, personId));
		const name = row?.name ?? "";
		if (names.size > 1000) names.clear();
		names.set(personId, name);
		return name;
	};

	// ----------------------------------------------------------------------------------------------
	// Talking to editors

	const send = (connection: Connection, message: ServerMessage) => {
		if (!connection.closed) connection.peer.send(JSON.stringify(message));
	};

	const sendFrame = (connection: Connection, kind: FrameKind, data: Uint8Array) => {
		if (!connection.closed) connection.peer.send(encodeFrame(kind, data));
	};

	const participantsOf = (live: LiveDocument): Participant[] => {
		const now = Date.now();
		return [
			...[...live.connections].map((connection) => connection.participant),
			...[...live.remote.values()].filter((remote) => remote.until >= now).flatMap((remote) => remote.list),
			...[...live.clients.values()].filter((client) => client.until >= now).map(({ until: _, ...client }) => client),
		];
	};

	const sendPresence = (live: LiveDocument) => {
		const participants = participantsOf(live);
		for (const connection of live.connections) {
			send(connection, {
				type: "presence",
				participants: participants.map((participant) =>
					participant.id === connection.id ? { ...participant, self: true } : participant,
				),
			});
		}
	};

	/** Tells the other web processes who has the document open here. */
	const announce = (live: LiveDocument) =>
		notify(deps.database.db, {
			t: "presence",
			d: live.id,
			from: processId,
			list: [...live.connections].slice(0, 20).map((connection) => connection.participant),
		});

	const presenceChanged = (live: LiveDocument) => {
		sendPresence(live);
		void announce(live).catch((error: unknown) => log.warn("Announcing presence failed", { error }));
	};

	/** Keeps a connection's `editable` fresh and tells its editor the moment it moves either way. */
	const setEditable = (connection: Connection, editable: boolean) => {
		if (connection.closed || connection.editable === editable) return;
		connection.editable = editable;
		send(connection, { type: "editable", editable });
	};

	const end = (connection: Connection, code: Extract<ServerMessage, { type: "ended" }>["code"]) => {
		if (connection.closed) return;
		send(connection, { type: "ended", code });
		connection.peer.close(CLOSE_CODES[code], code);
		leave(connection);
	};

	const leave = (connection: Connection) => {
		if (connection.closed) return;
		connection.closed = true;
		const { live } = connection;
		live.connections.delete(connection);
		presenceChanged(live);
		if (live.connections.size > 0) return;
		const now = Date.now();
		const othersHere = [...live.remote.values()].some((remote) => remote.until >= now && remote.list.length > 0);
		if (!othersHere) {
			// The last participant left: the Draft as it is now is kept as a Checkpoint.
			void enqueue(live, async () => {
				const access = await connection.recheck().catch(() => null);
				if (!access) return;
				const scope = await deps.data.site(access, live.siteId, readPermission(live.item));
				await deps.history.leave(scope, live.item);
			});
		}
		unloadLater(live);
	};

	const receive = (connection: Connection, data: string | Uint8Array) => {
		if (connection.closed) return;
		const bytes = typeof data === "string" ? new TextEncoder().encode(data).length : data.length;
		if (bytes > DRAFT_LIMITS.messageBytes) return end(connection, "MESSAGE_TOO_LARGE");
		const minute = Math.floor(clock.now().getTime() / 60_000);
		if (connection.window.start !== minute) connection.window = { start: minute, count: 0 };
		if (++connection.window.count > DRAFT_LIMITS.messagesPerMinute) return end(connection, "TOO_MANY_MESSAGES");

		const { live } = connection;
		if (typeof data === "string") {
			let message: EditorMessage;
			try {
				message = JSON.parse(data) as EditorMessage;
			} catch {
				return end(connection, "BAD_MESSAGE");
			}
			if (message?.type !== "presence") return end(connection, "BAD_MESSAGE");
			const at = message.at;
			if (at !== null && (typeof at !== "string" || at.length > DRAFT_LIMITS.placeLength)) {
				return end(connection, "BAD_MESSAGE");
			}
			void enqueue(live, async () => {
				if (!(await stillReading(connection))) return;
				connection.participant = { ...connection.participant, at };
				presenceChanged(live);
			});
			return;
		}
		const frame = decodeFrame(data);
		if (!frame || frame.kind === "changed") return end(connection, "BAD_MESSAGE");
		if (frame.kind === "sync") {
			const vector = frame.data.slice();
			void enqueue(live, async () => {
				if (connection.closed) return;
				let state: Uint8Array;
				try {
					state = Y.encodeStateAsUpdate(live.doc, vector);
				} catch {
					return end(connection, "BAD_MESSAGE");
				}
				connection.awaitingSync = false;
				sendFrame(connection, "state", state);
			});
			return;
		}
		// A change (`change`), or the changes an editor made offline (`state`, numbered 0).
		if (connection.awaitingSync) return;
		connection.pending.push({ seq: frame.kind === "change" ? frame.seq : 0, update: frame.data.slice() });
		void enqueue(live, () => drain(live));
	};

	/**
	 * The person's session still holds and they may still read the item; ends the connection otherwise.
	 * Also keeps `connection.editable` fresh and tells the editor the moment it moves (`setEditable`):
	 * every call here re-reads access, so a batch of changes, a presence update (an editor sends one
	 * whenever the person's place in the Draft changes, never held back by read-only) and the 30-second
	 * beat all notice access granted or taken away without waiting for a reconnect.
	 */
	const stillReading = async (connection: Connection): Promise<Access | null> => {
		const access = await connection.recheck().catch(() => null);
		if (!access) {
			end(connection, "SESSION_ENDED");
			return null;
		}
		if (!can(access.actor, readPermission(connection.live.item), resourceOf(connection.live))) {
			end(connection, "ACCESS_LOST");
			return null;
		}
		connection.access = access;
		setEditable(connection, can(access.actor, editPermission(connection.live.item), resourceOf(connection.live)));
		return access;
	};

	const drain = async (live: LiveDocument) => {
		for (const connection of [...live.connections]) {
			if (connection.closed || connection.pending.length === 0 || connection.awaitingSync) continue;
			const batch = connection.pending.splice(0);
			const seq = batch.at(-1)?.seq ?? 0;
			let update: Uint8Array;
			try {
				update =
					batch.length === 1
						? (batch[0]?.update ?? new Uint8Array())
						: Y.mergeUpdates(batch.map((each) => each.update));
			} catch {
				refuse(connection, seq, { code: "DRAFT_CHANGE_INVALID", message: "The change can't be read." });
				continue;
			}
			await applyChange(connection, seq, update);
		}
	};

	/**
	 * Checks one editor's change and saves it, in one transaction: the item and its document held, the
	 * changes other processes made brought in first, the change tried on a copy and saved through the
	 * item's own save as the person, then kept. Only then do the other editors get it.
	 *
	 * Whether the person may edit is read fresh here, every batch (not kept from `open()`'s welcome):
	 * access granted since reaches them without a reconnect, and access taken away refuses them and
	 * tells them, rather than waiting for the next heartbeat (`setEditable`, also run there).
	 */
	const applyChange = async (connection: Connection, seq: number, update: Uint8Array) => {
		const { live } = connection;
		const access = await stillReading(connection);
		if (!access) return;
		if (!connection.editable) {
			return refuse(connection, seq, { code: "FORBIDDEN", message: "You may only read this Draft." });
		}
		let changeId = 0;
		let accepted = update;
		let derived: Uint8Array | undefined;
		try {
			const scope = await deps.data.site(access, live.siteId, editPermission(live.item));
			// A deadlock or a serialization failure means only that this ran into another transaction,
			// never that the change itself was wrong: safe, and worth trying again once before dropping it.
			for (let attempt = 1; ; attempt++) {
				try {
					await scope.transaction(async (tx) => {
						await lockItem(tx, live.item);
						const row = await lockDocument(tx, live.item);
						if (!row || row.id !== live.id) throw new DocumentReplacedError();
						await catchUpIn(tx, live);
						const trial = copyDocument(live.doc);
						try {
							accepted = update;
							derived = undefined;
							Y.applyUpdate(trial, update);
							if (trial.store.pendingStructs || trial.store.pendingDs) throw new MissingChangesError();
							const before = readDocument(live.doc);
							const after = readDocument(trial);
							if (!sameValue(before, after)) {
								await writingFromDocument(tx, live.item, () =>
									saveLiveChange(tx, live.item, before, after, deps.components),
								);
							}
							const stored = (await itemState(tx, live.item)).draft;
							// Component saves derive declaration ids, retained contracts and binding projections.
							// Keep the authored update's own echo suppressed; send only the derived delta back.
							const canonical = documentView(live.item.kind, stored);
							if (live.item.kind === "component" && !sameValue(after, canonical)) {
								const vector = Y.encodeStateVector(trial);
								changeDocument(trial, canonical);
								derived = Y.encodeStateAsUpdate(trial, vector);
								accepted = Y.mergeUpdates([update, derived]);
							}
							changeId = await recordChange(tx, row, accepted, stored, {
								personId: personIdOf(access.actor),
								via: access.via,
							});
						} finally {
							trial.destroy();
						}
					});
					break;
				} catch (error) {
					if (isSerializationFailure(error) && attempt < 2) continue;
					throw error;
				}
			}
		} catch (error) {
			if (error instanceof PermissionDeniedError || error instanceof SiteNotFoundError) {
				return end(connection, "ACCESS_LOST");
			}
			if (error instanceof DocumentReplacedError) {
				// The document went (unused for long, or its item deleted): editors open it again from scratch.
				return letGo(live);
			}
			if (error instanceof MissingChangesError) {
				return refuse(connection, seq, {
					code: "DRAFT_CHANGE_INVALID",
					message: "The change builds on changes the server doesn't have.",
				});
			}
			const refusal = deps.describe(error);
			if (!refusal) {
				log.error("A change to a Draft failed", { error, item: live.item.kind });
				return refuse(connection, seq, { code: "INTERNAL_SERVER_ERROR", message: "The change couldn't be saved." });
			}
			return refuse(connection, seq, refusal);
		}
		const vector = Y.encodeStateVector(live.doc);
		Y.applyUpdate(live.doc, accepted, connection);
		live.through = Math.max(live.through, changeId);
		const passed = Y.encodeStateAsUpdate(live.doc, vector);
		for (const other of live.connections) if (other !== connection) sendFrame(other, "changed", passed);
		if (derived) sendFrame(connection, "changed", derived);
		send(connection, { type: "saved", seq });
	};

	const refuse = (connection: Connection, seq: number, refusal: DraftRefusal) => {
		connection.pending.length = 0;
		connection.awaitingSync = true;
		send(connection, { type: "refused", seq, code: refusal.code, message: refusal.message, data: refusal.data });
		// The whole document as the server holds it: the editor starts again from it.
		sendFrame(connection, "state", Y.encodeStateAsUpdate(connection.live.doc));
	};

	return {
		async open(request) {
			if (stopped) throw new Error("Co-editing has stopped.");
			const { item, access } = request;
			if (!isLiveKind(item.kind)) throw new DraftNotLiveError();
			const scope = await deps.data.site(access, request.siteId, readPermission(item));
			const personId = personIdOf(access.actor);
			const open = [...documents.values()].reduce(
				(count, live) =>
					count + [...live.connections].filter((connection) => connection.participant.personId === personId).length,
				0,
			);
			if (open >= DRAFT_LIMITS.openPerPerson) throw new TooManyDraftsError();
			const live = await load(scope, item);
			const resource = resourceOf(live);
			const editable = can(access.actor, editPermission(item), resource);
			const name = personId ? await nameOf(personId) : "";
			const via = clientOf(access.via);
			const impersonator = impersonatorNameOf(access.via);
			return {
				attach(peer) {
					const connection: Connection = {
						id: crypto.randomUUID(),
						live,
						peer,
						participant: {
							id: "",
							personId,
							name,
							via,
							...(impersonator ? { impersonator } : {}),
							colour: colourOf(personId),
							at: null,
						},
						access,
						recheck: request.recheck,
						editable,
						pending: [],
						awaitingSync: false,
						window: { start: 0, count: 0 },
						closed: false,
					};
					connection.participant.id = connection.id;
					clearTimeout(live.unload);
					live.connections.add(connection);
					send(connection, {
						type: "welcome",
						document: live.id,
						you: { ...connection.participant, self: true },
						editable,
					});
					void enqueue(live, async () => {
						// What the editor lacks comes when it asks (`sync`); this asks for what it made offline.
						sendFrame(connection, "sync", Y.encodeStateVector(live.doc));
						presenceChanged(live);
					});
					return {
						receive: (data) => receive(connection, data),
						closed: () => leave(connection),
					};
				},
			};
		},
		async stop() {
			stopped = true;
			clearInterval(heartbeat);
			for (const live of documents.values()) {
				clearTimeout(live.unload);
				for (const connection of [...live.connections]) {
					connection.closed = true;
					connection.peer.close(1001, "The web process is stopping.");
				}
				await live.queue;
				live.doc.destroy();
			}
			documents.clear();
			byItem.clear();
			const open = listener;
			listener = null;
			if (open) await (await open.catch(() => null))?.close();
		},
	};
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

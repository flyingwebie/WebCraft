import * as Y from "yjs";

import { changeDocument, copyDocument, type Json, mergeChange, readDocument } from "./document.ts";
import {
	decodeFrame,
	type EditorMessage,
	encodeFrame,
	OFFLINE_EDITING_MS,
	type Participant,
	SEND_EVERY_MS,
	type ServerMessage,
} from "./protocol.ts";

/**
 * An editor's side of a shared document (ADR 0025): its own copy of the document, which its person
 * changes at once, and the conversation with the web process that keeps the copies of everyone
 * editing it the same. The admin's editors use it over a WebSocket; the test harness over the
 * handler's in-process socket. It imports nothing but Yjs, so it runs in the browser.
 *
 * - Changes are sent in batches (at most one every `sendEveryMs` while the person types), each
 *   numbered; the server answers each with `saved`, or `refused`, after which the editor starts again
 *   from the document as the server holds it (the refused change is gone for everyone).
 * - Without the server, changes stay in the copy and are sent when it is back, where they merge.
 *   After `OFFLINE_EDITING_MS` without it the editor turns read-only until it is back.
 * - A document made again since (a new `document` id) is started from afresh, with the changes the
 *   editor hadn't had saved made again on it.
 */

/** A way to the server: a WebSocket, or the harness's stand-in. */
export type DraftTransport = { send(data: string | Uint8Array): void; close(): void };

/**
 * Where the editor stands:
 * - `connecting`: before the server welcomed it (the first time, or again after a break);
 * - `saving`: changes made that the server hasn't saved yet;
 * - `saved`: everything saved;
 * - `offline`: no server, changes kept to send later;
 * - `readOnly`: no server for too long, or the person may only read it;
 * - `ended`: the session ended or access was lost; editing is over.
 */
export type DraftStatus = "connecting" | "saving" | "saved" | "offline" | "readOnly" | "ended";

export type DraftRefused = Extract<ServerMessage, { type: "refused" }>;

export type DraftEvents = {
	/** The Draft changed: the person's own change (`local`) or someone else's, or a fresh start. */
	onChange?(draft: Json, from: "local" | "remote"): void;
	onStatus?(status: DraftStatus): void;
	onPresence?(participants: Participant[]): void;
	onRefused?(refusal: DraftRefused): void;
	onPublished?(by: Extract<ServerMessage, { type: "published" }>["by"]): void;
	onEnded?(code: Extract<ServerMessage, { type: "ended" }>["code"]): void;
};

export type DraftClient = {
	/** The Draft as this editor's copy holds it now. */
	draft(): Json;
	/**
	 * Changes the Draft to `next` (the smallest change that gets there), at once in this copy, and
	 * sends it with the next batch. Ignored, answering false, while the editor is read-only.
	 */
	change(next: Json | ((current: Json) => Json)): boolean;
	/** Holds an editor's document while it parses input. Keeping it after apply lets further input use the same view until the editor displays the merged document; cancel releases it. */
	prepare(): { before: Json; apply(next: Json, options?: { keep: boolean }): boolean; cancel(): void } | null;
	/** Says where the person is in it (a value's key, an element's id), or nowhere (null). */
	place(at: string | null): void;
	/** Sends what is waiting now, without waiting for the batch. */
	flush(): void;
	status(): DraftStatus;
	participants(): Participant[];
	/** Whether the person may change it (false: read-only for them). */
	editable(): boolean;
	/** Starts talking to the server over a transport; answers what to call when it receives or closes. */
	connect(transport: DraftTransport): { receive(data: string | Uint8Array): void; closed(): void };
	/** Stops for good: closes the transport, sends nothing more. */
	close(): void;
};

export type DraftClientOptions = DraftEvents & {
	/** How often a batch of changes goes while the person types; `SEND_EVERY_MS` unless given (0: at once). */
	sendEveryMs?: number;
	/** How long the editor keeps editing without the server; `OFFLINE_EDITING_MS` unless given. */
	offlineEditingMs?: number;
	/** The time, in milliseconds. */
	now?(): number;
};

/** The origin of changes that came from the server, which aren't sent back. */
const FROM_SERVER = Symbol("server");

export function createDraftClient(options: DraftClientOptions = {}): DraftClient {
	const sendEvery = options.sendEveryMs ?? SEND_EVERY_MS;
	const offlineLimit = options.offlineEditingMs ?? OFFLINE_EDITING_MS;
	const now = options.now ?? (() => Date.now());

	let doc = new Y.Doc();
	let documentId: string | null = null;
	let transport: DraftTransport | null = null;
	let welcomed = false;
	let mayEdit = true;
	let ended = false;
	let closedForGood = false;
	let resetting = false;
	/** Whether the copy has had the server's document yet: before that, nothing can be changed in it. */
	let synced = false;
	/** Whether the reset under way follows a refusal (the refused change is dropped) or a document made again. */
	let afterRefusal = false;
	/** Whether changes made offline went to the server (as `state`) and aren't saved yet. */
	let stateUnsaved = false;
	let scheduled = false;
	let seq = 0;
	/** The highest change sent, and the highest the server saved. */
	let sentThrough = 0;
	let savedThrough = 0;
	/** Changes not sent yet. */
	let unsent: Uint8Array[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let offlineSince: number | null = null;
	let offlineTimer: ReturnType<typeof setTimeout> | undefined;
	let currentStatus: DraftStatus = "connecting";
	let presence: Participant[] = [];
	let place: string | null = null;
	/** The Draft as the server last confirmed it: a fresh document gets the changes made since. */
	let confirmed: Json = null;

	const setStatus = (next: DraftStatus) => {
		if (currentStatus === next) return;
		currentStatus = next;
		options.onStatus?.(next);
	};

	const settled = (): DraftStatus => {
		if (ended) return "ended";
		if (!transport || !welcomed || !synced)
			return offlineSince !== null && now() - offlineSince >= offlineLimit
				? "readOnly"
				: transport || !synced
					? "connecting"
					: "offline";
		if (!mayEdit) return "readOnly";
		return unsent.length > 0 || sentThrough > savedThrough || stateUnsaved ? "saving" : "saved";
	};

	const watch = (target: Y.Doc) => {
		target.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === FROM_SERVER) return;
			unsent.push(update);
			setStatus(settled());
			schedule();
		});
	};
	watch(doc);

	const sendText = (message: EditorMessage) => transport?.send(JSON.stringify(message));

	const schedule = () => {
		if (scheduled || !transport || !welcomed || resetting) return;
		scheduled = true;
		if (sendEvery <= 0) queueMicrotask(() => flush());
		else timer = setTimeout(() => flush(), sendEvery);
	};

	const flush = () => {
		clearTimeout(timer);
		timer = undefined;
		scheduled = false;
		if (!transport || !welcomed || resetting || unsent.length === 0 || !mayEdit) return;
		const update = unsent.length === 1 ? (unsent[0] ?? new Uint8Array()) : Y.mergeUpdates(unsent);
		unsent = [];
		seq += 1;
		sentThrough = seq;
		transport.send(encodeFrame("change", update, seq));
		setStatus(settled());
	};

	/** Starts again from the whole document the server sent, keeping the person's changes not yet saved when asked. */
	const startAgain = (state: Uint8Array, keepUnsaved: boolean) => {
		const mine = readDocument(doc);
		const base = confirmed;
		doc.destroy();
		doc = new Y.Doc();
		Y.applyUpdate(doc, state, FROM_SERVER);
		watch(doc);
		unsent = [];
		sentThrough = seq;
		savedThrough = seq;
		stateUnsaved = false;
		synced = true;
		confirmed = readDocument(doc);
		options.onChange?.(confirmed, "remote");
		if (keepUnsaved && base !== null) {
			const merged = mergeChange(base, mine, readDocument(doc));
			changeDocument(doc, merged);
			options.onChange?.(readDocument(doc), "local");
		}
	};

	const receive = (data: string | Uint8Array) => {
		if (closedForGood) return;
		if (typeof data === "string") {
			const message = JSON.parse(data) as ServerMessage;
			switch (message.type) {
				case "welcome": {
					const fresh = documentId !== null && documentId !== message.document;
					documentId = message.document;
					mayEdit = message.editable;
					welcomed = true;
					offlineSince = null;
					clearTimeout(offlineTimer);
					resetting = fresh;
					afterRefusal = false;
					// Whatever was sent and not saved goes again with what the server lacks (`sync` below).
					savedThrough = sentThrough;
					// Ask for what this copy lacks (all of it, for a document made again since).
					transport?.send(encodeFrame("sync", fresh ? Y.encodeStateVector(new Y.Doc()) : Y.encodeStateVector(doc)));
					if (place !== null) sendText({ type: "presence", at: place });
					setStatus(settled());
					return;
				}
				case "presence":
					presence = message.participants;
					options.onPresence?.(presence);
					return;
				case "editable":
					// Access granted or taken away while the socket stayed open: unlocks or locks at once.
					mayEdit = message.editable;
					setStatus(settled());
					return;
				case "saved":
					if (message.seq === 0) stateUnsaved = false;
					savedThrough = Math.max(savedThrough, message.seq);
					if (sentThrough <= savedThrough && unsent.length === 0 && !stateUnsaved) confirmed = readDocument(doc);
					setStatus(settled());
					return;
				case "refused":
					// The server drops the change for everyone and sends its whole document next.
					resetting = true;
					afterRefusal = true;
					unsent = [];
					options.onRefused?.(message);
					return;
				case "published":
					options.onPublished?.(message.by);
					return;
				case "ended":
					ended = true;
					options.onEnded?.(message.code);
					setStatus("ended");
					return;
			}
			return;
		}
		const frame = decodeFrame(data);
		if (!frame) return;
		switch (frame.kind) {
			case "state":
				if (resetting) {
					// After a refusal the refused change is gone; a document made again keeps what wasn't saved.
					startAgain(frame.data, !afterRefusal);
					resetting = false;
					afterRefusal = false;
					transport?.send(encodeFrame("sync", Y.encodeStateVector(doc)));
					setStatus(settled());
					schedule();
					return;
				}
				Y.applyUpdate(doc, frame.data, FROM_SERVER);
				synced = true;
				if (confirmed === null || unsent.length === 0) confirmed = readDocument(doc);
				options.onChange?.(readDocument(doc), "remote");
				setStatus(settled());
				return;
			case "changed":
				Y.applyUpdate(doc, frame.data, FROM_SERVER);
				options.onChange?.(readDocument(doc), "remote");
				return;
			case "sync": {
				if (resetting) return;
				// What this copy has that the server lacks: the changes made while offline, merged like any change.
				const missing = Y.encodeStateAsUpdate(doc, frame.data);
				unsent = [];
				if (missing.length > 2 && mayEdit) {
					transport?.send(encodeFrame("state", missing));
					stateUnsaved = true;
				}
				setStatus(settled());
				return;
			}
			default:
				return;
		}
	};

	const lost = () => {
		transport = null;
		welcomed = false;
		clearTimeout(timer);
		timer = undefined;
		scheduled = false;
		if (ended || closedForGood) return;
		offlineSince ??= now();
		setStatus(settled());
		clearTimeout(offlineTimer);
		const left = Math.max(0, offlineLimit - (now() - offlineSince));
		offlineTimer = setTimeout(() => setStatus(settled()), left + 10);
	};

	const canEdit = () => !ended && !closedForGood && mayEdit && synced && settled() !== "readOnly" && !resetting;
	return {
		draft: () => readDocument(doc),
		change(next) {
			if (!canEdit()) return false;
			const value = typeof next === "function" ? next(readDocument(doc)) : next;
			changeDocument(doc, value);
			options.onChange?.(readDocument(doc), "local");
			return true;
		},
		prepare() {
			if (!canEdit()) return null;
			const original = doc;
			const pending = copyDocument(doc);
			let used = false;
			const cancel = () => {
				used = true;
				pending.destroy();
			};
			return {
				before: readDocument(pending),
				cancel,
				apply(next, applyOptions) {
					if (used || doc !== original || !canEdit()) {
						cancel();
						return false;
					}
					const vector = Y.encodeStateVector(pending);
					changeDocument(pending, next);
					Y.applyUpdate(doc, Y.encodeStateAsUpdate(pending, vector));
					if (!applyOptions?.keep) cancel();
					options.onChange?.(readDocument(doc), "local");
					return true;
				},
			};
		},
		place(at) {
			place = at;
			if (welcomed) sendText({ type: "presence", at });
		},
		flush,
		status: () => settled(),
		participants: () => presence,
		editable: () => mayEdit && !ended,
		connect(next) {
			transport = next;
			welcomed = false;
			setStatus(settled());
			return { receive, closed: lost };
		},
		close() {
			closedForGood = true;
			clearTimeout(timer);
			clearTimeout(offlineTimer);
			transport?.close();
			transport = null;
		},
	};
}

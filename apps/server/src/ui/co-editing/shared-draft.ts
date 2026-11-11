import {
	createDraftClient,
	type Json as DocumentJson,
	DRAFTS_PROTOCOL,
	type DraftClient,
	type DraftRefused,
	type DraftStatus,
	type Participant,
	type ServerMessage,
} from "@webcraft/core/draft-document";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * An editor's shared Draft (Co-editing, ADR 0025): the Draft's document, opened over a WebSocket to
 * the web process (`/api/drafts/<site>/<kind>/<id>` on the admin host), which merges the changes of
 * everyone editing it. Changes made here go to the server in batches and come back saved or refused;
 * others' changes arrive as they are saved. A dropped connection is opened again by itself (after 1,
 * 2, 4, 8, then every 15 seconds); meanwhile changes are kept, and after 5 minutes without the server
 * the editor turns read-only until it is back.
 */

export type PublishedBy = Extract<ServerMessage, { type: "published" }>["by"];

export type SharedDraft = {
	status: DraftStatus;
	/** Who has it open (this editor included, `self`), and API clients that changed it a moment ago. */
	participants: Participant[];
	/** Whether the person may change it. */
	editable: boolean;
	/** Permission plus a loaded document and an editing connection state. */
	writable: boolean;
	/** The Draft as this editor's copy holds it now. */
	draft(): DocumentJson;
	/** Changes the Draft: a function of what it holds, answering the new Draft. False while it can't be changed. */
	change(next: (current: DocumentJson) => DocumentJson): boolean;
	prepare: DraftClient["prepare"];
	/** Says where the person is (a value's key), or nowhere. */
	place(at: string | null): void;
	/** Sends what is waiting and waits until it is saved: false when it can't be (offline, refused). */
	flush(): Promise<boolean>;
};

/** How long to wait before opening a dropped connection again, attempt by attempt. */
const RECONNECT_MS = [1000, 2000, 4000, 8000, 15_000];

/** Close codes after which opening again can't help: the session ended or access was lost. */
const FINAL_CLOSES = new Set([4401, 4403]);

export function useSharedDraft(options: {
	/** The socket's path on the admin host, such as `/api/drafts/<site id>/entry/<entry id>`. */
	path: string | null;
	token?: string;
	/** Someone else's change arrived (or the Draft started again from the server's): show it. */
	onRemote(draft: DocumentJson): void;
	/** A moment after changes were saved (anyone's): read what the server worked out (problems, status). */
	onSettled?(): void;
	onRefused?(refusal: DraftRefused): void;
	onPublished?(by: PublishedBy): void;
}): SharedDraft {
	const [status, setStatus] = useState<DraftStatus>("connecting");
	const [participants, setParticipants] = useState<Participant[]>([]);
	const [editable, setEditable] = useState(false);
	const client = useRef<DraftClient | null>(null);
	const handlers = useRef(options);
	handlers.current = options;

	useEffect(() => {
		const path = options.path;
		if (!path) return;
		let stopped = false;
		let socket: WebSocket | null = null;
		let attempt = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let settle: ReturnType<typeof setTimeout> | undefined;
		const settleSoon = () => {
			clearTimeout(settle);
			settle = setTimeout(() => handlers.current.onSettled?.(), 500);
		};
		const draft = createDraftClient({
			onChange: (next, from) => {
				if (from === "remote") {
					handlers.current.onRemote(next);
					settleSoon();
				}
			},
			onStatus: (next) => {
				setStatus(next);
				setEditable(draft.editable());
				if (next === "saved") {
					attempt = 0;
					settleSoon();
				}
			},
			onPresence: setParticipants,
			onRefused: (refusal) => handlers.current.onRefused?.(refusal),
			onPublished: (by) => {
				handlers.current.onPublished?.(by);
				settleSoon();
			},
		});
		client.current = draft;

		const open = () => {
			if (stopped) return;
			const url = new URL(path, window.location.href);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const opened = new WebSocket(url, [
				DRAFTS_PROTOCOL,
				...(options.token ? [`webcraft-edit-token.${options.token}`] : []),
			]);
			opened.binaryType = "arraybuffer";
			socket = opened;
			let ends: ReturnType<DraftClient["connect"]> | null = null;
			opened.addEventListener("open", () => {
				ends = draft.connect({
					send: (data) => opened.send(typeof data === "string" ? data : new Uint8Array(data)),
					close: () => opened.close(),
				});
			});
			opened.addEventListener("message", (event) => {
				ends?.receive(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
			});
			opened.addEventListener("close", (event) => {
				ends?.closed();
				if (socket === opened) socket = null;
				if (stopped || FINAL_CLOSES.has(event.code) || draft.status() === "ended") return;
				const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 15_000;
				attempt += 1;
				retry = setTimeout(open, wait);
			});
		};
		open();
		// The browser says when the network is back: try at once rather than wait.
		const online = () => {
			if (socket || stopped) return;
			clearTimeout(retry);
			open();
		};
		window.addEventListener("online", online);
		return () => {
			stopped = true;
			clearTimeout(retry);
			clearTimeout(settle);
			window.removeEventListener("online", online);
			draft.close();
			socket?.close();
			client.current = null;
		};
	}, [options.path, options.token]);

	const change = useCallback((next: (current: DocumentJson) => DocumentJson) => {
		const draft = client.current;
		return draft ? draft.change(next) : false;
	}, []);
	const place = useCallback((at: string | null) => client.current?.place(at), []);
	const flush = useCallback(async () => {
		const draft = client.current;
		if (!draft) return false;
		draft.flush();
		const started = Date.now();
		while (Date.now() - started < 10_000) {
			const now = draft.status();
			if (now === "saved") return true;
			if (now !== "saving") return false;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return false;
	}, []);
	const read = useCallback(() => client.current?.draft() ?? null, []);
	const prepare = useCallback(() => client.current?.prepare() ?? null, []);

	const writable = editable && (status === "saved" || status === "saving" || status === "offline");
	return { status, participants, editable, writable, draft: read, change, prepare, place, flush };
}

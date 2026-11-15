import {
	createDraftClient,
	DRAFTS_PROTOCOL,
	type DraftClient,
	EDIT_TOKEN_PROTOCOL_PREFIX,
	type Json,
	type Participant,
	reverseChange,
	type ServerMessage,
} from "@webcraft/core/draft-document";

import type { HistoryPort, HistoryResult } from "../../builder/editor-history.ts";

/**
 * The shared Drafts of the page in the frame (Co-editing, ADR 0025; ADR 0037 › 1.5): the shell opens
 * each Draft the page's regions show once (its Entry, the Globals) over the Site's own sockets
 * (`/_webcraft/edit/drafts/<kind>[/<id>]`, the edit cookie and the session's header token), the way
 * the editing bar does. Nothing changes on the server.
 *
 * - Others' changes arrive as they are saved: `onRemote` shows them in the regions nobody is typing in.
 * - Who else has each Draft open, and where they are in it (a Field's key), is Presence (`presence.ts`).
 * - Each open Draft takes the Undo history's steps back (`register`); a step on a Draft of a page left
 *   earlier opens that Draft for the step alone (`reverseElsewhere`).
 *
 * What the person types still saves through the page's `save` edit request, which writes through the
 * same shared documents: their own changes come back here as the server's, and change nothing shown.
 */
export type PageDrafts = {
	/** The page shows these items (`entry:<id>`, `globals`): their Drafts open, any other closes. */
	show(items: readonly string[]): void;
	/** Says where the person is: in an item's value (its Field's key), or nowhere (`item` null). */
	place(item: string | null, at: string | null): void;
	/** Who else is in each of the page's Drafts now, by item: others only, never the person's own tabs. */
	others(): ReadonlyMap<string, readonly Participant[]>;
	/** Called when someone comes, goes or moves. Answers how to stop listening. */
	subscribe(listener: () => void): () => void;
	/**
	 * An open Draft's client (`entry:<id>`), for a part that changes it itself (BA-09: a Page's Page
	 * layout), through this one socket: a second one would show the person to themselves as someone else.
	 */
	client(item: string): DraftClient | null;
	/** Called on every change of an open Draft (the person's, someone else's, a step taken back). */
	onChange(listener: (item: string, draft: Json) => void): () => void;
	/** Stops for good: every socket closes. */
	destroy(): void;
};

/** A step's resource names its Draft: `draft:<site id>:entry:<id>` or `draft:<site id>:globals`. */
export function draftResource(siteId: string, item: string): string {
	return `draft:${siteId}:${item}`;
}

/** The socket of an item's Draft on the Site's own address. */
function socketUrl(item: string): URL | null {
	const [kind = "", id = ""] = item.split(":");
	if (kind !== "globals" && kind !== "entry") return null;
	const url = new URL(`/_webcraft/edit/drafts/${kind}${kind === "entry" ? `/${id}` : ""}`, window.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url;
}

/** How long to wait before opening a dropped connection again, attempt by attempt. */
const RECONNECT_MS = [1000, 2000, 4000, 8000, 15_000];

/**
 * How long a step waits for the shell's copy of its Draft to hold the step's own change before it is
 * taken back. The change was saved over HTTP (`save`), so it reaches the copy as the server's, a
 * moment later: Undo pressed while still typing would otherwise find it missing and skip it.
 */
const CATCH_UP_MS = 1500;

/** Waits until the copy holds `from` where the step changed it (or the wait is over). */
async function caughtUp(client: DraftClient, from: Json, to: Json): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < CATCH_UP_MS) {
		try {
			reverseChange(from, to, client.draft());
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

/** Close codes after which opening again can't help: the session ended or access was lost. */
const FINAL_CLOSES = new Set([4401, 4403]);

/** Connects a Draft's client to its socket, again after a break; answers how to stop. */
export function connect(client: DraftClient, url: URL, token: string): () => void {
	let stopped = false;
	let attempt = 0;
	let retry: number | undefined;
	let socket: WebSocket | null = null;
	const open = () => {
		if (stopped) return;
		const opened = new WebSocket(url, [DRAFTS_PROTOCOL, `${EDIT_TOKEN_PROTOCOL_PREFIX}${token}`]);
		opened.binaryType = "arraybuffer";
		socket = opened;
		let ends: ReturnType<DraftClient["connect"]> | null = null;
		opened.addEventListener("open", () => {
			attempt = 0;
			ends = client.connect({
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
			if (stopped || FINAL_CLOSES.has(event.code) || client.status() === "ended") return;
			const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)] ?? 15_000;
			attempt += 1;
			retry = window.setTimeout(open, wait);
		});
	};
	open();
	// The browser says when the network is back: try at once rather than wait.
	const online = () => {
		if (socket || stopped) return;
		window.clearTimeout(retry);
		open();
	};
	window.addEventListener("online", online);
	return () => {
		stopped = true;
		window.clearTimeout(retry);
		window.removeEventListener("online", online);
		socket?.close();
	};
}

/**
 * Takes one step back on a Draft the page doesn't show now (a page left earlier in this tab): its
 * socket opens for the step alone, then closes.
 */
export async function reverseElsewhere(item: string, token: string, from: Json, to: Json): Promise<HistoryResult> {
	const url = socketUrl(item);
	if (!url) return { ok: false, code: "HISTORY_UNAVAILABLE" };
	const client = createDraftClient();
	const stop = connect(client, url, token);
	try {
		return await client.reverse(from, to);
	} finally {
		client.close();
		stop();
	}
}

export function pageDrafts(options: {
	token: string;
	siteId: string;
	/** Registers how a Draft takes a step back with the Undo history; answers how to stop. */
	register(resource: string, port: HistoryPort): () => void;
	/**
	 * A Draft changed other than by the person's typing: someone else's change (`own` false), or one of
	 * the person's steps taken back or made again (`own` true).
	 */
	onRemote(item: string, draft: Json, own: boolean): void;
	/** A change of the person's to a Draft was refused (its code). */
	onRefused(code: string): void;
	/** Someone published a Draft the page shows (their name; null when it was the person). */
	onPublished(by: Extract<ServerMessage, { type: "published" }>["by"]): void;
}): PageDrafts {
	type Open = { client: DraftClient; participants: Participant[]; stop: () => void; unregister: () => void };
	const open = new Map<string, Open>();
	const listeners = new Set<() => void>();
	const changeListeners = new Set<(item: string, draft: Json) => void>();
	const tell = () => {
		for (const listener of listeners) listener();
	};

	const openDraft = (item: string) => {
		const url = socketUrl(item);
		if (!url) return;
		const entry: Open = {
			participants: [],
			stop: () => {},
			unregister: () => {},
			client: createDraftClient({
				onChange: (draft, from) => {
					if (from === "remote") options.onRemote(item, draft, false);
					for (const listener of changeListeners) listener(item, draft);
				},
				onPresence: (participants) => {
					entry.participants = participants;
					tell();
				},
				onRefused: (refusal) => options.onRefused(refusal.code),
				onPublished: (by) => options.onPublished(by),
			}),
		};
		entry.stop = connect(entry.client, url, options.token);
		entry.unregister = options.register(draftResource(options.siteId, item), {
			reverse: async (from, to) => {
				await caughtUp(entry.client, from, to);
				const result = await entry.client.reverse(from, to);
				if (result.ok) options.onRemote(item, entry.client.draft(), true);
				return result;
			},
		});
		open.set(item, entry);
	};

	const closeDraft = (item: string) => {
		const entry = open.get(item);
		if (!entry) return;
		open.delete(item);
		entry.unregister();
		entry.client.close();
		entry.stop();
	};

	return {
		show(items) {
			const wanted = new Set(items.filter((item) => item === "globals" || item.startsWith("entry:")));
			for (const item of [...open.keys()]) if (!wanted.has(item)) closeDraft(item);
			for (const item of wanted) if (!open.has(item)) openDraft(item);
			tell();
		},
		place(item, at) {
			for (const [each, entry] of open) entry.client.place(item === each ? at : null);
		},
		others() {
			const found = new Map<string, Participant[]>();
			for (const [item, entry] of open) {
				const others = entry.participants.filter((participant) => !participant.self);
				if (others.length > 0) found.set(item, others);
			}
			return found;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		client: (item) => open.get(item)?.client ?? null,
		onChange(listener) {
			changeListeners.add(listener);
			return () => {
				changeListeners.delete(listener);
			};
		},
		destroy() {
			for (const item of [...open.keys()]) closeDraft(item);
			listeners.clear();
			changeListeners.clear();
		},
	};
}

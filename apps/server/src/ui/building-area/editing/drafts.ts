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
	/**
	 * One of the page's Drafts as a part of the page changes it directly (a body's Blocks, BA-18), once
	 * it is open: null before or without it.
	 */
	shared(item: string): SharedDraft | null;
	/** Called when someone comes, goes or moves. Answers how to stop listening. */
	subscribe(listener: () => void): () => void;
	/** Stops for good: every socket closes. */
	destroy(): void;
};

/**
 * One of the page's shared Drafts as a part changes it directly (the block editor, BA-18), in the shape
 * the editing bar hands its body part (`site/edit-bar/kit.ts`'s `SharedDraft`): what its copy holds, a
 * change made at once and sent with the next batch, others' changes as they come, and a wait until
 * what was sent is saved.
 */
export type SharedDraft = {
	stage: DraftClient["stage"];
	/** Whether it has the server's document yet and may be changed (nothing can be changed before). */
	ready(): boolean;
	draft(): unknown;
	/** Changes the Draft to what `next` makes of it; false while it can't be changed. */
	change(next: (current: unknown) => unknown): boolean;
	/** Hears changes others make (and the person's steps taken back); answers what stops hearing them. */
	listen(listener: (draft: unknown) => void): () => void;
	/** Sends what is waiting and waits (8 seconds at most) until the server saved it; false if it didn't. */
	saved(): Promise<boolean>;
	reverse: DraftClient["reverse"];
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
	type Open = {
		client: DraftClient;
		participants: Participant[];
		stop: () => void;
		unregister: () => void;
		/** Whether the copy has had the server's document. */
		synced: boolean;
		/** How many of the person's changes the server refused, so a wait for a save can tell. */
		refusals: number;
		/** The parts that change it directly, hearing others' changes (`shared`). */
		listeners: Set<(draft: unknown) => void>;
	};
	const open = new Map<string, Open>();
	const listeners = new Set<() => void>();
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
			synced: false,
			refusals: 0,
			listeners: new Set(),
			client: createDraftClient({
				onChange: (draft, from) => {
					entry.synced = true;
					if (from !== "remote") return;
					options.onRemote(item, draft, false);
					for (const listener of entry.listeners) listener(draft);
				},
				onPresence: (participants) => {
					entry.participants = participants;
					tell();
				},
				onRefused: (refusal) => {
					entry.refusals += 1;
					options.onRefused(refusal.code);
				},
				onPublished: (by) => options.onPublished(by),
			}),
		};
		entry.stop = connect(entry.client, url, options.token);
		entry.unregister = options.register(draftResource(options.siteId, item), {
			reverse: async (from, to) => {
				await caughtUp(entry.client, from, to);
				const result = await entry.client.reverse(from, to);
				if (result.ok) {
					const draft = entry.client.draft();
					options.onRemote(item, draft, true);
					for (const listener of entry.listeners) listener(draft);
				}
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
		shared(item) {
			const entry = open.get(item);
			if (!entry) return null;
			const { client } = entry;
			return {
				stage: () => client.stage(),
				ready: () => entry.synced && client.status() !== "readOnly" && client.status() !== "ended",
				draft: () => client.draft(),
				change: (next) => client.change(next as (current: Json) => Json),
				listen(listener) {
					entry.listeners.add(listener);
					return () => {
						entry.listeners.delete(listener);
					};
				},
				reverse: (from, to) => client.reverse(from, to),
				saved() {
					const refusals = entry.refusals;
					client.flush();
					const started = Date.now();
					return new Promise((resolve) => {
						const check = () => {
							const status = client.status();
							if (entry.refusals !== refusals) resolve(false);
							else if (status === "saved") resolve(true);
							else if (status === "readOnly" || status === "ended" || Date.now() - started > 8000) resolve(false);
							else window.setTimeout(check, 100);
						};
						window.setTimeout(check, 50);
					});
				},
			};
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		destroy() {
			for (const item of [...open.keys()]) closeDraft(item);
			listeners.clear();
		},
	};
}

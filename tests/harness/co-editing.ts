// Co-editing as the admin's editors (and Edit mode) do it: an editor opens a Draft's shared document
// over a WebSocket, upgraded through the web handler in process, and talks to the web process with
// WebCraft's own client (`createDraftClient`, the one the admin uses in the browser). Tests change
// the Draft as an editor does (the JSON it should become) and look at what each editor's copy holds,
// what the server says, and what the API reads afterwards.
import {
	createDraftClient,
	type DocumentJson,
	DRAFTS_PROTOCOL,
	type DraftClient,
	type DraftRefused,
	type DraftStatus,
	EDIT_TOKEN_PROTOCOL_PREFIX,
	type Participant,
	type ServerMessage,
	type SocketSession,
} from "@webcraft/core";
import type { SocketUpgrade, UpgradeAnswer } from "@webcraft/server/handler";

import type { EditModeBrowser } from "./edit-mode.ts";
import type { TestBrowser, TestInstall } from "./index.ts";

/** An item as Co-editing names it. */
export type DraftItem =
	| { kind: "entry" | "template" | "component" | "popup" | "popupContent"; id: string }
	| { kind: "globals" };

/** One editor with a Draft open. */
export type TestEditor = {
	/** The Draft as this editor's copy of the document holds it now. */
	draft(): DocumentJson;
	/** Changes the Draft as the editor's person does: the JSON it should become, or a function of what it holds. */
	change(next: DocumentJson | ((current: DocumentJson) => DocumentJson)): boolean;
	/** Says where the person is (a value's key), as an editor does when a Field takes focus. */
	place(at: string | null): void;
	status(): DraftStatus;
	participants(): Participant[];
	/** Every message the server sent, in order. */
	readonly messages: ServerMessage[];
	/** The refusals the server sent, in order. */
	readonly refusals: DraftRefused[];
	/** How the server closed the socket, once it did. */
	closedWith(): { code: number; reason: string } | null;
	/** Waits until `check` holds, failing with `what` after a few seconds. */
	until(check: () => boolean, what: string): Promise<void>;
	/** Waits until the editor's copy holds what `check` looks for. */
	untilDraft(check: (draft: DocumentJson) => boolean, what: string): Promise<void>;
	/** Waits until every change this editor made is saved. */
	saved(): Promise<void>;
	/** The connection breaks (the network, a laptop closing): both ends see it close. */
	disconnect(): void;
	/** Opens the socket again, keeping this editor's copy: what it changed meanwhile goes to the server. */
	reconnect(): Promise<void>;
	/** Closes the editor, as a tab closing does. */
	close(): void;
};

/** How long a wait lasts before it fails. */
const WAIT_MS = 5000;

async function waitUntil(check: () => boolean, what: string): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > WAIT_MS) throw new Error(`Waited too long for: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** The path that names an item's socket after its prefix: `<kind>[/<id>]`. */
export function draftPath(item: DraftItem): string {
	return "id" in item ? `${item.kind}/${item.id}` : item.kind;
}

/** Asks to open an item's Draft from the admin, answering the handler's answer as it is (to test refusals). */
export function upgradeDraft(
	install: TestInstall,
	browser: TestBrowser,
	siteId: string,
	item: DraftItem,
	options: {
		protocols?: readonly string[];
		origin?: string | null;
		/** Another web process (`install.webProcess()`) to open it on. */
		through?: (request: Request) => Promise<UpgradeAnswer>;
	} = {},
): Promise<UpgradeAnswer> {
	return browser.openSocket(install.adminUrl(`/api/drafts/${siteId}/${draftPath(item)}`), {
		protocols: options.protocols ?? [DRAFTS_PROTOCOL],
		origin: options.origin,
		through: options.through,
	});
}

/** Asks to open an item's Draft in Edit mode, on the Site's own domain, answering the handler's answer. */
export async function upgradeDraftInEditMode(
	edit: EditModeBrowser,
	item: DraftItem,
	options: { token?: string | null; origin?: string | null } = {},
): Promise<UpgradeAnswer> {
	const token = options.token === undefined ? await edit.headerToken() : options.token;
	return edit.browser.openSocket(`${edit.origin}/_webcraft/edit/drafts/${draftPath(item)}`, {
		protocols: [DRAFTS_PROTOCOL, ...(token === null ? [] : [`${EDIT_TOKEN_PROTOCOL_PREFIX}${token}`])],
		origin: options.origin,
	});
}

/** Opens an item's Draft in an editor in the admin, signed in as `browser`'s person. */
export async function openDraft(
	install: TestInstall,
	browser: TestBrowser,
	siteId: string,
	item: DraftItem,
	options: { through?: (request: Request) => Promise<UpgradeAnswer> } = {},
): Promise<TestEditor> {
	return editorOver(() => upgradeDraft(install, browser, siteId, item, options));
}

/** Opens an item's Draft from a page in Edit mode. */
export async function openDraftInEditMode(edit: EditModeBrowser, item: DraftItem): Promise<TestEditor> {
	return editorOver(() => upgradeDraftInEditMode(edit, item));
}

/**
 * Opens an editor over any upgrade that answers it (an admin or Edit mode session's, or
 * `install.openDraftWithAccess`'s, for access no real session can give): the same client the admin
 * uses, so `change`, `saved`, `refusals` and the rest work exactly as they do for `openDraft`.
 */
export async function editorOver(upgrade: () => Promise<UpgradeAnswer>): Promise<TestEditor> {
	const messages: ServerMessage[] = [];
	const refusals: DraftRefused[] = [];
	let closedWith: { code: number; reason: string } | null = null;
	let link: { drop(): void } | null = null;
	let welcomed = 0;

	const client: DraftClient = createDraftClient({
		sendEveryMs: 0,
		onRefused: (refusal) => refusals.push(refusal),
	});

	const open = async () => {
		const answer = await upgrade();
		if (answer instanceof Response) {
			throw new Error(`The Draft didn't open: ${answer.status} ${await answer.text()}`);
		}
		closedWith = null;
		link = connect(answer, client, {
			heard: (data) => {
				if (typeof data !== "string") return;
				const message = JSON.parse(data) as ServerMessage;
				messages.push(message);
				if (message.type === "welcome") welcomed++;
			},
			closed: (code, reason) => {
				closedWith = { code, reason };
			},
		});
		const before = welcomed;
		await waitUntil(() => welcomed > before, "the server's welcome");
		await waitUntil(() => client.status() !== "connecting", "the first sync");
	};
	await open();

	const editor: TestEditor = {
		draft: () => client.draft(),
		change: (next) => client.change(next),
		place: (at) => client.place(at),
		status: () => client.status(),
		participants: () => client.participants(),
		messages,
		refusals,
		closedWith: () => closedWith,
		until: waitUntil,
		untilDraft: (check, what) => waitUntil(() => check(client.draft()), what),
		saved: () => waitUntil(() => client.status() === "saved", "every change saved"),
		disconnect() {
			link?.drop();
			link = null;
		},
		async reconnect() {
			await open();
		},
		close() {
			client.close();
			link = null;
		},
	};
	return editor;
}

/**
 * Joins an editor's client to the socket the handler accepted, in process, as a WebSocket would:
 * each side's frames reach the other a moment later, in order.
 */
function connect(
	answer: SocketUpgrade,
	client: DraftClient,
	watch: { heard(data: string | Uint8Array): void; closed(code: number, reason: string): void },
): { drop(): void } {
	let open = true;
	let session: SocketSession | null = null;
	const ends = client.connect({
		send: (data) => {
			if (!open) return;
			const copy = typeof data === "string" ? data : data.slice();
			queueMicrotask(() => {
				if (open) session?.receive(copy);
			});
		},
		close: () => {
			if (!open) return;
			open = false;
			session?.closed();
		},
	});
	session = answer.open({
		send: (data) => {
			if (!open) return;
			const copy = typeof data === "string" ? data : data.slice();
			queueMicrotask(() => {
				watch.heard(copy);
				ends.receive(copy);
			});
		},
		close: (code, reason) => {
			if (!open) return;
			open = false;
			queueMicrotask(() => {
				watch.closed(code, reason);
				ends.closed();
			});
		},
	});
	return {
		drop() {
			if (!open) return;
			open = false;
			session?.closed();
			ends.closed();
		},
	};
}

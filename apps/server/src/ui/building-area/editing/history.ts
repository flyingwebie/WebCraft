import type { Json } from "@webcraft/core/draft-document";

import { editorHistory, type HistoryLocation, type HistoryPort } from "../../builder/editor-history.ts";
import { historyWords } from "../../builder/history-words.ts";
import { matches } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import type { SavedAnswer, SaveWatch } from "../canvas/regions.ts";

/**
 * The building area's Undo history (ADR 0036, ADR 0037 › 1.5): the one `editorHistory()` of the tab,
 * covering every document and place the shell opens, since the shell is never left. Nothing is handed
 * over between pages any more (the old editors' `history/transfer`): a reload starts a new history.
 *
 * Each finished burst of typing in a region is one step: exactly the change its save made to the
 * item's shared Draft (the save's receipt), never the Draft as it reads later. A step is taken back
 * through that shared Draft, as the person, so the server's ordinary rules still decide whether it
 * may be: a step someone else's change made obsolete is skipped, with its reason.
 *
 * What the page in the frame adds (`setPage`): saving what was typed before the history moves, and
 * bringing a step's region into view. Later editing (BA-08 onwards: the tree, the Inspector, the code
 * panes) records its steps here too, through `record` and `register`.
 */
export type ShellHistory = {
	/** Takes back the person's last step, once what they were typing is a step itself. */
	undo(): Promise<void>;
	/** Makes the last step taken back again. */
	redo(): Promise<void>;
	/**
	 * Follows a region's save from the moment it is asked for (`regionSaving`'s `watch`): the step it
	 * makes keeps its place among the person's own, whichever save is answered first.
	 */
	watch(step: { label: string; field: string; title: string }): SaveWatch;
	/** How a Draft takes a step back: its open shared document (`drafts.ts`). Answers how to stop. */
	register(resource: string, port: HistoryPort): () => void;
	/**
	 * A key pressed in the page (through its agent) or in the shell: true when it was Undo or Redo and
	 * the history took it (the agent then stops the browser's own). Text that keeps the browser's own
	 * Undo (a body, a Loop item) and text being composed (an input method) are left alone.
	 */
	key(event: KeyboardEvent): boolean;
	/** The browser's own Undo of text (its menu, a gesture): the same step as the keys. True when taken. */
	beforeInput(event: InputEvent): boolean;
	/** What the page in the frame does for the history: save what was typed, show a step's place. */
	setPage(page: HistoryPage | null): void;
};

export type HistoryPage = {
	/** Saves what was typed and not saved yet. */
	settle(): Promise<void>;
	/** Brings a step's place into view, when it is on this page: true when it is. */
	reveal(location: HistoryLocation): boolean | Promise<boolean>;
};

/** Where Undo stays the browser's own: what the history doesn't hold (a body's Blocks, a Loop item's text). */
const OWN_UNDO = "[data-wc-type=body], [data-wc-item^='loop:'], [role=dialog], dialog";

/**
 * Own actions become steps in the order they were made, whichever save is answered first: each keeps
 * its place from the moment it is made, and is recorded once every earlier one is over.
 */
function inOrder() {
	const places: { records: (() => void)[]; over: boolean }[] = [];
	const waiting: (() => void)[] = [];
	const drain = () => {
		for (let first = places[0]; first?.over; first = places[0]) {
			places.shift();
			for (const record of first.records) record();
		}
		if (places.length === 0) for (const done of waiting.splice(0)) done();
	};
	return {
		reserve() {
			const place: (typeof places)[number] = { records: [], over: false };
			places.push(place);
			return {
				record(record: () => void) {
					place.records.push(record);
				},
				settle() {
					if (place.over) return;
					place.over = true;
					drain();
				},
			};
		},
		/** Resolves once no own action is on its way. */
		idle: () => (places.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))),
	};
}

export function shellHistory(options: {
	siteId: string;
	words: Words;
	announce(text: string, urgent?: boolean): void;
	/**
	 * A Draft the shell doesn't hold open now (a page left earlier): opened for the step alone (`drafts.ts`).
	 */
	fallback(resource: string): Promise<HistoryPort | undefined>;
}): ShellHistory & { destroy(): void } {
	const { siteId, words, announce } = options;
	const history = editorHistory();
	history.siteId = siteId;
	const said = words.editing.history;
	history.configure({
		// The shell words its labels where the action is made, in the person's Admin language.
		label: (message) => message,
		words: historyWords(
			(key, values) => fill((said as Record<string, string>)[key] ?? key, values),
			() => said.refused,
		),
	});
	// The shell never hands its history over: it is one tab's, from the shell's start to a reload.
	history.transport(options.fallback, () =>
		Promise.reject(new Error("The building area keeps its Undo history in the tab.")),
	);
	const order = inOrder();
	let page: HistoryPage | null = null;
	const stop = history.listen({
		announce: (message, refused) => announce(message, refused),
		reveal: (location) => page?.reveal(location) ?? false,
	});

	/** Everything the person started is saved and recorded before the history moves. */
	const settled = async () => {
		await page?.settle();
		await order.idle();
	};
	const undo = async () => {
		await settled();
		await history.undo();
	};
	const redo = async () => {
		await settled();
		await history.redo();
	};
	/** Whether Undo here is the history's: anywhere outside what keeps the browser's own. */
	const ours = (event: Event) =>
		!event
			.composedPath()
			.some((each) => typeof (each as Element).matches === "function" && (each as Element).matches(OWN_UNDO));

	return {
		undo,
		redo,
		watch(step) {
			const place = order.reserve();
			return {
				saved(answer: SavedAnswer) {
					const change = answer.history;
					if (!change) return;
					place.record(() => {
						history.record({
							resource: change.resource,
							before: change.before as Json,
							after: change.after as Json,
							label: fill(said.text, { name: step.label }),
							location: { siteId, draft: change.resource, panel: "page", ref: step.field, title: step.title },
						});
					});
				},
				settle: place.settle,
			};
		},
		register: (resource, port) => history.register(resource, port),
		key(event) {
			const redoing = matches(event, "editor.redo");
			if ((!redoing && !matches(event, "editor.undo")) || event.isComposing || !ours(event)) return false;
			void (redoing ? redo() : undo());
			return true;
		},
		beforeInput(event) {
			const name = event.inputType === "historyUndo" ? "undo" : event.inputType === "historyRedo" ? "redo" : null;
			if (!name || !ours(event)) return false;
			void (name === "undo" ? undo() : redo());
			return true;
		},
		setPage(next) {
			page = next;
		},
		destroy: stop,
	};
}

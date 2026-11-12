// The Undo history in Edit mode (ADR 0036): the module the editing bar loads on a Site's own domain,
// outside Code mode. It keeps the one history of this window (`editorHistory`, the same one Code mode
// and the Builder use, so a step made there can be taken back here after a page change) and records
// what the person does in Edit mode: text typed in place, Props and Page layout actions. A step is
// taken back through the page's own shared Draft, as the person, so the server's ordinary rules decide
// whether it still may be. The bar is one self-contained function that can't import anything, so this
// module hands itself over in an event once it has loaded.
import type { Json } from "@webcraft/core/draft-document";

import type {
	BarKit,
	EditHistory,
	HistoryButton,
	HistoryHost,
	HistoryPlace,
	HistoryTools,
} from "../../site/edit-bar/kit.ts";
import { historyCommandTarget } from "../builder/commands.ts";
import { editorAccessibility } from "../builder/editor-accessibility.ts";
import { editorHistory } from "../builder/editor-history.ts";
import { connectHistory } from "../builder/history-transport.ts";
import { historyWords } from "../builder/history-words.ts";
import { ariaKeys, matches, withKeys } from "../builder/shortcuts.ts";
import type { LayoutStep, PageLayoutController } from "../page-layouts/controller.ts";

/** A request the server refused, with its code, as the history reads it when it skips a step. */
class Refused extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

/** Where a key press keeps the browser's own undo: dialogs, and what the history doesn't hold. */
const OWN_UNDO = "[role=dialog], dialog, [data-wc-type=body], [data-wc-item^='loop:']";

/**
 * Own actions become steps in the order they were made, whichever save is acknowledged first: each
 * keeps its place from the moment it is made, and is recorded once every earlier one is over.
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
					place.over = true;
					drain();
				},
			};
		},
		/** Resolves once no own action is on its way. */
		idle: () => (places.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))),
	};
}

async function mount(kit: BarKit, host: HistoryHost): Promise<HistoryTools> {
	const history = editorHistory();
	const siteId = kit.state().site.id;
	const order = inOrder();
	let layout: PageLayoutController | undefined;
	history.configure({
		// Edit mode's labels are worded where the action is made, in the person's Admin language.
		label: (message) => message,
		// The bar words refusals for its own requests (publishing, saving); a step the server won't take
		// back is simply refused.
		words: historyWords(
			(key, values) => kit.word(`editorHistory.${key}`, values),
			() => kit.word("editorHistory.refused"),
		),
	});
	const resourceOf = (item: string) => `draft:${siteId}:${item}`;
	const title = () => kit.state().page.title || kit.state().page.path;

	history.listen({
		announce: (message, refused) => editorAccessibility(kit.doc).announce(message, refused ? "interrupt" : "polite"),
		async reveal(shown) {
			const item = shown.draft?.startsWith(`draft:${siteId}:`) ? shown.draft.slice(`draft:${siteId}:`.length) : null;
			if (!item || !kit.shared(item)) return false;
			// A typed value: its region comes into view. Focus stays where the person left it.
			if (shown.ref !== undefined) return host.reveal(item, shown.ref);
			if (!layout || item !== `entry:${layout.state().entryId}`) return false;
			// The page as the step left it, then the Placement it was about, selected (not a step itself).
			await layout.finish();
			if (shown.selection && layout.state().data.layout.placements.some((p) => p.id === shown.selection))
				layout.select(shown.selection);
			if (shown.panel === "tree") layout.openLayout(false);
			if (shown.panel === "inspector") layout.openProps(false);
			return true;
		},
	});

	/** Everything the person started is saved and recorded before the history moves or leaves. */
	const settled = async () => {
		await host.finish();
		await order.idle();
	};
	/**
	 * One step back or forward, once what the person was typing is a step itself (a refused input says
	 * so itself, and the history then moves from the last one accepted). Text typed in a Placement on
	 * the page is drawn again when its step moves: focus is put back in it, unless it went elsewhere.
	 */
	const step = async (move: () => Promise<void>) => {
		const active = kit.doc.activeElement;
		const typing = active instanceof HTMLElement && active.matches("[data-wc-placement-prop]") ? active.dataset : null;
		await settled();
		await move();
		if (!typing || !layout) return;
		await layout.finish();
		if (kit.doc.activeElement !== kit.doc.body) return;
		const placement = CSS.escape(typing.wcPlacement ?? "");
		const prop = CSS.escape(typing.wcPlacementProp ?? "");
		kit.doc.querySelector<HTMLElement>(`[data-wc-placement="${placement}"][data-wc-placement-prop="${prop}"]`)?.focus();
	};
	const shared = historyCommandTarget(history);
	const target: EditHistory = {
		...shared,
		undo: () => step(() => history.undo()),
		redo: () => step(() => history.redo()),
		canUndo: () => kit.editing() && shared.canUndo(),
		canRedo: () => kit.editing() && shared.canRedo(),
		subscribe: (listener) => history.subscribe(listener),
	};
	const button = (name: "undo" | "redo", step: string | null, enabled: boolean): HistoryButton => {
		const label = step ? kit.word(`editorHistory.${name}`, { label: step }) : kit.word(name);
		return { label, title: withKeys(label, `editor.${name}`), keys: ariaKeys(`editor.${name}`), enabled };
	};

	const recordLayout = (step: LayoutStep, controller: PageLayoutController) => {
		const resource = resourceOf(`entry:${controller.state().entryId}`);
		// The step's own change to the Draft's layout: its receipt, never the layout as it reads later.
		history.record({
			resource,
			before: { layout: step.before } as unknown as Json,
			after: { layout: step.after } as unknown as Json,
			label: step.label,
			location: {
				siteId,
				draft: resource,
				// The drawer the action was made in opens again; one made on the page itself opens none.
				panel: step.panel === "inspector" ? "inspector" : step.panel ? "tree" : "page",
				selection: step.selection,
				title: title(),
			},
		});
	};

	kit.win.addEventListener("keydown", (event) => {
		const redo = matches(event, "editor.redo");
		if ((!redo && !matches(event, "editor.undo")) || event.defaultPrevented || event.isComposing) return;
		if (!kit.editing() || event.composedPath().some((each) => each instanceof Element && each.matches(OWN_UNDO)))
			return;
		event.preventDefault();
		void (redo ? target.redo() : target.undo());
	});

	try {
		await connectHistory(
			siteId,
			async <T>(method: "transferHistory" | "claimHistory" | "reverseHistory", input: object) => {
				// The handoff is every Edit mode person's; CSS and scripts are taken back with Code mode's
				// own request, which only those who may change Structure are answered.
				const action = {
					transferHistory: "history/transfer",
					claimHistory: "history/claim",
					reverseHistory: "code/reverseHistory",
				};
				const answer = await kit.call(action[method], input);
				if (!answer.ok) throw new Refused(answer.code);
				return answer.data as T;
			},
			true,
		);
	} catch (error) {
		// A handoff that couldn't be claimed leaves this page's history empty; it works from here on.
		if (!(error instanceof Refused)) throw error;
		editorAccessibility(kit.doc).announce(kit.errorText(error.code), "interrupt");
	}

	return {
		target,
		buttons: () => ({
			undo: button("undo", shared.undoLabel?.() ?? null, target.canUndo()),
			redo: button("redo", shared.redoLabel?.() ?? null, target.canRedo()),
		}),
		reserve(): HistoryPlace {
			const place = order.reserve();
			return {
				record(change, label, shown) {
					place.record(() => {
						history.record({
							resource: change.resource,
							before: change.before,
							after: change.after,
							label,
							location: { siteId, draft: change.resource, panel: "page", ref: shown.field, title: title() },
						});
					});
				},
				settle: place.settle,
			};
		},
		opened(item) {
			history.register(resourceOf(item), {
				reverse: async (from, to) =>
					(await kit.shared(item)?.reverse(from, to)) ?? { ok: false, code: "HISTORY_UNAVAILABLE" },
			});
		},
		layout(controller) {
			layout = controller;
			// A step's place is kept from the moment its action is made; one finished outside any own
			// action (a move a peer's change ended) takes the next place.
			const open: ReturnType<typeof order.reserve>[] = [];
			controller.began(() => {
				const place = order.reserve();
				open.push(place);
				return () => {
					open.splice(open.indexOf(place), 1);
					place.settle();
				};
			});
			controller.finished((step) => {
				const place = open[0] ?? order.reserve();
				place.record(() => recordLayout(step, controller));
				if (!open.includes(place)) place.settle();
			});
		},
		async departure(url) {
			await settled();
			return history.departure(url);
		},
	};
}

document.dispatchEvent(new CustomEvent("webcraft:history-tools", { detail: { mount } }));

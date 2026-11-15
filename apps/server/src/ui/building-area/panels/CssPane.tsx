import { createDraftClient, type Json } from "@webcraft/core/draft-document";
import type { ElementNode, ElementTree } from "@webcraft/renderer/builder";
import { PaintbrushIcon, PlusIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { editorHistory, type HistoryResult } from "../../builder/editor-history.ts";
import { matches } from "../../builder/shortcuts.ts";
import { nodeAt, pathOfId, replaceAt } from "../../builder/tree.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { connect } from "../editing/drafts.ts";
import type { StructureSelection } from "../editing/selection.ts";
import { managementApi } from "../management.ts";
import { NoteLine } from "../places/styles/CodeBox.tsx";
import { QuickActions, useFavourites } from "../places/styles/QuickActions.tsx";
import { piecesOf, type RuleBreakpoint, ruleOf } from "../places/styles/rule.ts";
import type { QuickTokens, StepSizes } from "../places/styles/view.ts";
import { CodeWell } from "./CodeWell.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import { chooseClass, chosenClassOf, subscribeChosenClass } from "./chosen-class.ts";
import type { CodePanesDeps } from "./code-panes.tsx";
import { codeRequests } from "./code-requests.ts";
import { readOnlyReason } from "./HtmlPane.tsx";
import {
	FormatButton,
	type FormatSlot,
	formatSlot,
	formattedOnLeaving,
	type PaneSettings,
	useBoxFormat,
	useFormatSlot,
} from "./pane-parts.tsx";
import { type PaneStore, paneStore, usePane } from "./pane-store.ts";

/**
 * The CSS pane (BA-11; SPEC 5, `builder/02`, `03`, `10`): the selected element's Classes as chips in
 * its header (the chosen one raised: the Inspector's chosen chip, "CSS edits the chosen one"; × takes
 * a Class off the element, + adds one), and the chosen Class as one rule, `.name { … }`, with the quick
 * actions above it, as the Styles place edits a Class (BA-24's `rule.ts`, `QuickActions.tsx`).
 *
 * - What is typed saves to the Class's pieces in the Design system's Draft 0.8 s after typing stops
 *   (`designSystem.updateClass`): its styles, its own CSS (nested rules, any other `@media`) and each
 *   breakpoint's styles. Each save is one Undo step, taken back through the Design system's shared
 *   Draft; the page in the frame is drawn again with the Draft's stylesheet.
 * - A rule that isn't one block for the Class is marked on its line and not saved. Once another
 *   element (or Class) is shown, it is kept as typed, with its problem, for when the pane shows that
 *   Class again, in this document or another (BA-34).
 * - The media query action writes a breakpoint's block (`@media (width >= 768px)`, from that width up,
 *   as the Design system's breakpoints apply) or, "At this width", the rule at the frame's width now
 *   as the frames draw it: `@media (width < 768px)`.
 * - Only an element has a CSS pane (a Loop, a Condition, a Placement have none, SPEC 5).
 * - A **one-off style** (BA-33) styles this element only: its declarations are saved as Code mode saves
 *   an inline style (`code/editorMarkup` with the declarations, then `code/save`), which makes a
 *   generated Class of them, one Undo step; emptied, the generated Class leaves the element. A
 *   generated Class's chip says so; once its rule is changed it is a normal Class, and the pane offers
 *   to name it.
 */

/** How long after typing stops a rule is saved, in milliseconds (as the Styles place). */
const SAVE_AFTER_MS = 800;

type DesignClass = {
	id: string;
	name: string;
	styles: string;
	css: string;
	breakpoints: Record<string, string>;
	generated?: boolean;
};

/** A one-off style being typed: the element it is for (by its source and id), and its declarations. */
type OneOff = { ref: string; source: string; elementId: string; name: string; text: string; dirty: boolean };
type Design = {
	classes: readonly DesignClass[];
	breakpoints: readonly RuleBreakpoint[];
	tokens: QuickTokens;
	sizes: StepSizes;
};

export type CssState = {
	status: "idle" | "loading" | "ready" | "failed";
	/** The element it follows, and its source. */
	ref: string | null;
	source: string | null;
	editable: boolean;
	readOnlyReason: string | null;
	/** The element's Classes (its own, not token utilities), in its order, by id and name; generated ones say so. */
	classes: readonly { id: string; name: string; generated: boolean }[];
	/** The element's token utilities (BA-33): shown as chips that can be taken off, never edited. */
	utilities: readonly { id: string; name: string }[];
	/** Someone saved the chosen Class since its rule was shown: Reload theirs or Overwrite with mine. */
	conflict: boolean;
	/** The chosen Class. */
	classId: string | null;
	name: string;
	text: string;
	dirty: boolean;
	saving: boolean;
	/** Why the rule can't be read, and its line. */
	problem: { text: string; line: number } | null;
	failure: string | null;
	design: Design | null;
	/** The one-off style being typed (BA-33), until it is saved. */
	oneOff: OneOff | null;
	oneOffSaving: boolean;
	/** A generated Class made normal by a change of its rule: the pane offers to name it. */
	renaming: { classId: string; name: string } | null;
};

export type CssPane = {
	store: PaneStore<CssState>;
	siteId: string;
	announce(text: string): void;
	format: FormatSlot;
	change(text: string): void;
	choose(classId: string): void;
	/** Takes a Class off the element (one Undo step through its Template's or Component's Draft). */
	remove(classId: string): void;
	/** Adds a Class to the element: one of the Site's, or a new one by that name. Answers why not, or null. */
	add(name: string): Promise<string | null>;
	/** Starts a one-off style for the selected element. */
	openOneOff(): void;
	changeOneOff(text: string): void;
	/** Saves the one-off style being typed now (to the element it was typed for). */
	flushOneOff(): Promise<void>;
	/** A save conflict answered: their Class shown again, mine saved over it, or keep typing. */
	resolve(choice: "reload" | "overwrite" | "cancel"): void;
	/** Takes a token utility off the element (one Undo step). */
	removeUtility(id: string): void;
	/** Names a generated Class made normal; null keeps its name. Answers why not, or null. */
	rename(name: string | null): Promise<string | null>;
	flush(): Promise<void>;
	destroy(): void;
};

const IDLE: CssState = {
	status: "idle",
	ref: null,
	source: null,
	editable: false,
	readOnlyReason: null,
	classes: [],
	utilities: [],
	conflict: false,
	classId: null,
	name: "",
	text: "",
	dirty: false,
	saving: false,
	problem: null,
	failure: null,
	design: null,
	oneOff: null,
	oneOffSaving: false,
	renaming: null,
};

/** A selection's element, when it is one in an open source. */
function elementOf(selection: StructureSelection | null): ElementNode | null {
	return selection?.node?.type === "element" ? selection.node : null;
}

export function createCssPane(deps: () => CodePanesDeps): CssPane {
	const store = paneStore<CssState>(IDLE);
	const words = () => deps().words;
	const api = () => managementApi(deps().config.token);
	const siteId = () => deps().config.site.id;
	const resource = () => `draft:${siteId()}:designSystem`;
	const request = <T,>(action: string, body: unknown) => codeRequests(deps().config.token)<T>(action, body);
	/** After a one-off style is saved, its generated Class is chosen once the element shows it. */
	let chooseMade: { ref: string; before: string[] } | null = null;
	let oneOffTimer: number | undefined;
	let oneOffSaving: Promise<void> | null = null;
	let saveTimer: number | undefined;
	let reading: Promise<void> | null = null;
	let saving: Promise<void> | null = null;
	/** Rules typed and not saved (they couldn't be read) of Classes the pane no longer shows, by Class. */
	const kept = new Map<string, { text: string; problem: CssState["problem"] }>();

	/** Reads the Design system's Draft: its Classes, breakpoints and tokens, and the scales' sizes. */
	const read = async () => {
		reading ??= (async () => {
			try {
				const [got, preview] = await Promise.all([
					api().designSystem.get({ siteId: siteId() }),
					api()
						.designSystem.preview({ siteId: siteId() })
						.catch(() => null),
				]);
				const draft = got.designSystem.draft;
				const sizes: StepSizes = preview
					? Object.fromEntries(
							[...preview.preview.scales.space, ...preview.preview.scales.text].map((step) => [step.id, step.size]),
						)
					: (store.get().design?.sizes ?? {});
				store.set({ design: designOf(draft, sizes), status: "ready" });
			} catch {
				store.set({ status: "failed", failure: words().code.css.notRead });
			} finally {
				reading = null;
			}
		})();
		return reading;
	};

	const designOf = (draft: unknown, sizes: StepSizes): Design => {
		const shaped = draft as {
			classes: DesignClass[];
			tokens: QuickTokens & { breakpoints: { id: string; name: string; width: number }[] };
		};
		return {
			classes: shaped.classes,
			breakpoints: shaped.tokens.breakpoints.map(({ id, name, width }) => ({ id, name, width })),
			tokens: shaped.tokens,
			sizes,
		};
	};

	/** The chosen Class's rule as the Draft has it (what was typed is dropped). */
	const showRule = () => {
		const state = store.get();
		const found = state.design?.classes.find((each) => each.id === state.classId);
		shownClass = found ?? null;
		// The preview belongs to the element and Class it was typed for: another one takes it away.
		if (previewFor && (previewFor.ref !== state.ref || previewFor.classId !== state.classId)) previewCss(null);
		if (!found || !state.design) {
			store.set({ text: "", name: found?.name ?? state.name, dirty: false, problem: null });
			return;
		}
		// A rule typed for this Class and not saved is shown again as it was typed.
		const typed = state.classId ? kept.get(state.classId) : undefined;
		if (typed && state.classId) kept.delete(state.classId);
		store.set({
			name: found.name,
			text: typed?.text ?? ruleOf(found.name, found, state.design.breakpoints),
			dirty: typed !== undefined,
			problem: typed?.problem ?? null,
			failure: null,
		});
	};

	/** The chosen Class as its rule was shown: a save over a newer one asks first (BA-33). */
	let shownClass: DesignClass | null = null;
	/** Unsaved CSS shown on the page as it is typed (BA-33): a constructed stylesheet the page's policy allows. */
	let previewSheet: { page: Document; sheet: CSSStyleSheet } | null = null;
	/** The element and Class the preview shows, as typed: it stays while they are the ones shown. */
	let previewFor: { ref: string | null; classId: string | null } | null = null;
	const previewCss = (text: string | null) => {
		const page = deps().frame.current?.page() ?? null;
		previewFor = text === null ? null : { ref: store.get().ref, classId: store.get().classId };
		if (previewSheet && (previewSheet.page !== page || text === null)) {
			const { page: was, sheet } = previewSheet;
			was.adoptedStyleSheets = was.adoptedStyleSheets.filter((each) => each !== sheet);
			previewSheet = null;
		}
		const view = page?.defaultView as (Window & typeof globalThis) | null | undefined;
		if (!page || !view || text === null) return;
		if (!previewSheet) {
			const sheet = new view.CSSStyleSheet();
			page.adoptedStyleSheets = [...page.adoptedStyleSheets, sheet];
			previewSheet = { page, sheet };
		}
		try {
			previewSheet.sheet.replaceSync(text);
		} catch {
			// CSS that can't be read yet shows nothing new.
		}
	};
	const sameClass = (a: DesignClass | null | undefined, b: DesignClass | null | undefined) =>
		JSON.stringify([a?.name, a?.styles, a?.css, a?.breakpoints]) ===
		JSON.stringify([b?.name, b?.styles, b?.css, b?.breakpoints]);

	const follow = () => {
		const snapshot = deps().structure.snapshot();
		const selection = snapshot.selection;
		const element = elementOf(selection);
		if (!selection || !element) return;
		const source = snapshot.sources.get(selection.source);
		if (!source) return;
		// The Design system's Draft knows a Class made since the source was opened (a one-off style's).
		const known = new Map<string, { name: string; generated: boolean }>();
		for (const each of store.get().design?.classes ?? [])
			known.set(each.id, { name: each.name, generated: Boolean(each.generated) });
		for (const each of source.catalogue.classes)
			if (!known.has(each.id)) known.set(each.id, { name: each.name, generated: Boolean(each.generated) });
		const classes = element.classes.flatMap((id) => {
			const found = known.get(id);
			return found ? [{ id, ...found }] : [];
		});
		// A one-off style just saved: its generated Class is the one chosen once the element has it.
		const madeFor = chooseMade;
		if (madeFor && madeFor.ref === selection.ref) {
			const made = classes.find((each) => each.generated && !madeFor.before.includes(each.id));
			if (made) {
				chooseMade = null;
				chooseClass(selection.ref, made.id);
			}
		}
		// A one-off style typed for another element is saved to that element first.
		const pending = store.get().oneOff;
		if (pending && pending.ref !== selection.ref) {
			if (pending.dirty) void flushOneOff();
			else store.set({ oneOff: null });
		}
		const classId = chosenClassOf(
			selection.ref,
			classes.map((each) => each.id),
		);
		const state = store.get();
		const moved = state.ref !== selection.ref || state.classId !== classId;
		if (state.ref !== selection.ref && state.renaming) store.set({ renaming: null });
		if (moved && state.dirty) {
			// Saved first; a rule that can't be (its problem marked) is kept for when its Class shows again.
			if (!state.problem && !state.failure) {
				void flush().then(follow);
				return;
			}
			if (state.classId) kept.set(state.classId, { text: state.text, problem: state.problem });
			window.clearTimeout(saveTimer);
			store.set({ dirty: false });
		}
		const utilities = source.catalogue.utilities
			.filter((each) => element.classes.includes(each.id))
			.map(({ id, name }) => ({ id, name }));
		store.set({
			ref: selection.ref,
			source: source.ref,
			editable: source.editable,
			readOnlyReason: readOnlyReason(words(), source),
			classes,
			utilities,
			classId,
			...(moved ? { conflict: false } : {}),
		});
		if (moved) {
			if (!store.get().design) {
				store.set({ status: "loading" });
				void read().then(showRule);
			} else {
				showRule();
				// Someone may have changed the Class meanwhile (the Styles place, someone else): read again.
				void read().then(() => {
					if (!store.get().dirty) showRule();
				});
			}
		}
	};

	const save = async (overwrite = false) => {
		const state = store.get();
		const design = state.design;
		if (!state.dirty || !state.classId || !design || state.conflict) return;
		// The pane places its CSS in the Class's cascade layer itself.
		const layer = state.text.split("\n").findIndex((line) => /@layer\b/.test(line));
		if (layer >= 0) {
			store.set({ problem: { text: words().cssPane.noLayer, line: layer + 1 } });
			deps().announce(words().cssPane.noLayer, true);
			return;
		}
		const pieces = piecesOf(state.text, state.name, design.breakpoints);
		if (!pieces.ok) {
			const said = words().styles.classes.problems;
			store.set({
				problem: {
					text: fill(said[pieces.problem], { name: state.name, line: String(pieces.line) }),
					line: pieces.line,
				},
			});
			return;
		}
		store.set({ saving: true, problem: null });
		// Someone saved this Class since its rule was shown: theirs or mine, never silently over theirs.
		if (!overwrite && shownClass) {
			try {
				const fresh = await api().designSystem.get({ siteId: siteId() });
				const now = (fresh.designSystem.draft.classes as DesignClass[]).find((each) => each.id === state.classId);
				if (now && !sameClass(now, shownClass)) {
					store.set({ saving: false, conflict: true, design: designOf(fresh.designSystem.draft, design.sizes) });
					deps().announce(fill(words().code.conflict.text, { name: `.${state.name}` }), true);
					return;
				}
			} catch {
				// Unread, the save goes ahead and the server still checks it.
			}
		}
		const wasGenerated = Boolean(design.classes.find((each) => each.id === state.classId)?.generated);
		try {
			const saved = await api().designSystem.updateClass({
				siteId: siteId(),
				classId: state.classId,
				styles: pieces.pieces.styles,
				css: pieces.pieces.css,
				breakpoints: pieces.pieces.breakpoints,
			});
			const label = fill(words().code.css.step, { name: state.name });
			editorHistory().record({
				resource: resource(),
				before: saved.history.before as unknown as Json,
				after: saved.history.after as unknown as Json,
				label,
				location: { siteId: siteId(), panel: "css", ref: state.ref ?? undefined, title: label },
			});
			const typedSince = store.get().text !== state.text;
			const nextDesign = designOf(saved.designSystem.draft, design.sizes);
			store.set({ design: nextDesign, dirty: typedSince, failure: null });
			shownClass = nextDesign.classes.find((each) => each.id === state.classId) ?? null;
			// A generated Class whose rule changed is a normal one now: the pane offers to name it.
			const now = nextDesign.classes.find((each) => each.id === state.classId);
			if (wasGenerated && now && !now.generated) store.set({ renaming: { classId: now.id, name: now.name } });
			follow();
			await deps().frame.current?.rerender();
		} catch (error) {
			const code = (error as { code?: string }).code ?? "generic";
			const message = (error as { message?: string }).message ?? "";
			store.set({
				failure: fill(words().code.notSaved, { reason: code === "DESIGN_SYSTEM_INVALID" ? message : code }),
			});
			deps().announce(fill(words().code.notSaved, { reason: code }), true);
		} finally {
			store.set({ saving: false });
		}
	};

	const flush = async () => {
		window.clearTimeout(saveTimer);
		if (saving) await saving;
		saving = save();
		try {
			await saving;
		} finally {
			saving = null;
		}
	};

	/** Changes the selected element's Classes through its source's Draft (one Undo step). Answers why not, or null. */
	const changeClasses = (classes: string[], label: string): string | null => {
		const snapshot = deps().structure.snapshot();
		const selection = snapshot.selection;
		const element = elementOf(selection);
		const source = selection ? snapshot.sources.get(selection.source) : undefined;
		if (!selection?.path || !element || !source) return words().structure.connecting;
		return deps().structure.change(source.ref, replaceAt(source.tree, selection.path, { ...element, classes }), label);
	};

	/** The element a one-off style was typed for, now: its source, path and node (a peer may have moved it). */
	const oneOffElement = (pending: OneOff) => {
		const source = deps().structure.snapshot().sources.get(pending.source);
		const at = source ? pathOfId(source.tree, pending.elementId) : undefined;
		const node = source && at ? nodeAt(source.tree, at) : undefined;
		return source && at && node?.type === "element" ? { source, at, node } : null;
	};
	/** The generated Classes the Site has, by id (the Design system's Draft, and the source's catalogue). */
	const generatedIds = (catalogue: readonly { id: string; generated?: boolean }[]) =>
		new Set(
			[...(store.get().design?.classes ?? []), ...catalogue].filter((each) => each.generated).map((each) => each.id),
		);

	const saveOneOff = async (attempt = 0): Promise<void> => {
		const pending = store.get().oneOff;
		if (!pending?.dirty) return;
		const said = words().oneOff;
		const found = oneOffElement(pending);
		const path = deps().path();
		if (!found || !path) {
			store.set({ oneOff: null });
			deps().announce(fill(said.notSaved, { reason: words().structure.connecting }), true);
			return;
		}
		const { source, at, node } = found;
		const declarations = pending.text.trim();
		const generated = generatedIds(source.catalogue.classes);
		const kept = node.classes.filter((id) => !generated.has(id));
		store.set({ oneOffSaving: true });
		try {
			if (!declarations) {
				// Emptied: the generated Class leaves the element (the tree as it is now: a peer's change stays).
				if (kept.length !== node.classes.length) {
					const refused = deps().structure.change(
						source.ref,
						replaceAt(source.tree, at, { ...node, classes: kept }),
						said.removed,
					);
					if (refused) deps().announce(refused, true);
				}
				if (store.get().oneOff?.text === pending.text) store.set({ oneOff: null });
				return;
			}
			// Printed from the Draft as the server has it now (a peer's change may not have reached this tab
			// yet), the element's declarations in place of its generated Class, and saved on that version.
			const fresh = await request<{ opened: { tree: ElementTree; version: string | null; props: unknown } }>(
				"code/editor",
				{ path, ref: source.ref },
			);
			const freshTree = fresh.ok ? fresh.data.opened.tree : source.tree;
			const freshAt = pathOfId(freshTree, pending.elementId);
			const freshNode = freshAt ? nodeAt(freshTree, freshAt) : undefined;
			if (!freshAt || freshNode?.type !== "element") {
				store.set({ oneOff: null });
				deps().announce(fill(said.notSaved, { reason: words().structure.connecting }), true);
				return;
			}
			const tree = replaceAt(freshTree, freshAt, {
				...freshNode,
				classes: freshNode.classes.filter((id) => !generated.has(id)),
			});
			const props = fresh.ok ? fresh.data.opened.props : source.props;
			const printed = await request<{ markup: string }>("code/editorMarkup", {
				path,
				ref: source.ref,
				draft: { tree, styles: { [pending.elementId]: declarations }, ...(props ? { props } : {}) },
			});
			const answer = printed.ok
				? await request<{ history: { resource: string; before: Json; after: Json }[] }>("code/save", {
						path,
						ref: source.ref,
						markup: printed.data.markup,
						version: fresh.ok ? fresh.data.opened.version : null,
					})
				: null;
			if (!answer?.ok) {
				const code = answer && !answer.ok ? answer.code : !printed.ok ? printed.code : "generic";
				// Someone saved it between the reading and the save: printed again from their version, once.
				if (code === "CHANGED_MEANWHILE" && attempt === 0) {
					await new Promise((resolve) => setTimeout(resolve, 300));
					return saveOneOff(1);
				}
				deps().announce(fill(said.notSaved, { reason: code }), true);
				return;
			}
			const [first, ...rest] = answer.data.history;
			if (first) {
				const step = editorHistory().record({
					...first,
					label: said.applied,
					location: { siteId: siteId(), panel: "css", ref: pending.ref, title: said.applied },
				});
				for (const change of rest) editorHistory().attach(step, change);
			}
			chooseMade = { ref: pending.ref, before: [...node.classes] };
			if (store.get().oneOff?.text === pending.text) store.set({ oneOff: null });
			deps().announce(said.applied);
			await read();
			follow();
			await deps().frame.current?.rerender();
		} finally {
			store.set({ oneOffSaving: false });
		}
	};
	const flushOneOff = async () => {
		window.clearTimeout(oneOffTimer);
		if (oneOffSaving) await oneOffSaving;
		oneOffSaving = saveOneOff();
		try {
			await oneOffSaving;
		} finally {
			oneOffSaving = null;
		}
	};

	// A step of the Design system taken back (or made again) through its shared Draft, as the person.
	const unregister = deps().history.register(resource(), {
		reverse: async (from, to): Promise<HistoryResult> => {
			const url = new URL("/_webcraft/edit/drafts/designSystem", window.location.href);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			const client = createDraftClient();
			const stop = connect(client, url, deps().config.token);
			try {
				const result = await client.reverse(from, to);
				if (result.ok) {
					void read().then(() => {
						if (!store.get().dirty) showRule();
					});
					void deps().frame.current?.rerender();
				}
				return result;
			} finally {
				client.close();
				stop();
			}
		},
	});

	const unsubscribe = deps().structure.subscribe(follow);
	// The Inspector may choose another Class.
	const chosenUnsubscribe = subscribeChosenClass(follow);
	follow();

	return {
		store,
		siteId: siteId(),
		announce: (text) => deps().announce(text),
		format: formatSlot(),
		change(text) {
			const state = store.get();
			if (!state.editable || !state.classId) return;
			store.set({ text, dirty: true, failure: null, problem: null });
			previewCss(text);
			window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
		},
		choose(classId) {
			const ref = store.get().ref;
			if (ref) chooseClass(ref, classId);
		},
		remove(classId) {
			const state = store.get();
			const named = state.classes.find((each) => each.id === classId)?.name ?? "";
			const element = elementOf(deps().structure.snapshot().selection);
			// Token utilities stay where they are.
			const all = (element?.classes ?? []).filter((id) => id !== classId);
			const refused = changeClasses(
				all,
				fill(words().structure.steps.removeClass, { className: named, name: element?.label ?? element?.tag ?? "" }),
			);
			if (refused) deps().announce(refused, true);
		},
		async add(typed) {
			const wanted = typed.trim().replace(/^\./, "");
			if (!wanted) return null;
			const snapshot = deps().structure.snapshot();
			const selection = snapshot.selection;
			const element = elementOf(selection);
			const source = selection ? snapshot.sources.get(selection.source) : undefined;
			if (!element || !source || !selection) return words().structure.connecting;
			let id = source.catalogue.classes.find((each) => each.name === wanted)?.id;
			if (!id) {
				const made = await deps().structure.createClass(wanted);
				if ("refused" in made) return made.refused;
				id = made.id;
				// The new Class is the Design system's now: read again, so its chip has its name.
				await read();
			}
			if (element.classes.includes(id)) {
				chooseClass(selection.ref, id);
				return null;
			}
			const refused = changeClasses(
				[...element.classes, id],
				fill(words().structure.steps.addClass, { className: wanted, name: element.label ?? element.tag }),
			);
			if (!refused) chooseClass(selection.ref, id);
			return refused;
		},
		openOneOff() {
			const selection = deps().structure.snapshot().selection;
			const element = elementOf(selection);
			if (!selection || !element || !store.get().editable) return;
			store.set({
				oneOff: {
					ref: selection.ref,
					source: selection.source,
					elementId: element.id,
					name: element.label ?? element.tag,
					text: "",
					dirty: false,
				},
			});
		},
		changeOneOff(text) {
			const pending = store.get().oneOff;
			if (!pending) return;
			store.set({ oneOff: { ...pending, text, dirty: true } });
			window.clearTimeout(oneOffTimer);
			oneOffTimer = window.setTimeout(() => void flushOneOff(), SAVE_AFTER_MS);
		},
		flushOneOff,
		resolve(choice) {
			store.set({ conflict: false });
			if (choice === "overwrite") void save(true);
			else if (choice === "reload") {
				store.set({ dirty: false });
				previewCss(null);
				showRule();
				void deps().frame.current?.rerender();
			}
		},
		removeUtility(id) {
			const state = store.get();
			const named = state.utilities.find((each) => each.id === id)?.name ?? "";
			const element = elementOf(deps().structure.snapshot().selection);
			const refused = changeClasses(
				(element?.classes ?? []).filter((each) => each !== id),
				fill(words().structure.steps.removeClass, { className: named, name: element?.label ?? element?.tag ?? "" }),
			);
			if (refused) deps().announce(refused, true);
		},
		async rename(name) {
			const renaming = store.get().renaming;
			if (!renaming) return null;
			const wanted = name?.trim().replace(/^\./, "") ?? "";
			if (!wanted || wanted === renaming.name) {
				store.set({ renaming: null });
				return null;
			}
			try {
				const saved = await api().designSystem.updateClass({
					siteId: siteId(),
					classId: renaming.classId,
					name: wanted,
				});
				const label = fill(words().oneOff.renameStep, { from: renaming.name, name: wanted });
				editorHistory().record({
					resource: resource(),
					before: saved.history.before as unknown as Json,
					after: saved.history.after as unknown as Json,
					label,
					location: { siteId: siteId(), panel: "css", ref: store.get().ref ?? undefined, title: label },
				});
				store.set({ renaming: null, design: designOf(saved.designSystem.draft, store.get().design?.sizes ?? {}) });
				follow();
				showRule();
				deps().announce(fill(words().oneOff.renamed, { name: wanted }));
				void deps().frame.current?.rerender();
				return null;
			} catch (error) {
				const problems = (error as { data?: { problems?: { message: string }[] } }).data?.problems;
				return problems?.length
					? problems.map((each) => each.message).join(" ")
					: fill(words().code.notSaved, { reason: (error as { code?: string }).code ?? "generic" });
			}
		},
		flush: async () => {
			await flushOneOff();
			await flush();
		},
		destroy() {
			window.clearTimeout(saveTimer);
			window.clearTimeout(oneOffTimer);
			unsubscribe();
			chosenUnsubscribe();
			unregister();
		},
	};
}

/** The CSS pane's header controls: the element's Classes as chips (the chosen one raised), + Class, Format. */
export function CssActions({ pane, words }: { pane: CssPane; words: Words }) {
	const state = usePane(pane.store);
	const said = words.structure.inspector;
	const [adding, setAdding] = useState(false);
	const [typed, setTyped] = useState("");
	const [refusal, setRefusal] = useState<string | null>(null);
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (adding) field.current?.focus();
	}, [adding]);
	// An unfinished + form belongs to the element it was opened on: another selection closes it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: closed whenever the element changes.
	useEffect(() => {
		setAdding(false);
		setTyped("");
		setRefusal(null);
	}, [state.ref]);
	/** The arrows, Home and End move between the chips (BA-33), as they moved between Code mode's tabs. */
	const onChipKeys = (event: KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		const chips = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
		const at = chips.indexOf(document.activeElement as HTMLButtonElement);
		if (at < 0 || chips.length === 0) return;
		event.preventDefault();
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const forward = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? chips.length - 1
					: (at + (forward ? 1 : -1) + chips.length) % chips.length;
		chips[next]?.focus();
		chips[next]?.click();
	};
	const submit = async () => {
		const refused = await pane.add(typed);
		setRefusal(refused);
		if (!refused) {
			setAdding(false);
			setTyped("");
		}
	};
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: the chips' own keys (arrows, Home, End), as a toolbar. */}
			<div
				className="flex min-w-0 grow-[6] basis-0 items-center gap-1.5 overflow-x-auto py-px"
				data-wc-css-classes=""
				onKeyDown={onChipKeys}
			>
				{state.classes.map((each) => {
					const on = state.classId === each.id;
					return (
						<span
							key={each.id}
							className={`inline-flex h-[26px] max-w-40 shrink-0 items-center rounded-[4px] border font-mono text-[11px] ${
								on ? "text-chrome-strong border-[#6366f1] bg-[#6366f1]/20" : "border-chrome-line text-chrome-text"
							}`}
							data-wc-css-class={each.name}
						>
							<button
								type="button"
								aria-pressed={on}
								aria-label={fill(each.generated ? words.oneOff.chooseGenerated : said.chooseClass, { name: each.name })}
								onClick={() => pane.choose(each.id)}
								className={`h-full truncate rounded-s-[4px] ps-1.5 pe-1 ${FOCUS_RING}`}
							>
								.{each.name}
								{each.generated ? (
									<span className="text-chrome-muted ms-1 font-sans" data-wc-css-generated="">
										{words.oneOff.generated}
									</span>
								) : null}
							</button>
							<button
								type="button"
								disabled={!state.editable}
								aria-label={fill(said.removeClass, { name: each.name })}
								onClick={() => pane.remove(each.id)}
								className={`text-chrome-muted hover:text-chrome-strong grid h-full w-6 place-items-center rounded-e-[4px] disabled:hidden ${FOCUS_RING}`}
							>
								<XIcon aria-hidden="true" className="size-3" />
							</button>
						</span>
					);
				})}
				{adding ? (
					<input
						ref={field}
						value={typed}
						aria-label={said.addClassLabel}
						aria-invalid={refusal ? true : undefined}
						placeholder={said.classPlaceholder}
						onChange={(event) => {
							setTyped(event.target.value);
							setRefusal(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								void submit();
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								setAdding(false);
								setTyped("");
							}
						}}
						onBlur={() => {
							if (!typed.trim()) setAdding(false);
						}}
						title={refusal ?? undefined}
						className={`bg-chrome-raised text-chrome-strong placeholder:text-chrome-muted h-6 w-36 rounded-[4px] border-0 px-1.5 font-mono text-[11px] ${FOCUS_RING}`}
						data-wc-css-new-class=""
					/>
				) : state.editable ? (
					<span className="group relative inline-flex">
						<button
							type="button"
							aria-label={said.addClassLabel}
							onClick={() => setAdding(true)}
							className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-6 place-items-center rounded-[5px] ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-css-add-class=""
						>
							<PlusIcon aria-hidden="true" className="size-3.5" />
						</button>
						<Tip label={said.addClassLabel} side="bottom" />
					</span>
				) : null}
				{state.utilities.length > 0 ? (
					<ul
						aria-label={words.cssPane.utilities}
						className="m-0 flex list-none items-center gap-1 p-0"
						data-wc-css-utilities=""
					>
						{state.utilities.map((each) => (
							<li
								key={each.id}
								className="border-chrome-line text-chrome-muted inline-flex h-[26px] items-center rounded-[4px] border border-dashed ps-1.5 font-mono text-[11px]"
								title={fill(words.cssPane.utility, { name: each.name })}
							>
								{each.name}
								<button
									type="button"
									disabled={!state.editable}
									aria-label={fill(words.cssPane.removeUtility, { name: each.name })}
									onClick={() => pane.removeUtility(each.id)}
									className={`hover:text-chrome-strong grid h-full w-6 place-items-center rounded-e-[4px] disabled:hidden ${FOCUS_RING}`}
								>
									<XIcon aria-hidden="true" className="size-3" />
								</button>
							</li>
						))}
					</ul>
				) : null}
				{state.editable && !adding && !state.oneOff && !state.classes.some((each) => each.generated) ? (
					<span className="group relative inline-flex">
						<button
							type="button"
							aria-label={words.oneOff.addLabel}
							onClick={() => pane.openOneOff()}
							className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-6 place-items-center rounded-[5px] ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-css-one-off=""
						>
							<PaintbrushIcon aria-hidden="true" className="size-3.5" />
						</button>
						<Tip label={words.oneOff.add} side="bottom" />
					</span>
				) : null}
			</div>
			<FormatButton slot={pane.format} words={words} />
		</>
	);
}

/** The CSS pane's body: the quick actions, the chosen Class's rule, its line. */
export function CssBody({ pane, words, settings }: { pane: CssPane; words: Words; settings: PaneSettings }) {
	const state = usePane(pane.store);
	const area = useRef<HTMLTextAreaElement>(null);
	const noteId = useId();
	const editable = state.editable && state.status === "ready" && state.classId !== null;
	const formatting = useBoxFormat("css", area, state.text, editable);
	useFormatSlot(pane.format, formatting, editable);
	const [favourites, toggleFavourite] = useFavourites(pane.siteId);
	const read = state.design ? piecesOf(state.text, state.name, state.design.breakpoints) : null;
	const shown = words.code.css;

	if (state.status === "idle" || state.status === "loading")
		return (
			<p className="text-chrome-muted m-0 p-3 text-[12px]" role="status">
				{shown.loading}
			</p>
		);
	if (state.oneOff && state.oneOff.ref === state.ref)
		return (
			<OneOffBox pane={pane} words={words} settings={settings} oneOff={state.oneOff} saving={state.oneOffSaving} />
		);
	if (state.classes.length === 0 || !state.classId)
		return (
			<p className="text-chrome-muted m-0 p-3 text-[12px]" data-wc-css-pane="none">
				{state.status === "failed" ? state.failure : shown.noClass}
			</p>
		);
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (formatting.onKeyDown(event)) return;
		// ⌘S / Ctrl+S saves at once (BA-32), as in the HTML and JS panes: never the browser's Save page.
		if (
			matches(event.nativeEvent, "editor.save") ||
			((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s")
		) {
			event.preventDefault();
			void pane.flush();
		}
	};
	return (
		<div className="flex min-h-0 grow flex-col gap-1.5 pt-1.5" data-wc-css-pane="ready">
			{state.renaming ? <RenamePrompt pane={pane} words={words} name={state.renaming.name} /> : null}
			{state.conflict ? (
				<ConflictDialog
					words={words}
					text={fill(words.code.conflict.text, { name: `.${state.name}` })}
					onChoose={(choice) => pane.resolve(choice)}
				/>
			) : null}
			{editable && /display:\s*grid\b/.test(state.text) ? (
				<label className="text-chrome-muted flex items-center gap-1.5 px-2 text-[11px]">
					{words.cssPane.columns}
					<input
						type="number"
						min={1}
						max={24}
						value={/grid-template-columns:\s*repeat\((\d+),\s*1fr\)/.exec(state.text)?.[1] ?? ""}
						onChange={(event) => {
							const count = Number.parseInt(event.target.value, 10);
							if (count >= 1 && count <= 24) pane.change(withColumns(state.text, count));
						}}
						className={`bg-chrome-raised text-chrome-strong h-6 w-14 rounded-[4px] px-1.5 text-[12px] ${FOCUS_RING}`}
						data-wc-css-columns=""
					/>
				</label>
			) : null}
			{state.design ? (
				<div className="flex min-w-0 items-center overflow-x-auto px-1.5">
					<QuickActions
						words={words}
						text={state.text}
						readable={editable && Boolean(read?.ok)}
						onEdit={(edit) => {
							pane.change(edit.text);
							requestAnimationFrame(() => {
								area.current?.focus();
								area.current?.setSelectionRange(edit.caret, edit.caret);
							});
						}}
						tokens={state.design.tokens}
						sizes={state.design.sizes}
						breakpoints={state.design.breakpoints}
						canvasWidth={frameWidth}
						favourites={favourites}
						toggleFavourite={toggleFavourite}
						announce={(text) => pane.announce(text)}
						atWidth={(width) => `(width < ${width}px)`}
					/>
				</div>
			) : null}
			<CodeWell
				ref={area}
				language="css"
				value={state.text}
				onChange={(text) => pane.change(text)}
				onKeyDown={onKeyDown}
				onBlur={() => {
					if (!pane.store.get().dirty) return;
					void (async () => {
						const tidied =
							settings.formatOnLeave && editable ? await formattedOnLeaving(pane.store.get().text, "css") : null;
						if (tidied) pane.change(tidied);
						await pane.flush();
					})();
				}}
				label={fill(shown.label, { name: state.name })}
				describedBy={noteId}
				problems={
					formatting.problemLine
						? [formatting.problemLine]
						: state.problem
							? [state.problem.line]
							: read && !read.ok
								? [read.line]
								: []
				}
				readOnly={!editable}
				wrap={settings.wrap}
				data={{ "data-wc-code-box": "css", "data-wc-class-rule": state.name }}
			/>
			<NoteLine
				id={noteId}
				format={formatting}
				words={words}
				problem={state.problem ?? (state.failure ? { text: state.failure } : null)}
				help={state.readOnlyReason ?? (state.saving ? words.code.saving : shown.help)}
			/>
		</div>
	);
}

/** The one-off style's box (BA-33): declarations for the selected element only, saved as a generated Class. */
function OneOffBox({
	pane,
	words,
	settings,
	oneOff,
	saving,
}: {
	pane: CssPane;
	words: Words;
	settings: PaneSettings;
	oneOff: { name: string; text: string };
	saving: boolean;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	const noteId = useId();
	useEffect(() => {
		area.current?.focus();
	}, []);
	return (
		<div className="flex min-h-0 grow flex-col gap-1.5 pt-1.5" data-wc-css-pane="one-off">
			<CodeWell
				ref={area}
				language="css"
				value={oneOff.text}
				onChange={(text) => pane.changeOneOff(text)}
				onBlur={() => void pane.flushOneOff()}
				label={fill(words.oneOff.box, { name: oneOff.name })}
				describedBy={noteId}
				problems={[]}
				readOnly={false}
				wrap={settings.wrap}
				data={{ "data-wc-code-box": "one-off" }}
			/>
			<p id={noteId} className="text-chrome-muted m-0 px-2 pb-1.5 text-[12px]">
				{saving ? words.code.saving : words.oneOff.help}
			</p>
		</div>
	);
}

/** Offers to name a generated Class its rule's change made normal (BA-33): the name, Rename or keep it. */
function RenamePrompt({ pane, words, name }: { pane: CssPane; words: Words; name: string }) {
	const said = words.oneOff;
	const [typed, setTyped] = useState(name);
	const [refusal, setRefusal] = useState<string | null>(null);
	const field = useRef<HTMLInputElement>(null);
	const id = useId();
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const submit = async () => setRefusal(await pane.rename(typed));
	return (
		<form
			className="bg-chrome-raised mx-1.5 flex flex-col gap-1.5 rounded-md px-2 py-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
			aria-labelledby={`${id}-title`}
			data-wc-css-rename=""
		>
			<p id={`${id}-title`} className="text-chrome-strong m-0 text-[12px] font-semibold">
				{fill(said.renameTitle, { name })}
			</p>
			<p className="text-chrome-muted m-0 text-[12px]">{said.renameHelp}</p>
			<div className="flex items-center gap-1.5">
				<label htmlFor={`${id}-name`} className="text-chrome-muted text-[11px]">
					{said.name}
				</label>
				<input
					ref={field}
					id={`${id}-name`}
					value={typed}
					onChange={(event) => {
						setTyped(event.target.value);
						setRefusal(null);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							event.stopPropagation();
							void pane.rename(null);
						}
					}}
					aria-invalid={refusal ? true : undefined}
					spellCheck={false}
					autoComplete="off"
					className={`bg-chrome-well text-chrome-strong h-6 min-w-0 grow rounded-[4px] px-1.5 font-mono text-[12px] ${FOCUS_RING}`}
				/>
				<button
					type="submit"
					className={`h-6 shrink-0 rounded-[4px] bg-[#4f46e5] px-2 text-[11px] font-semibold text-white hover:bg-[#4338ca] ${FOCUS_RING}`}
				>
					{said.rename}
				</button>
				<button
					type="button"
					onClick={() => void pane.rename(null)}
					className={`text-chrome-text hover:bg-chrome-hover h-6 shrink-0 rounded-[4px] px-2 text-[11px] ${FOCUS_RING}`}
				>
					{said.keep}
				</button>
			</div>
			{refusal ? (
				<p role="alert" className="text-chrome-danger m-0 text-[12px]">
					{refusal}
				</p>
			) : null}
		</form>
	);
}

/** A rule with its grid's columns set to `count` equal ones (`repeat(n, 1fr)`), after its `display: grid`. */
export function withColumns(text: string, count: number): string {
	const declaration = `grid-template-columns: repeat(${count}, 1fr);`;
	if (/grid-template-columns:[^;]*;?/.test(text)) return text.replace(/grid-template-columns:[^;]*;?/, declaration);
	return text.replace(
		/^([ \t]*)display:\s*grid;?/m,
		(whole, indent: string) => `${whole.endsWith(";") ? whole : `${whole};`}\n${indent}${declaration}`,
	);
}

/** The width of the page in the frame now (the media query action's "At this width"). */
function frameWidth(): number | null {
	const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
	const width = frame?.contentWindow?.innerWidth;
	return width ? Math.round(width) : null;
}

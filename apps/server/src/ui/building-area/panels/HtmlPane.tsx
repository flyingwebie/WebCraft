import { type Json, sameValue } from "@webcraft/core/draft-document";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { format } from "../../code-format/format.ts";
import { matches } from "../../editor/shortcuts.ts";
import { nodeAt } from "../../editor/tree.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { keyOf, type StructureSelection, type StructureSource } from "../editing/selection.ts";
import { managementApi } from "../management.ts";
import { NoteLine } from "../places/styles/CodeBox.tsx";
import { CodeWell, type LineRange } from "./CodeWell.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import type { CodePanesDeps } from "./code-panes.tsx";
import { type CodeRequests, lineAt, type MarkupProblem, offsetAt, problemsOf } from "./code-requests.ts";
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
import {
	applySuggestion,
	type MarkupSuggestions,
	markupSuggestions,
	type SuggestContext,
	suggestionCount,
} from "./suggest.ts";

/**
 * The HTML pane (BA-11; SPEC 5, `builder/02`, `05`, `07`, `10`): the Template markup of the selection's
 * source (its Template or Component, as its shared Draft holds it now), the selection's own lines
 * marked, as Code mode's HTML panel had it (ADR 0016, 0017).
 *
 * - **Reading**: the source's tree is printed as markup by the server (`code/editorMarkup`), from the
 *   shell's open shared Draft (BA-08's `structure()`), so the pane always shows what the Draft holds;
 *   `code/editorRead` says where each element is in it, which marks the selection's lines.
 * - **Typing** previews: 350 ms after typing stops, the server renders the page with this markup in
 *   place of its source's Draft (`code/preview`, nothing saved) and the frame shows it in place. Markup
 *   that can't be read lists each problem with its line and column instead.
 * - **Saving** (on leaving the box, or ⌘S / Ctrl+S; there is no Save button, SPEC D3): the markup is
 *   read into its tree (`code/editorRead`) and changed through the shared Draft, one Undo step, the
 *   page drawn again in place (`structure.change`). Inline styles and a Component's Props block go
 *   through Code mode's own save (`code/save`), which makes Classes and Props of them. A save over a
 *   Draft someone changed since the markup was read asks first: Reload theirs or Overwrite with mine.
 * - A Module's Component, or a Template not made yet, is read only, with the reason.
 * - A Placement of a Page's Page layout is shown as the markup of its Component tag (read only here;
 *   its Props are the Inspector's).
 * - **Another document** (BA-34): markup typed and not saved (it couldn't be read, say), or a conflict
 *   waiting for its choice, is kept by its source's Template or Component when the frame shows another
 *   page, and shown again (previewed, the conflict asked again) once a page shows that source again.
 * - **The selected element only** (FX-02): with an element (a Placement, a Loop, a Condition) of the
 *   source selected, the box holds that element's own markup, formatted, cut from the source's markup
 *   by the parser's locations (`code/editorRead`), with a breadcrumb of its ancestors above it. Every
 *   preview and save puts what was typed back in its place in the source's markup and goes on as for
 *   the whole source (the same checks and refusals, one Undo step); problems are said at their line in
 *   the box. With the source itself selected the box holds the whole source, as before.
 */

/** A source's name as the panes say it: the Component's, or the Template's kind (and Post Type). */
export function sourceName(words: Words, source: StructureSource): string {
	const said = words.structure;
	switch (source.target.kind) {
		case "component":
			return source.name ?? said.thisSource;
		case "siteTemplate":
			return said.siteTemplate;
		case "searchTemplate":
			return said.searchTemplate;
		case "entryTemplate":
			return fill(said.entryTemplate, { name: source.name ?? "" });
		case "archiveTemplate":
			return fill(said.archiveTemplate, { name: source.name ?? "" });
	}
}

/** Why a source can't be changed here, as the Inspector says it (BA-08): a Template not made yet, else a Module's. */
export function readOnlyReason(words: Words, source: StructureSource): string | null {
	const said = words.structure;
	if (source.editable) return null;
	return !source.id && source.kind === "template"
		? said.notMade
		: fill(said.readOnly, { name: source.name ?? said.thisSource });
}

/** A Component's Props block at the start of its markup, as typed. */
function propsBlock(markup: string): string {
	const match = /^\s*\{\{@props\}\}[\s\S]*?\{\{\/props\}\}/.exec(markup);
	return match?.[0].trim() ?? "";
}

/** One step of the breadcrumb: an ancestor of the selection in its source (or the selection), and its name. */
export type Crumb = { ref: string; name: string };

/** Where the element shown is in its source's markup (offsets, the end not included). */
type Range = { start: number; end: number };

/** The HTML pane's state. */
export type HtmlState = {
	/** What the pane shows: nothing selected yet, the source's markup, a Page's Placement, or why not. */
	status: "idle" | "loading" | "ready" | "placement" | "failed";
	/** The selection it follows. */
	ref: string | null;
	/** The source shown: its reference and name, whether it may be changed (and why not). */
	source: string | null;
	name: string;
	editable: boolean;
	readOnlyReason: string | null;
	/** The text in the box, and the markup it started from (the Draft's, printed; the element's part of it). */
	text: string;
	base: string;
	/** The source's markup as printed: `base` is its part at `range` while one element is shown. */
	whole: string;
	/** Where the element shown is in `whole`; null while the box holds the whole source. */
	range: Range | null;
	/** The selection's ancestors in its source, from its root down to the selection (none for the whole source). */
	crumbs: Crumb[];
	/** The source's tree the markup was printed from: a save over a changed one asks first. */
	baseTree: ElementTree | null;
	/** Typed and not saved yet. */
	dirty: boolean;
	/** Shown on the page, not saved. */
	previewing: boolean;
	problems: MarkupProblem[];
	/** The selection's lines in the text. */
	marked: LineRange | null;
	saving: boolean;
	conflict: boolean;
	failure: string | null;
};

export type HtmlPane = {
	store: PaneStore<HtmlState>;
	/** The box's Format, which the pane's header button runs. */
	format: FormatSlot;
	change(text: string): void;
	/** Saves what was typed: on leaving the box, ⌘S, before the selection moves to another source. */
	save(): Promise<void>;
	choose(choice: "reload" | "overwrite" | "cancel"): void;
	/** What typing `{{`, `{{@` or `<` offers in the source shown now (BA-33), read once per source. */
	suggestions(): Promise<MarkupSuggestions | null>;
	/** Selects an element of the breadcrumb: on the canvas, in Layers and in the pane. */
	select(ref: string): void;
	/** "Only the selected element" switched: the selection shown again, the other way (what was typed saved first). */
	reshow(): void;
	announce(text: string): void;
	destroy(): void;
};

const IDLE: HtmlState = {
	status: "idle",
	ref: null,
	source: null,
	name: "",
	editable: false,
	readOnlyReason: null,
	text: "",
	base: "",
	whole: "",
	range: null,
	crumbs: [],
	baseTree: null,
	dirty: false,
	previewing: false,
	problems: [],
	marked: null,
	saving: false,
	conflict: false,
	failure: null,
};

/** How long after typing stops the page previews the markup, in milliseconds (Code mode's). */
const PREVIEW_AFTER_MS = 350;

/** A save's place among the person's steps, kept from the moment the save starts. */
type HistoryPlace = ReturnType<CodePanesDeps["history"]["reserve"]>;

type Location = { key: string; start: number; end: number };

type ReadAnswer = {
	tree: ElementTree;
	styles: Record<string, string>;
	locations: Location[];
};

/** The source's markup with what the box holds in its place: the whole of it, or the element's part. */
function markupOf(state: Pick<HtmlState, "text" | "whole" | "range">): string {
	const { range } = state;
	return range ? `${state.whole.slice(0, range.start)}${state.text}${state.whole.slice(range.end)}` : state.text;
}

/** The source's markup the box started from. */
function baseMarkupOf(state: Pick<HtmlState, "base" | "whole" | "range">): string {
	return state.range ? state.whole : state.base;
}

/**
 * The problems of the source's markup (with the box's text in its place) where they are in the box:
 * a line of the source becomes the box's, the element's first line keeping its column from the box.
 */
export function problemsInBox(
	problems: MarkupProblem[],
	state: Pick<HtmlState, "text" | "whole" | "range">,
): MarkupProblem[] {
	const { range } = state;
	if (!range) return problems;
	const firstLine = lineAt(state.whole, range.start);
	const lineStart = state.whole.lastIndexOf("\n", range.start - 1) + 1;
	const indent = range.start - lineStart;
	const lines = state.text.split("\n").length;
	return problems.map((problem) => {
		const line = problem.line - firstLine + 1;
		if (line < 1) return { ...problem, line: 1, column: 1 };
		if (line > lines) return { ...problem, line: lines, column: 1 };
		return { ...problem, line, column: line === 1 ? Math.max(1, problem.column - indent) : problem.column };
	});
}

/** A node's name in the breadcrumb: its tag with its Layer label (`div.Container`), a Component's name, a command. */
function crumbName(node: TreeNode, source: StructureSource): string {
	switch (node.type) {
		case "element":
			return node.label ? `${node.tag}.${node.label}` : node.tag;
		case "component":
			return source.catalogue.components.find((component) => component.id === node.component)?.name ?? node.component;
		case "loop":
			return `Loop ${node.source}`;
		case "condition":
			return "{{@if}}";
		default:
			return `{{@${node.type}}}`;
	}
}

/** The selection's ancestors in its source, from the source's root down to the selection itself. */
export function crumbsOf(source: StructureSource, selection: StructureSelection): Crumb[] {
	const path = selection.path;
	if (!path || !keyOf(selection.ref)) return [];
	const crumbs: Crumb[] = [];
	// A path goes index, list, index…: each node on the way ends at an odd length.
	for (let depth = 1; depth <= path.length; depth += 2) {
		const at = path.slice(0, depth);
		const node = nodeAt(source.tree, at);
		if (!node) return [];
		const key = "id" in node ? node.id : `@${at.join(".")}`;
		crumbs.push({ ref: `${source.ref}#${key}`, name: crumbName(node, source) });
	}
	return crumbs;
}

/** The element's markup, formatted on its own: as cut from the source when it can't be formatted. */
async function tidied(markup: string): Promise<string> {
	try {
		const result = await format(markup, "html");
		return result.ok ? result.text.replace(/\n+$/, "") : markup;
	} catch {
		return markup;
	}
}

export function createHtmlPane(
	deps: () => CodePanesDeps,
	request: CodeRequests,
	/** "Only the selected element" (FX-02): on, the box holds the selected element's part of its source. */
	elementOnly: () => boolean = () => true,
): HtmlPane {
	const store = paneStore<HtmlState>(IDLE);
	const words = () => deps().words;
	let previewTimer: number | undefined;
	let run = 0;
	/** The `run` of the source's markup on its way (`show`), or 0. */
	let showing = 0;
	let previewRun = 0;
	let saving: Promise<void> | null = null;
	let saveSerial = 0;
	/** The source's tree as last printed, to tell a new tree (a change from the Inspector, Layers, someone else). */
	let shownTree: ElementTree | null = null;
	let shownPath: string | null = null;
	/** The Template or Component shown (its target), and what was typed in others the frame no longer shows. */
	let shownTarget: string | null = null;
	const kept = new Map<string, HtmlState>();
	const targetOf = (source: StructureSource) => JSON.stringify(source.target);

	/** Keeps what was typed and not saved (or a conflict waiting) for when a page shows its source again. */
	const keep = () => {
		const state = store.get();
		if (shownTarget && state.source && state.status === "ready" && (state.dirty || state.conflict))
			kept.set(shownTarget, { ...state, saving: false, previewing: false, marked: null });
	};

	/** Shows what was kept for the source, typed over its markup as before. Answers whether there was any. */
	const restore = (selection: StructureSelection, source: StructureSource): boolean => {
		const target = targetOf(source);
		const was = kept.get(target);
		if (!was) return false;
		kept.delete(target);
		run++;
		shownTree = source.tree;
		shownTarget = target;
		// An element typed in stays the one shown (its ancestors too) until what was typed is saved.
		store.set({ ...was, ref: was.range ? was.ref : selection.ref, source: source.ref });
		window.clearTimeout(previewTimer);
		previewTimer = window.setTimeout(() => void preview(), PREVIEW_AFTER_MS);
		return true;
	};

	const nameOf = (source: StructureSource): string => sourceName(words(), source);

	/** The parser's locations in a source's markup, kept for the last markup read (selecting within it reads none). */
	let located: { source: string; markup: string; locations: Promise<Location[] | null> } | null = null;
	const locationsIn = (markup: string, source: string): Promise<Location[] | null> => {
		const path = deps().path();
		if (!path) return Promise.resolve(null);
		if (located?.source === source && located.markup === markup) return located.locations;
		const locations = request<ReadAnswer>("code/editorRead", { path, ref: source, markup }).then((answer) =>
			answer.ok ? answer.data.locations : null,
		);
		located = { source, markup, locations };
		void locations.then((got) => {
			if (!got && located?.locations === locations) located = null;
		});
		return locations;
	};

	/** Where the selection is in the whole source's text: its lines, from the parser's locations. */
	const locate = async (text: string, source: string, selection: StructureSelection | null) => {
		if (!selection || store.get().range) return;
		const key = keyOf(selection.ref);
		const locations = await locationsIn(text, source);
		const now = store.get();
		if (!locations || now.text !== text || now.source !== source || now.range) return;
		const found = key ? locations.find((each) => each.key === key) : null;
		store.set({
			marked: found
				? { from: lineAt(text, found.start), to: lineAt(text, Math.max(found.start, found.end - 1)) }
				: null,
		});
	};

	/**
	 * The selected element's own markup in the source's (formatted) and where it is there; null for the
	 * source itself, or an element the markup doesn't show where it is: the box holds the whole source.
	 */
	const elementView = async (
		markup: string,
		source: string,
		selection: StructureSelection,
	): Promise<{ text: string; range: Range } | null> => {
		// A branch of a Condition or a Loop shows its Condition or Loop.
		const key = keyOf(selection.ref).replace(/\/\d+$/, "");
		if (!key || !elementOnly()) return null;
		const locations = await locationsIn(markup, source);
		const found = locations?.find((each) => each.key === key);
		if (!found || found.end <= found.start) return null;
		return { text: await tidied(markup.slice(found.start, found.end)), range: { start: found.start, end: found.end } };
	};

	/** What the box shows of a source's markup for the selection: the element's part, or all of it. */
	const viewOf = async (markup: string, source: StructureSource, selection: StructureSelection) => {
		const view = await elementView(markup, source.ref, selection);
		return {
			text: view?.text ?? markup,
			base: view?.text ?? markup,
			whole: markup,
			range: view?.range ?? null,
			crumbs: crumbsOf(source, selection),
		};
	};

	/** The selection moved within the source shown (nothing typed): its part of the same markup. */
	const refocus = async (selection: StructureSelection, source: StructureSource) => {
		// A source's markup on its way (`show`) is cut for the selection as it is once it comes.
		if (showing) return;
		const asked = ++run;
		const { whole } = store.get();
		const view = await viewOf(whole, source, selection);
		const now = store.get();
		if (asked !== run || now.dirty || now.whole !== whole || now.source !== source.ref) return;
		store.set({ ...view, marked: null, problems: [], failure: null });
		if (!view.range) void locate(whole, source.ref, selection);
	};

	/** Shows the source's markup as its Draft holds it now (what was typed is dropped). */
	const show = async (selection: StructureSelection, source: StructureSource) => {
		const path = deps().path();
		if (!path) return;
		const asked = ++run;
		showing = asked;
		try {
			await print(selection, source, path, asked);
		} finally {
			if (showing === asked) showing = 0;
		}
		// Moved again within the source while its part was cut: the part of the selection now.
		const state = store.get();
		const latest = deps().structure.snapshot().selection;
		if (asked === run && state.status === "ready" && !state.dirty && latest?.source === selection.source) {
			if (latest.ref !== state.ref) void refocus(latest, source);
		}
	};
	/** `show`'s work: the markup printed, then the selection's part of it. */
	const print = async (selection: StructureSelection, source: StructureSource, path: string, asked: number) => {
		shownTree = source.tree;
		shownTarget = targetOf(source);
		const typedBefore = store.get().text;
		store.set((state) => ({
			status: state.source === source.ref && state.status === "ready" ? "ready" : "loading",
			ref: selection.ref,
			source: source.ref,
			name: nameOf(source),
			editable: source.editable,
			readOnlyReason: readOnlyReason(words(), source),
			failure: null,
		}));
		// A source that may be changed is printed from its shared Draft; one that may not (a Module's
		// Component, a Template not made yet) is read as Code mode reads it, with no Draft of its own.
		const answer = source.editable
			? await request<{ markup: string }>("code/editorMarkup", {
					path,
					ref: source.ref,
					draft: { tree: source.tree },
				})
			: await request<{ markup: string }>("code/open", { path, ref: source.ref });
		if (asked !== run) return;
		// Typed over meanwhile (just after a save): what was typed stays, against the source as it was.
		const now = store.get();
		if (now.dirty && now.text !== typedBefore && now.source === source.ref) return;
		if (!answer.ok) {
			store.set({ status: "failed", failure: fill(words().code.notRead, { reason: answer.code }) });
			return;
		}
		const markup = answer.data.markup;
		// The selection may have moved within the source while its markup came.
		const latest = deps().structure.snapshot().selection;
		const selected = latest?.source === selection.source ? latest : selection;
		const view = await viewOf(markup, source, selected);
		if (asked !== run) return;
		const typed = store.get();
		if (typed.dirty && typed.text !== typedBefore && typed.source === source.ref) return;
		store.set({
			status: "ready",
			ref: selected.ref,
			...view,
			marked: null,
			baseTree: source.tree,
			dirty: false,
			problems: [],
			conflict: false,
		});
		if (store.get().previewing) {
			store.set({ previewing: false });
			void deps().frame.current?.rerender();
		}
		if (!view.range) void locate(markup, source.ref, selected);
	};

	/** A Placement of a Page's Page layout: its Component tag, read only. */
	const showPlacement = async (selection: StructureSelection) => {
		const asked = ++run;
		const snapshot = deps().structure.snapshot();
		const placement = snapshot.layout?.find((each) => `content/${each.id}` === selection.ref);
		const tag = (placement?.name ?? "").replace(/[^A-Za-z0-9]/g, "") || "Component";
		store.set({
			...IDLE,
			status: "placement",
			ref: selection.ref,
			source: null,
			name: placement?.name ?? "",
			readOnlyReason: words().code.html.placementHelp,
			text: `<${tag} />`,
			base: `<${tag} />`,
		});
		const site = snapshot.sources.get("site");
		const entryId = site?.pageLayout?.id;
		if (!entryId || !placement) return;
		try {
			const read = await managementApi(deps().config.token).pageLayouts.get({
				siteId: deps().config.site.id,
				entryId,
			});
			if (asked !== run) return;
			const found = read.placements.find((each) => each.id === placement.id);
			if (!found) return;
			const attributes = Object.entries(found.values as Record<string, unknown>).flatMap(([key, value]) =>
				typeof value === "string" || typeof value === "number" || typeof value === "boolean"
					? [`  ${key}="${String(value).replace(/"/g, "&quot;")}"`]
					: [],
			);
			const text = attributes.length ? `<${tag}\n${attributes.join("\n")}\n/>` : `<${tag} />`;
			store.set({ text, base: text });
		} catch {
			// The tag alone stays.
		}
	};

	/** Follows the selection and its source's tree. */
	const follow = () => {
		const { structure, path } = deps();
		const snapshot = structure.snapshot();
		const selection = snapshot.selection;
		const pathNow = path();
		if (pathNow !== shownPath) {
			keep();
			shownPath = pathNow;
			shownTree = null;
			shownTarget = null;
			store.set({ ...IDLE });
		}
		const state = store.get();
		if (!selection) return;
		const source = snapshot.sources.get(selection.source);
		if (!source) {
			// A Page's Placement (its source is the Page's own, never opened as a Template), or a source opening.
			if (!keyOf(selection.ref) && selection.ref !== state.ref && snapshot.sources.has("site"))
				void showPlacement(selection);
			return;
		}
		const sameSource = state.source === source.ref && state.status !== "placement";
		// What was typed is saved before the box shows another source, or another element (or the whole
		// source) of this one; once only: markup that can't be read stays in the box, its problems listed.
		const saveThenFollow = () =>
			void save().then(() => {
				if (!store.get().dirty) follow();
			});
		if (!sameSource) {
			if (state.dirty) {
				saveThenFollow();
				return;
			}
			if (!restore(selection, source)) void show(selection, source);
			return;
		}
		if (selection.ref !== state.ref) {
			// The box holds one element, or is about to: what was typed is saved before it shows another.
			if (state.dirty && (state.range || (elementOnly() && keyOf(selection.ref)))) {
				if (!state.saving) saveThenFollow();
				return;
			}
			store.set({ ref: selection.ref, crumbs: crumbsOf(source, selection) });
			// While the source's markup is on its way the text is still the previous source's: its own
			// part is found once it comes (`show`).
			if (!state.dirty && state.status === "ready") void refocus(selection, source);
		}
		// The source changed (the Inspector, Layers, Undo, someone else): shown again unless typed over.
		if (source.tree !== shownTree && !sameValue(source.tree as unknown as Json, shownTree as unknown as Json)) {
			if (!state.dirty && !state.saving) void show(selection, source);
		}
	};

	const preview = async () => {
		const state = store.get();
		const path = deps().path();
		if (!state.source || !path) return;
		const asked = ++previewRun;
		if (!state.dirty) {
			// Back to the Draft's markup: nothing to show or to report.
			store.set({ problems: [], failure: null });
			if (state.previewing) {
				store.set({ previewing: false });
				await deps().frame.current?.rerender();
			}
			return;
		}
		const answer = await request<{ html: string; stylesheet: { css: string } }>("code/preview", {
			path,
			markup: { ref: state.source, text: markupOf(state) },
		});
		if (asked !== previewRun || store.get().text !== state.text) return;
		if (!answer.ok) {
			const problems = problemsInBox(problemsOf(answer), state);
			store.set({
				problems,
				failure: problems.length ? null : fill(words().code.notPreviewed, { reason: answer.code }),
			});
			return;
		}
		store.set({ problems: [], failure: null, previewing: true });
		deps().frame.current?.preview({ html: answer.data.html, css: answer.data.stylesheet.css });
		void locate(state.text, state.source, deps().structure.snapshot().selection);
	};

	/**
	 * Saves through Code mode's own save: inline styles and a Component's Props become Classes and Props.
	 * Its receipts are one step, recorded in the place the save took in the history when it started.
	 */
	const saveWhole = async (state: HtmlState, overwrite: boolean, place: HistoryPlace): Promise<boolean> => {
		const path = deps().path();
		if (!path || !state.source) return false;
		const opened = await request<{ version: string | null }>("code/open", { path, ref: state.source });
		if (!opened.ok) return false;
		const answer = await request<{
			markup: string;
			history: { resource: string; before: Json; after: Json }[];
		}>("code/save", { path, ref: state.source, markup: markupOf(state), version: opened.data.version });
		if (!answer.ok) {
			const problems = problemsInBox(problemsOf(answer), state);
			store.set({
				problems,
				failure: problems.length ? null : fill(words().code.notSaved, { reason: answer.code }),
			});
			return false;
		}
		const label = fill(words().code.html.step, { name: state.name });
		// Recorded one after the other under one group of their own, the receipts make one step.
		const group = `html-save:${++saveSerial}`;
		const location = {
			siteId: deps().config.site.id,
			panel: "html" as const,
			ref: state.ref ?? undefined,
			title: label,
		};
		for (const change of answer.data.history) place.record({ ...change, label, location, group });
		void overwrite;
		await deps().frame.current?.rerender();
		return true;
	};

	const save = async (overwrite = false): Promise<void> => {
		if (saving) return saving;
		const state = store.get();
		if (!state.dirty || !state.editable || !state.source || store.get().conflict) return;
		const sourceRef = state.source;
		const source = deps().structure.snapshot().sources.get(sourceRef);
		if (!source) return;
		// Someone changed the source since the markup was read: theirs or mine.
		if (!overwrite && state.baseTree && !sameValue(source.tree as unknown as Json, state.baseTree as unknown as Json)) {
			store.set({ conflict: true });
			return;
		}
		// The save keeps its place among the person's steps from now: Undo waits for it (BA-33's 872).
		const place = deps().history.reserve();
		saving = (async () => {
			store.set({ saving: true });
			window.clearTimeout(previewTimer);
			const path = deps().path();
			const markup = markupOf(state);
			const read = path ? await request<ReadAnswer>("code/editorRead", { path, ref: sourceRef, markup }) : null;
			if (!read) return;
			// The frame shows another page now: the source is no longer this one's, so nothing is saved
			// (what was typed is kept for when a page shows it again).
			if (deps().path() !== path) return;
			if (!read.ok) {
				const problems = problemsInBox(problemsOf(read), state);
				store.set({
					problems,
					failure: problems.length ? null : fill(words().code.notSaved, { reason: read.code }),
				});
				deps().announce(
					problems.length ? words().code.html.problems : fill(words().code.notSaved, { reason: read.code }),
					true,
				);
				return;
			}
			const label = fill(words().code.html.step, { name: state.name });
			const whole =
				Object.keys(read.data.styles).length > 0 ||
				(source.kind === "component" && propsBlock(markup) !== propsBlock(baseMarkupOf(state)));
			let ok: boolean;
			if (whole) ok = await saveWhole(state, overwrite, place);
			else {
				const refused = deps().structure.change(sourceRef, read.data.tree, label);
				if (refused) {
					store.set({ failure: fill(words().code.notSaved, { reason: refused }) });
					deps().announce(fill(words().code.notSaved, { reason: refused }), true);
				}
				ok = refused === null;
			}
			if (!ok) return;
			const after = deps().structure.snapshot().sources.get(sourceRef);
			shownTree = after?.tree ?? null;
			const typedSince = store.get().text !== state.text;
			store.set({
				base: state.text,
				whole: markup,
				range: state.range ? { start: state.range.start, end: state.range.start + state.text.length } : null,
				baseTree: after?.tree ?? null,
				dirty: typedSince,
				previewing: false,
				problems: [],
				failure: null,
			});
			deps().announce(fill(words().code.html.saved, { name: state.name }));
			// Shown as the Draft now prints it (new elements with their ids), unless typed over meanwhile.
			const selection = deps().structure.snapshot().selection;
			if (!typedSince && after && selection) void show(selection, after);
		})();
		try {
			await saving;
		} finally {
			place.settle();
			saving = null;
			store.set({ saving: false });
		}
	};

	const unsubscribe = deps().structure.subscribe(follow);
	follow();
	/** What each source's markup may read and place, as `code/open` answers it. */
	const offered = new Map<string, Promise<MarkupSuggestions | null>>();

	return {
		store,
		format: formatSlot(),
		change(text) {
			const state = store.get();
			if (!state.editable || state.status !== "ready") return;
			store.set({ text, dirty: text !== state.base, failure: null });
			window.clearTimeout(previewTimer);
			previewTimer = window.setTimeout(() => void preview(), PREVIEW_AFTER_MS);
		},
		save: () => save(),
		choose(choice) {
			store.set({ conflict: false });
			if (choice === "overwrite") void save(true);
			else if (choice === "reload") {
				const snapshot = deps().structure.snapshot();
				const selection = snapshot.selection;
				const source = selection ? snapshot.sources.get(selection.source) : undefined;
				store.set({ dirty: false });
				if (selection && source) void show(selection, source);
			}
		},
		async suggestions() {
			const source = store.get().source;
			const path = deps().path();
			if (!source || !path) return null;
			let read = offered.get(source);
			if (!read) {
				read = request<{ suggestions: MarkupSuggestions }>("code/open", { path, ref: source }).then((answer) =>
					answer.ok ? answer.data.suggestions : null,
				);
				offered.set(source, read);
				void read.then((got) => {
					if (!got) offered.delete(source);
				});
			}
			return read;
		},
		select(ref) {
			deps().structure.select(ref);
		},
		reshow() {
			const state = store.get();
			const snapshot = deps().structure.snapshot();
			const selection = snapshot.selection;
			const source = selection ? snapshot.sources.get(selection.source) : undefined;
			if (!selection || !source || state.source !== source.ref || state.status !== "ready") return;
			if (state.dirty) {
				void save().then(() => {
					if (!store.get().dirty) void refocus(selection, source);
				});
				return;
			}
			void refocus(selection, source);
		},
		announce: (text) => deps().announce(text),
		destroy() {
			window.clearTimeout(previewTimer);
			unsubscribe();
		},
	};
}

/** The HTML pane's body: the box, then its line (problems, Format's note, why it is read only). */
export function HtmlBody({ pane, words, settings }: { pane: HtmlPane; words: Words; settings: PaneSettings }) {
	const state = usePane(pane.store);
	const area = useRef<HTMLTextAreaElement>(null);
	const noteId = useId();
	const editable = state.editable && state.status === "ready";
	const formatting = useBoxFormat("html", area, state.text, editable);
	useFormatSlot(pane.format, formatting, editable);
	const shown = words.code.html;

	const suggest = useSuggest(pane, words, area);
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (suggest.onKeyDown(event)) return;
		if (formatting.onKeyDown(event)) return;
		if (
			matches(event.nativeEvent, "editor.save") ||
			((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s")
		) {
			event.preventDefault();
			void pane.save();
		}
	};
	const goTo = (problem: MarkupProblem) => {
		const element = area.current;
		if (!element) return;
		const at = offsetAt(element.value, problem.line, problem.column);
		element.focus();
		element.setSelectionRange(at, at);
	};

	return (
		<div className="relative flex min-h-0 grow flex-col gap-1" data-wc-html-pane={state.status}>
			{state.status === "ready" && state.crumbs.length > 0 ? (
				<Breadcrumb
					crumbs={state.crumbs}
					label={fill(shown.breadcrumb, { name: state.name })}
					onSelect={(ref) => pane.select(ref)}
				/>
			) : null}
			{state.status === "loading" || state.status === "idle" ? (
				<p className="text-chrome-muted m-0 p-3 text-[12px]" role="status">
					{shown.loading}
				</p>
			) : (
				<CodeWell
					ref={area}
					language="html"
					value={state.text}
					onChange={(text) => {
						pane.change(text);
						suggest.typed(text);
					}}
					onKeyDown={onKeyDown}
					aria={suggest.aria}
					onBlur={() => {
						suggest.close();
						if (!store(pane).dirty) return;
						void (async () => {
							const tidied =
								settings.formatOnLeave && editable ? await formattedOnLeaving(store(pane).text, "html") : null;
							if (tidied) pane.change(tidied);
							await pane.save();
						})();
					}}
					label={fill(shown.label, { name: state.name })}
					describedBy={noteId}
					problems={formatting.problemLine ? [formatting.problemLine] : state.problems.map((each) => each.line)}
					marked={state.dirty ? null : state.marked}
					readOnly={!editable}
					wrap={settings.wrap}
					data={{ "data-wc-code-box": "html" }}
				/>
			)}
			{suggest.list}
			<div id={noteId} className="flex min-h-[22px] flex-col gap-0.5 px-0.5">
				{state.problems.length > 0 ? (
					<ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[11px] text-red-200" data-wc-html-problems="">
						{state.problems.map((problem) => (
							<li key={`${problem.line}:${problem.column}:${problem.message}`} className="flex items-center gap-1.5">
								<TriangleAlertIcon aria-hidden="true" className="text-chrome-danger size-3 flex-none" />
								<button
									type="button"
									onClick={() => goTo(problem)}
									className={`rounded-sm text-start underline-offset-2 hover:underline ${FOCUS_RING}`}
								>
									{fill(shown.problemAt, {
										line: String(problem.line),
										column: String(problem.column),
										message: problem.message,
									})}
								</button>
							</li>
						))}
					</ul>
				) : null}
				<NoteLine
					format={formatting}
					words={words}
					problem={state.failure ? { text: state.failure } : null}
					help={
						state.readOnlyReason ??
						(state.saving ? words.code.saving : state.previewing ? shown.previewing : state.dirty ? shown.help : "")
					}
				/>
			</div>
			{state.conflict ? (
				<ConflictDialog
					words={words}
					text={fill(words.code.conflict.text, { name: state.name })}
					onChoose={(choice) => pane.choose(choice)}
				/>
			) : null}
		</div>
	);
}

/**
 * The breadcrumb over the box (FX-02): the selection's ancestors in its source, from its root down to
 * it, each a button that selects it (on the canvas, in Layers and in the pane), the last one the
 * selection (`aria-current`). Too long for the pane, it is cut from its start: it shows its end, a
 * fade says there is more, and it scrolls to the step that takes focus.
 */
function Breadcrumb({
	crumbs,
	label,
	onSelect,
}: {
	crumbs: readonly Crumb[];
	label: string;
	onSelect(ref: string): void;
}) {
	const list = useRef<HTMLOListElement>(null);
	const [cut, setCut] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: new steps show the end again.
	useLayoutEffect(() => {
		const element = list.current;
		if (!element) return;
		const rtl = getComputedStyle(element).direction === "rtl";
		const measure = () => setCut(Math.abs(element.scrollLeft) > 1);
		const toEnd = () => {
			element.scrollLeft = rtl ? -element.scrollWidth : element.scrollWidth;
			measure();
		};
		toEnd();
		const observer = new ResizeObserver(toEnd);
		observer.observe(element);
		element.addEventListener("scroll", measure);
		return () => {
			observer.disconnect();
			element.removeEventListener("scroll", measure);
		};
	}, [crumbs]);
	return (
		<nav aria-label={label} className="relative flex min-w-0 shrink-0" data-wc-html-crumbs="">
			{cut ? (
				<span
					aria-hidden="true"
					className="from-chrome-well text-chrome-faint pointer-events-none absolute inset-y-0 start-0 z-10 flex w-8 items-center bg-linear-to-r to-transparent ps-1.5 text-[11px] rtl:bg-linear-to-l"
					data-wc-crumbs-cut=""
				>
					…
				</span>
			) : null}
			<ol
				ref={list}
				className="m-0 flex min-w-0 grow [scrollbar-width:none] list-none items-center gap-0.5 overflow-x-auto px-1.5 pt-1.5 pb-0.5 [&::-webkit-scrollbar]:hidden"
			>
				{crumbs.map((crumb, index) => {
					const last = index === crumbs.length - 1;
					return (
						<li key={crumb.ref} className="flex shrink-0 items-center gap-0.5">
							{index > 0 ? (
								<ChevronRightIcon aria-hidden="true" className="text-chrome-faint size-3 flex-none rtl:rotate-180" />
							) : null}
							<button
								type="button"
								aria-current={last ? "location" : undefined}
								onClick={() => onSelect(crumb.ref)}
								className={`h-5 rounded-[4px] px-1 font-mono text-[11px] whitespace-nowrap ${
									last ? "text-chrome-strong" : "text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong"
								} ${CHROME_EASE} ${FOCUS_RING}`}
								data-wc-crumb={crumb.ref}
							>
								{crumb.name}
							</button>
						</li>
					);
				})}
			</ol>
		</nav>
	);
}

/**
 * The HTML box's suggestions (BA-33): typing `{{`, `{{@` or `<` and a capital opens a list box under the
 * box ("Suggestions"); the arrows move through it (the box says which is active), Enter or Tab puts the
 * active one in, Escape closes it, and leaving the box closes it too. Typing goes on in the box.
 */
function useSuggest(pane: HtmlPane, words: Words, area: { current: HTMLTextAreaElement | null }) {
	const [open, setOpen] = useState<(SuggestContext & { active: number }) | null>(null);
	const offered = useRef<MarkupSuggestions | null>(null);
	const listId = useId();
	useEffect(() => {
		void pane.suggestions().then((got) => {
			offered.current = got;
		});
	});
	const close = () => setOpen(null);
	const take = (context: SuggestContext, index: number) => {
		const item = context.items[index];
		const box = area.current;
		if (!item || !box) return;
		const next = applySuggestion(box.value, context, item);
		pane.change(next.text);
		setOpen(null);
		requestAnimationFrame(() => {
			box.focus();
			box.setSelectionRange(next.caret, next.caret);
		});
	};
	const optionId = (index: number) => `${listId}-${index}`;
	return {
		typed(text: string) {
			const box = area.current;
			const known = offered.current;
			if (!box || !known) return;
			const context = markupSuggestions(text, box.selectionStart ?? text.length, known, words);
			if (!context || context.items.length === 0) {
				if (open) setOpen(null);
				return;
			}
			if (!open || open.from !== context.from) pane.announce(suggestionCount(context.items.length, words));
			setOpen({ ...context, active: 0 });
		},
		close,
		onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
			if (!open) return false;
			const count = open.items.length;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				setOpen({ ...open, active: (open.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
				return true;
			}
			if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey)) {
				event.preventDefault();
				take(open, open.active);
				return true;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setOpen(null);
				return true;
			}
			return false;
		},
		aria: open
			? { "aria-activedescendant": optionId(open.active), "aria-controls": listId }
			: ({} as Record<`aria-${string}`, string | undefined>),
		list: open ? (
			<div
				id={listId}
				role="listbox"
				aria-label={words.suggest.label}
				className="bg-chrome-menu border-chrome-hover absolute start-10 bottom-8 z-20 flex max-h-56 w-[360px] max-w-[calc(100%-48px)] flex-col overflow-auto rounded-md border p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
				data-wc-suggestions=""
			>
				{open.items.slice(0, 40).map((item, index) => (
					<div
						key={`${item.group}:${item.label}:${item.insert}`}
						id={optionId(index)}
						role="option"
						aria-selected={index === open.active}
						tabIndex={-1}
						onMouseDown={(event) => {
							event.preventDefault();
							take(open, index);
						}}
						className={`flex min-h-6 cursor-default items-baseline gap-2 rounded-[4px] px-1.5 text-[12px] ${
							index === open.active ? "bg-chrome-hover text-chrome-strong" : "text-chrome-text"
						}`}
					>
						<span className="truncate font-mono">{item.label}</span>
						{item.detail ? <span className="text-chrome-muted truncate text-[11px]">{item.detail}</span> : null}
						<span className="text-chrome-muted ms-auto shrink-0 text-[11px]">{item.group}</span>
					</div>
				))}
			</div>
		) : null,
	};
}

/** The pane's state now, outside React (the box's handlers read it as it is when they run). */
function store(pane: HtmlPane): HtmlState {
	return pane.store.get();
}

/** The HTML pane's header control: Format (`builder/02`; Expand follows it, from the pane's parts). */
export function HtmlActions({ pane, words }: { pane: HtmlPane; words: Words }) {
	return <FormatButton slot={pane.format} words={words} />;
}

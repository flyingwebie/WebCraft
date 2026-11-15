import { type Json, sameValue } from "@webcraft/core/draft-document";
import type { ElementTree } from "@webcraft/renderer/builder";
import { TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { editorHistory } from "../../builder/editor-history.ts";
import { matches } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import { FOCUS_RING } from "../controls.tsx";
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
	/** The text in the box, and the markup it started from (the Draft's, printed). */
	text: string;
	base: string;
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

type ReadAnswer = {
	tree: ElementTree;
	styles: Record<string, string>;
	locations: { key: string; start: number; end: number }[];
};

export function createHtmlPane(deps: () => CodePanesDeps, request: CodeRequests): HtmlPane {
	const store = paneStore<HtmlState>(IDLE);
	const words = () => deps().words;
	let previewTimer: number | undefined;
	let run = 0;
	let previewRun = 0;
	let saving: Promise<void> | null = null;
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
		store.set({ ...was, ref: selection.ref, source: source.ref });
		window.clearTimeout(previewTimer);
		previewTimer = window.setTimeout(() => void preview(), PREVIEW_AFTER_MS);
		return true;
	};

	const nameOf = (source: StructureSource): string => sourceName(words(), source);

	/** Where the selection is in the text: its lines, from the parser's locations. */
	const locate = async (text: string, source: string, selection: StructureSelection | null) => {
		const path = deps().path();
		if (!path || !selection) return;
		const key = keyOf(selection.ref);
		const answer = await request<ReadAnswer>("code/editorRead", { path, ref: source, markup: text });
		const now = store.get();
		if (!answer.ok || now.text !== text || now.source !== source) return;
		const found = key ? answer.data.locations.find((each) => each.key === key) : null;
		store.set({
			marked: found
				? { from: lineAt(text, found.start), to: lineAt(text, Math.max(found.start, found.end - 1)) }
				: null,
		});
	};

	/** Shows the source's markup as its Draft holds it now (what was typed is dropped). */
	const show = async (selection: StructureSelection, source: StructureSource) => {
		const path = deps().path();
		if (!path) return;
		const asked = ++run;
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
		store.set({
			status: "ready",
			text: markup,
			base: markup,
			baseTree: source.tree,
			dirty: false,
			problems: [],
			conflict: false,
		});
		if (store.get().previewing) {
			store.set({ previewing: false });
			void deps().frame.current?.rerender();
		}
		void locate(markup, source.ref, selection);
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
		if (!sameSource) {
			if (state.dirty) {
				void save().then(() => follow());
				return;
			}
			if (!restore(selection, source)) void show(selection, source);
			return;
		}
		if (selection.ref !== state.ref) {
			store.set({ ref: selection.ref });
			if (!state.dirty) void locate(state.text, source.ref, selection);
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
			markup: { ref: state.source, text: state.text },
		});
		if (asked !== previewRun || store.get().text !== state.text) return;
		if (!answer.ok) {
			const problems = problemsOf(answer);
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

	/** Saves through Code mode's own save: inline styles and a Component's Props become Classes and Props. */
	const saveWhole = async (state: HtmlState, overwrite: boolean): Promise<boolean> => {
		const path = deps().path();
		if (!path || !state.source) return false;
		const opened = await request<{ version: string | null }>("code/open", { path, ref: state.source });
		if (!opened.ok) return false;
		const answer = await request<{
			markup: string;
			history: { resource: string; before: Json; after: Json }[];
		}>("code/save", { path, ref: state.source, markup: state.text, version: opened.data.version });
		if (!answer.ok) {
			store.set({
				problems: problemsOf(answer),
				failure: problemsOf(answer).length ? null : fill(words().code.notSaved, { reason: answer.code }),
			});
			return false;
		}
		const label = fill(words().code.html.step, { name: state.name });
		const [first, ...rest] = answer.data.history;
		if (first) {
			const step = editorHistory().record({
				...first,
				label,
				location: { siteId: deps().config.site.id, panel: "html", ref: state.ref ?? undefined, title: label },
			});
			for (const change of rest) editorHistory().attach(step, change);
		}
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
		saving = (async () => {
			store.set({ saving: true });
			window.clearTimeout(previewTimer);
			const path = deps().path();
			const read = path
				? await request<ReadAnswer>("code/editorRead", { path, ref: sourceRef, markup: state.text })
				: null;
			if (!read) return;
			// The frame shows another page now: the source is no longer this one's, so nothing is saved
			// (what was typed is kept for when a page shows it again).
			if (deps().path() !== path) return;
			if (!read.ok) {
				const problems = problemsOf(read);
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
				(source.kind === "component" && propsBlock(state.text) !== propsBlock(state.base));
			let ok: boolean;
			if (whole) ok = await saveWhole(state, overwrite);
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

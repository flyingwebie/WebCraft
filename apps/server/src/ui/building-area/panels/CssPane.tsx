import { createDraftClient, type Json } from "@webcraft/core/draft-document";
import type { ElementNode } from "@webcraft/renderer/builder";
import { PlusIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

import { editorHistory, type HistoryResult } from "../../builder/editor-history.ts";
import { replaceAt } from "../../builder/tree.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { connect } from "../editing/drafts.ts";
import type { StructureSelection, StructureSource } from "../editing/selection.ts";
import { managementApi } from "../management.ts";
import { NoteLine } from "../places/styles/CodeBox.tsx";
import { QuickActions, useFavourites } from "../places/styles/QuickActions.tsx";
import { piecesOf, type RuleBreakpoint, ruleOf } from "../places/styles/rule.ts";
import type { QuickTokens, StepSizes } from "../places/styles/view.ts";
import { CodeWell } from "./CodeWell.tsx";
import { chooseClass, chosenClassOf, subscribeChosenClass } from "./chosen-class.ts";
import type { CodePanesDeps } from "./code-panes.tsx";
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
 * - A rule that isn't one block for the Class is marked on its line and not saved.
 * - The media query action writes a breakpoint's block (`@media (width >= 768px)`, from that width up,
 *   as the Design system's breakpoints apply) or, "At this width", the rule at the frame's width now
 *   as the frames draw it: `@media (width < 768px)`.
 * - Only an element has a CSS pane (a Loop, a Condition, a Placement have none, SPEC 5).
 */

/** How long after typing stops a rule is saved, in milliseconds (as the Styles place). */
const SAVE_AFTER_MS = 800;

type DesignClass = { id: string; name: string; styles: string; css: string; breakpoints: Record<string, string> };
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
	/** The element's Classes (its own, not token utilities), in its order, by id and name. */
	classes: readonly { id: string; name: string }[];
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
	classId: null,
	name: "",
	text: "",
	dirty: false,
	saving: false,
	problem: null,
	failure: null,
	design: null,
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
	let saveTimer: number | undefined;
	let reading: Promise<void> | null = null;
	let saving: Promise<void> | null = null;

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
		if (!found || !state.design) {
			store.set({ text: "", name: found?.name ?? state.name, dirty: false, problem: null });
			return;
		}
		store.set({
			name: found.name,
			text: ruleOf(found.name, found, state.design.breakpoints),
			dirty: false,
			problem: null,
			failure: null,
		});
	};

	const follow = () => {
		const snapshot = deps().structure.snapshot();
		const selection = snapshot.selection;
		const element = elementOf(selection);
		if (!selection || !element) return;
		const source = snapshot.sources.get(selection.source);
		if (!source) return;
		const names = new Map(source.catalogue.classes.map((each) => [each.id, each.name]));
		const classes = element.classes.flatMap((id) => {
			const name = names.get(id);
			return name ? [{ id, name }] : [];
		});
		const classId = chosenClassOf(
			selection.ref,
			classes.map((each) => each.id),
		);
		const state = store.get();
		const moved = state.ref !== selection.ref || state.classId !== classId;
		if (moved && state.dirty) {
			void flush().then(follow);
			return;
		}
		store.set({
			ref: selection.ref,
			source: source.ref,
			editable: source.editable,
			readOnlyReason: readOnlyReason(source),
			classes,
			classId,
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

	const readOnlyReason = (source: StructureSource): string | null => {
		const said = words().structure;
		if (source.editable) return null;
		return source.id ? fill(said.readOnly, { name: source.name ?? said.thisSource }) : said.notMade;
	};

	const save = async () => {
		const state = store.get();
		const design = state.design;
		if (!state.dirty || !state.classId || !design) return;
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
			store.set({ design: designOf(saved.designSystem.draft, design.sizes), dirty: typedSince, failure: null });
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
				void read();
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
		flush,
		destroy() {
			window.clearTimeout(saveTimer);
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
			<div className="flex min-w-0 grow-[6] basis-0 items-center gap-1.5 overflow-x-auto py-px" data-wc-css-classes="">
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
								aria-label={fill(said.chooseClass, { name: each.name })}
								onClick={() => pane.choose(each.id)}
								className={`h-full truncate rounded-s-[4px] ps-1.5 pe-1 ${FOCUS_RING}`}
							>
								.{each.name}
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
	if (state.classes.length === 0 || !state.classId)
		return (
			<p className="text-chrome-muted m-0 p-3 text-[12px]" data-wc-css-pane="none">
				{state.status === "failed" ? state.failure : shown.noClass}
			</p>
		);
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		formatting.onKeyDown(event);
	};
	return (
		<div className="flex min-h-0 grow flex-col gap-1.5 pt-1.5" data-wc-css-pane="ready">
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

/** The width of the page in the frame now (the media query action's "At this width"). */
function frameWidth(): number | null {
	const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
	const width = frame?.contentWindow?.innerWidth;
	return width ? Math.round(width) : null;
}

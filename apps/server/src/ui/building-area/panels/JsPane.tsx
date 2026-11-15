import type { Json } from "@webcraft/core/draft-document";
import { CircleAlertIcon, InfoIcon, PlayIcon, TrashIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useSyncExternalStore } from "react";

import { editorHistory, type HistoryResult } from "../../builder/editor-history.ts";
import { matches } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import type { SaveWatch } from "../canvas/regions.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { codeRefOf, sourceOf } from "../editing/selection.ts";
import { NoteLine } from "../places/styles/CodeBox.tsx";
import { CodeWell } from "./CodeWell.tsx";
import { ConflictDialog } from "./ConflictDialog.tsx";
import type { CodePanesDeps } from "./code-panes.tsx";
import { type CodeRequests, offsetAt } from "./code-requests.ts";
import { type ConsoleLine, consoleLog } from "./console-log.ts";
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
import { type ScriptSettings, ScriptSettingsRow, sameSettings } from "./ScriptSettings.tsx";

/**
 * The JS pane (BA-11; SPEC 5, `builder/02`, `05`, `07`, `10`): the page's scripts, as Code mode's JS
 * panel had them (ADR 0016): **Page** (the page's own script), **Site** (the Site script) and, while
 * the selection is a Placement or inside one, **Component** (its Component's script, with the "on N
 * pages" warning). What is typed saves to the script's Draft 0.8 s after typing stops (`code/saveScript`,
 * based on the version it was read at: a save over someone else's asks Reload or Overwrite first). A
 * changed script never runs as people type: **Run** saves, draws the page again from its Drafts and
 * runs the Site script, the Component's and the page's on it, in that order. The **console** under the
 * box lists what the page's scripts write, their errors and rejected promises (the page agent hands
 * them over, `agent/console.ts`), each against its script and line; choosing one opens that script
 * with the caret on the line. A Component script's call that failed on a Placement shows against its
 * Component, with the Placement a click away (BA-32).
 *
 * Each save is **one Undo step** of the tab's history (BA-32): taken back by saving the code before it,
 * based on the version the step left (a script someone changed since is skipped as obsolete). Typing
 * holds the history's place from the first keystroke until its save is answered, so Undo waits for the
 * save before it takes a step back. ⌘S saves at once. A script typed and not saved yet, or a conflict
 * waiting for its choice, is kept by its page when the frame shows another one, and shown again (and
 * saved, or asked again) once the frame shows that page again (BA-34).
 *
 * The Component tab also sets the script's **Consent category** and the **Libraries it needs** (BA-36,
 * as Code mode's Component tab did), in a row under the header: a change saves at once with the script
 * (`code/saveScript` takes `consentCategory` and `libraryIds`), as one Undo step with its code.
 */

export type ScriptTab = "page" | "site" | "component";

type CodeScript = { code: string; version: string | null; src: string | null };
type ComponentScript = CodeScript &
	ScriptSettings & {
		componentId: string;
		name: string;
		editable: boolean;
		pages: number;
		runtime: string;
		/** The Site's Libraries, to choose the ones it needs from. */
		libraries: { id: string; name: string }[];
	};
type Scripts = {
	site: CodeScript;
	page: (CodeScript & { entryId: string }) | null;
	component?: ComponentScript | null;
};

export type JsState = {
	status: "idle" | "loading" | "ready" | "failed";
	/** The page they are the scripts of, and the selection's source (its Component script). */
	path: string | null;
	source: string | null;
	scripts: Scripts | null;
	tab: ScriptTab;
	/** The text in the box for each script, and whether it is typed and not saved yet. */
	texts: Record<ScriptTab, string>;
	dirty: Record<ScriptTab, boolean>;
	/** The Component script's settings as the Component tab shows them (saved with its text). */
	settings: ScriptSettings | null;
	saving: boolean;
	running: boolean;
	/** A save over someone else's version is waiting for the person's choice. */
	conflict: { tab: ScriptTab; version: string | null } | null;
	failure: string | null;
	/** Where the caret goes once the box shows a script (a console line chosen). */
	goTo: { tab: ScriptTab; line: number; serial: number } | null;
};

export type JsPane = {
	store: PaneStore<JsState>;
	format: FormatSlot;
	change(text: string): void;
	/** The Component tab's Consent category or Libraries changed: saved at once with its script. */
	changeSettings(settings: ScriptSettings): void;
	show(tab: ScriptTab): void;
	run(): Promise<void>;
	/** Opens the script a console line came from, the caret on its line. */
	open(line: ConsoleLine): void;
	/** The script a console line came from, by its address: its tab, if it is one of the page's. */
	scriptOf(source: string | null): ScriptTab | null;
	choose(choice: "reload" | "overwrite" | "cancel"): void;
	flush(): Promise<void>;
	/** ⌘S: saves what was typed at once, and says so once it is in the Draft. */
	saveNow(): Promise<void>;
	/** Selects a Placement on the page by its Structure reference (a console line's, BA-32). */
	showPlacement(ref: string): void;
	destroy(): void;
};

const EMPTY: Record<ScriptTab, string> = { page: "", site: "", component: "" };
const CLEAN: Record<ScriptTab, boolean> = { page: false, site: false, component: false };

const IDLE: JsState = {
	status: "idle",
	path: null,
	source: null,
	scripts: null,
	tab: "page",
	texts: EMPTY,
	dirty: CLEAN,
	settings: null,
	saving: false,
	running: false,
	conflict: null,
	failure: null,
	goTo: null,
};

/** How long after typing stops a script is saved, in milliseconds. */
const SAVE_AFTER_MS = 800;

/** The tabs a page's scripts have: the page's own when it shows an Entry, the Component's inside a Placement. */
export function tabsOf(scripts: Scripts | null): ScriptTab[] {
	if (!scripts) return ["page", "site"];
	return [...(scripts.page ? (["page"] as const) : []), "site", ...(scripts.component ? (["component"] as const) : [])];
}

export function createJsPane(deps: () => CodePanesDeps, request: CodeRequests): JsPane {
	const store = paneStore<JsState>(IDLE);
	const words = () => deps().words;
	let saveTimer: number | undefined;
	let loadRun = 0;
	let saving: Promise<void> | null = null;
	let serial = 0;
	/** The Undo history's place, held from the first keystroke of typing until its save is over. */
	let holding: SaveWatch | null = null;
	const hold = () => {
		if (holding) return;
		const title = words().code.js.console;
		holding = deps().history.watch({ label: title, field: "", title });
	};
	const release = () => {
		const held = holding;
		holding = null;
		held?.settle();
	};
	const unregisters = new Map<string, () => void>();
	/** What was typed and not saved (or a conflict waiting) on pages the frame no longer shows, by page. */
	const kept = new Map<string, JsState>();
	const unsaved = (state: JsState) => Object.values(state.dirty).some(Boolean) || state.conflict !== null;

	const load = async (path: string, ref: string | null) => {
		const asked = ++loadRun;
		store.set((state) => ({ status: state.scripts && state.path === path ? state.status : "loading" }));
		// Asked for the source the selection is in: Code mode reads no branch or command reference.
		const answer = await request<Scripts>("code/scripts", { path, ref: ref === null ? null : codeRefOf(ref) });
		if (asked !== loadRun) return;
		if (!answer.ok) {
			store.set({ status: "failed", failure: fill(words().code.notRead, { reason: answer.code }) });
			return;
		}
		const scripts = answer.data;
		store.set((state) => {
			const keepComponent =
				state.dirty.component && state.scripts?.component?.componentId === scripts.component?.componentId;
			const texts = {
				page: state.dirty.page ? state.texts.page : (scripts.page?.code ?? ""),
				site: state.dirty.site ? state.texts.site : scripts.site.code,
				component: keepComponent ? state.texts.component : (scripts.component?.code ?? ""),
			};
			const tabs = tabsOf(scripts);
			return {
				status: "ready",
				scripts,
				texts,
				settings: keepComponent ? state.settings : settingsOf(scripts.component),
				tab: tabs.includes(state.tab) ? state.tab : (tabs[0] ?? "site"),
				failure: null,
			};
		});
	};

	const follow = () => {
		const path = deps().path();
		const selection = deps().structure.snapshot().selection;
		const state = store.get();
		if (path !== state.path) {
			if (state.path && state.status === "ready" && unsaved(state))
				kept.set(state.path, { ...state, saving: false, running: false, goTo: null });
			const was = path ? kept.get(path) : undefined;
			if (path && was) {
				// Back on a page with something unsaved: as it was, read at the versions it was typed over.
				kept.delete(path);
				store.set(was);
				if (!was.conflict && Object.values(was.dirty).some(Boolean)) {
					window.clearTimeout(saveTimer);
					saveTimer = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
				}
				return;
			}
			store.set({ ...IDLE, path });
			if (path && selection) void load(path, selection.ref);
			return;
		}
		if (!path || !selection) return;
		const source = sourceOf(selection.ref);
		if (state.status === "idle" || source !== state.source) {
			store.set({ source });
			void load(path, selection.ref);
		}
	};

	const save = async (tab: ScriptTab, version?: string | null) => {
		const state = store.get();
		const path = state.path;
		const scripts = state.scripts;
		if (!path || !scripts || !state.dirty[tab]) return;
		const code = state.texts[tab];
		const settings = tab === "component" ? (state.settings ?? settingsOf(scripts.component)) : null;
		const body =
			tab === "component"
				? scripts.component && settings
					? {
							path,
							kind: "component",
							componentId: scripts.component.componentId,
							code,
							...settings,
							version: version === undefined ? scripts.component.version : version,
						}
					: null
				: tab === "page"
					? scripts.page
						? { path, kind: "page", code, version: version === undefined ? scripts.page.version : version }
						: null
					: { path, kind: "site", code, version: version === undefined ? scripts.site.version : version };
		if (!body) return;
		const was = tab === "component" ? scripts.component : tab === "page" ? scripts.page : scripts.site;
		const before: Step = {
			code: was?.code ?? "",
			version: was?.version ?? null,
			...(tab === "component" ? settingsOf(scripts.component) : {}),
		};
		store.set({ saving: true });
		const answer = await request<CodeScript>("code/saveScript", body);
		store.set({ saving: false });
		// The frame shows another page now: what was asked is told to that page's kept state.
		if (store.get().path !== path) {
			const left = kept.get(path);
			if (answer.ok) {
				recordStep(tab, scripts, before, { code, version: answer.data.version, ...(settings ?? {}) });
				if (left) kept.set(path, savedInto(left, tab, code, answer.data, settings));
			} else if (left && answer.code === "CHANGED_MEANWHILE") {
				const newer = answer.data.version;
				kept.set(path, { ...left, conflict: { tab, version: typeof newer === "string" ? newer : null } });
			}
			return;
		}
		if (!answer.ok) {
			if (answer.code === "CHANGED_MEANWHILE") {
				const newer = answer.data.version;
				store.set({ conflict: { tab, version: typeof newer === "string" ? newer : null } });
				return;
			}
			store.set({ failure: fill(words().code.notSaved, { reason: answer.code }) });
			deps().announce(fill(words().code.notSaved, { reason: answer.code }), true);
			return;
		}
		const saved = answer.data;
		recordStep(tab, scripts, before, { code, version: saved.version, ...(settings ?? {}) });
		store.set((now) => savedInto(now, tab, code, saved, settings));
	};

	const flush = async () => {
		window.clearTimeout(saveTimer);
		// One save at a time: several waiting (quick Library ticks) each go in turn, never two at once.
		while (saving) await saving;
		const mine = (async () => {
			for (const tab of ["site", "page", "component"] as const) await save(tab);
		})();
		saving = mine;
		try {
			await mine;
		} finally {
			if (saving === mine) saving = null;
			release();
			// Typed while the save was under way: the history waits for that too.
			const dirty = store.get().dirty;
			if (dirty.site || dirty.page || dirty.component) hold();
		}
	};

	/** Which script a step is of, as the history names its Draft: the Site's, a page's, a Component's. */
	const resourceOf = (tab: ScriptTab, scripts: Scripts): string | null =>
		tab === "site"
			? "script:site"
			: tab === "page"
				? scripts.page
					? `script:page:${scripts.page.entryId}`
					: null
				: scripts.component
					? `script:component:${scripts.component.componentId}`
					: null;

	/** One save as one Undo step: the code before it and after it, with the versions they were saved at. */
	const recordStep = (tab: ScriptTab, scripts: Scripts, before: Step, after: Step) => {
		const resource = resourceOf(tab, scripts);
		const path = store.get().path;
		if (!resource || !path || sameStep(before, after)) return;
		const said = words().code.js.steps;
		const label = tab === "component" ? fill(said.component, { name: scripts.component?.name ?? "" }) : said[tab];
		const target =
			tab === "component" && scripts.component
				? { kind: "component" as const, componentId: scripts.component.componentId }
				: { kind: tab as "site" | "page" };
		if (!unregisters.has(resource))
			unregisters.set(resource, deps().history.register(resource, portOf(resource, target, path)));
		editorHistory().record({
			resource,
			before: before as unknown as Json,
			after: after as unknown as Json,
			label,
			location: { siteId: deps().config.site.id, panel: "js", title: label },
		});
	};

	/**
	 * How a script's step is taken back (or made again): the code it goes back to, saved over the version
	 * the step left. A version someone saved since makes the step obsolete; the box follows when it shows
	 * that script and nothing is typed in it.
	 */
	const portOf = (
		resource: string,
		target: { kind: "site" | "page" } | { kind: "component"; componentId: string },
		path: string,
	) => ({
		async reverse(from: Json, to: Json): Promise<HistoryResult> {
			const now = from as unknown as Step;
			const wanted = to as unknown as Step;
			const settings = target.kind === "component" ? stepSettings(wanted) : null;
			const answer = await request<CodeScript>("code/saveScript", {
				path,
				...target,
				code: wanted.code,
				...(settings ?? {}),
				version: now.version,
			});
			if (!answer.ok) {
				if (answer.code === "CHANGED_MEANWHILE") return { ok: false, code: "HISTORY_OBSOLETE" };
				return { ok: false, code: answer.code === "network" ? "HISTORY_UNAVAILABLE" : answer.code };
			}
			const saved = answer.data;
			store.set((state) => {
				const scripts = state.scripts;
				if (!scripts) return {};
				const tab = (["site", "page", "component"] as const).find((each) => resourceOf(each, scripts) === resource);
				if (!tab) return {};
				const next = { ...scripts } as Scripts;
				if (tab === "site") next.site = { ...next.site, ...saved };
				else if (tab === "page" && next.page) next.page = { ...next.page, ...saved };
				else if (tab === "component" && next.component) next.component = { ...next.component, ...saved };
				return {
					scripts: next,
					texts: state.dirty[tab] ? state.texts : { ...state.texts, [tab]: wanted.code },
					...(tab === "component" && settings && !state.dirty.component ? { settings } : {}),
				};
			});
			return {
				ok: true,
				before: now as unknown as Json,
				after: { ...wanted, version: saved.version } as unknown as Json,
			};
		},
	});

	const scriptOf = (source: string | null): ScriptTab | null => {
		const scripts = store.get().scripts;
		if (!source || !scripts) return null;
		const path = (() => {
			try {
				return new URL(source, window.location.href).pathname;
			} catch {
				return source;
			}
		})();
		if (scripts.site.src && path === scripts.site.src) return "site";
		if (scripts.page?.src && path === scripts.page.src) return "page";
		if (scripts.component?.src && path === scripts.component.src) return "component";
		return null;
	};

	const unsubscribe = deps().structure.subscribe(follow);
	follow();

	return {
		store,
		format: formatSlot(),
		change(text) {
			const state = store.get();
			const tab = state.tab;
			if (tab === "component" && !state.scripts?.component?.editable) return;
			store.set({ texts: { ...state.texts, [tab]: text }, dirty: { ...state.dirty, [tab]: true }, failure: null });
			hold();
			window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
		},
		changeSettings(settings) {
			const state = store.get();
			if (!state.scripts?.component?.editable) return;
			store.set({ settings, dirty: { ...state.dirty, component: true }, failure: null });
			hold();
			// A choice is made at once: it is saved now, with what is typed in the box.
			void flush();
		},
		show(tab) {
			store.set({ tab });
		},
		async run() {
			const state = store.get();
			const frame = deps().frame.current;
			if (state.running || !frame || !state.scripts) return;
			store.set({ running: true });
			try {
				await flush();
				if (store.get().conflict) return;
				// A Component script with new code: its Placements drawn afresh wait for the new code rather
				// than getting the old one's call first (WebCraft's runtime forgets it, BA-32).
				const before = frame.page();
				const changed = store.get().scripts?.component;
				if (before && changed?.src && !before.querySelector(`script[src="${CSS.escape(changed.src)}"]`)) {
					const runtime = (
						before.defaultView as { webcraft?: { componentScript?: { forget?(id: string): void } } } | null
					)?.webcraft?.componentScript;
					runtime?.forget?.(changed.componentId);
				}
				// A fresh page, drawn from the Drafts: nothing of the scripts that ran before stays on it.
				await frame.rerender();
				const page = frame.page();
				const scripts = store.get().scripts;
				if (!page || !scripts) return;
				for (const old of page.querySelectorAll("script[data-wc-run]:not([type=module])")) old.remove();
				const loaded = new Set(
					[...page.querySelectorAll<HTMLScriptElement>("script[type=module][data-wc-component-script]")].map(
						(tag) => tag.getAttribute("src") ?? "",
					),
				);
				const tags: HTMLScriptElement[] = [];
				const add = (src: string, module = false) => {
					const tag = page.createElement("script");
					if (module) tag.type = "module";
					tag.async = false;
					tag.src = src;
					tag.dataset.wcRun = "";
					tags.push(tag);
					return tag;
				};
				if (scripts.site.src) add(scripts.site.src);
				const component = scripts.component;
				if (component?.src && !loaded.has(component.src)) {
					if (!page.querySelector(`script[src="${component.runtime}"]`)) add(component.runtime).dataset.wcWatch = "";
					const loader = add(component.src, true);
					loader.dataset.wcComponentScript = component.componentId;
					// Named, so a call of it that fails says whose it is (the notice, the console).
					loader.dataset.wcComponentName = component.name;
				}
				if (scripts.page?.src) add(scripts.page.src);
				page.head.append(...tags);
				deps().announce(words().code.js.ran);
			} finally {
				store.set({ running: false });
			}
		},
		open(line) {
			const tab = scriptOf(line.source);
			if (!tab) return;
			store.set({ tab, goTo: { tab, line: line.line ?? 1, serial: ++serial } });
		},
		scriptOf,
		choose(choice) {
			const conflict = store.get().conflict;
			store.set({ conflict: null });
			if (!conflict) return;
			if (choice === "overwrite") void save(conflict.tab, conflict.version);
			else if (choice === "reload") {
				store.set((state) => ({ dirty: { ...state.dirty, [conflict.tab]: false } }));
				const path = store.get().path;
				const selection = deps().structure.snapshot().selection;
				if (path) {
					const scripts = store.get().scripts;
					// What was typed is dropped: the Draft as it is now.
					if (scripts) store.set((state) => ({ texts: { ...state.texts, [conflict.tab]: "" } }));
					void load(path, selection?.ref ?? null);
				}
			}
		},
		flush,
		showPlacement(ref) {
			deps().structure.select(ref);
		},
		async saveNow() {
			await flush();
			const now = store.get();
			if (now.status === "ready" && !now.dirty[now.tab] && !now.conflict && !now.failure)
				deps().announce(fill(words().code.js.saved, { script: scriptTitle(words(), now.tab) }));
		},
		destroy() {
			window.clearTimeout(saveTimer);
			release();
			for (const unregister of unregisters.values()) unregister();
			unsubscribe();
		},
	};
}

/** A script's step in the history: its code and version, and a Component script's settings. */
type Step = { code: string; version: string | null } & Partial<ScriptSettings>;

/** The settings a step carries, if it is a Component script's. */
function stepSettings(step: Step): ScriptSettings | null {
	return step.consentCategory && step.libraryIds
		? { consentCategory: step.consentCategory, libraryIds: step.libraryIds }
		: null;
}

/** Whether a save changed nothing a step would take back: the same code, and the same settings. */
function sameStep(before: Step, after: Step): boolean {
	const one = stepSettings(before);
	const other = stepSettings(after);
	return before.code === after.code && (!one || !other || sameSettings(one, other));
}

/** A Component script's settings as its Draft has them. */
function settingsOf(component: ComponentScript | null | undefined): ScriptSettings | null {
	return component ? { consentCategory: component.consentCategory, libraryIds: [...component.libraryIds] } : null;
}

/**
 * A pane's state once `code` (and a Component script's `settings`) was saved to the script of `tab`: its
 * new version, and dirty only if typed or changed since.
 */
function savedInto(
	now: JsState,
	tab: ScriptTab,
	code: string,
	saved: CodeScript,
	settings: ScriptSettings | null,
): JsState {
	const next = { ...now.scripts } as Scripts;
	if (tab === "site") next.site = { ...next.site, ...saved };
	else if (tab === "page" && next.page) next.page = { ...next.page, ...saved };
	else if (tab === "component" && next.component) next.component = { ...next.component, ...saved };
	const typedSince =
		now.texts[tab] !== code || Boolean(settings && now.settings && !sameSettings(now.settings, settings));
	return { ...now, scripts: next, dirty: { ...now.dirty, [tab]: typedSince }, failure: null };
}

/** A script's title: "Page script", "Site script", "Component script". */
export function scriptTitle(words: Words, tab: ScriptTab): string {
	return words.code.js.titles[tab];
}

/** The JS pane's header controls: Page, Site (and Component) as one switch, then Format (`builder/02`). */
export function JsActions({ pane, words }: { pane: JsPane; words: Words }) {
	const state = usePane(pane.store);
	const shown = words.code.js;
	const tabs = tabsOf(state.scripts);
	return (
		<>
			<fieldset
				className="bg-chrome-raised m-0 flex h-6 min-w-0 shrink-0 items-center rounded-[6px] border-0 p-0.5"
				data-wc-script-tabs=""
			>
				<legend className="sr-only">{shown.tabs}</legend>
				{tabs.map((tab) => (
					<button
						key={tab}
						type="button"
						aria-pressed={state.tab === tab}
						onClick={() => pane.show(tab)}
						className={`h-5 rounded-[4px] px-2 text-[11px] font-medium ${
							state.tab === tab ? "bg-chrome-hover text-chrome-strong" : "text-chrome-muted hover:text-chrome-strong"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-script-tab={tab}
					>
						{shown.tabNames[tab]}
					</button>
				))}
			</fieldset>
			<FormatButton slot={pane.format} words={words} />
		</>
	);
}

/** The JS pane's body: the box, its line, then Run and the console. */
export function JsBody({ pane, words, settings }: { pane: JsPane; words: Words; settings: PaneSettings }) {
	const state = usePane(pane.store);
	const area = useRef<HTMLTextAreaElement>(null);
	const noteId = useId();
	const shown = words.code.js;
	const tab = state.tab;
	const component = state.scripts?.component ?? null;
	const editable =
		state.status === "ready" &&
		(tab === "site" ||
			(tab === "page" && Boolean(state.scripts?.page)) ||
			(tab === "component" && Boolean(component?.editable)));
	const text = state.texts[tab];
	const formatting = useBoxFormat("js", area, text, editable);
	useFormatSlot(pane.format, formatting, editable);
	const lines = useSyncExternalStore(consoleLog.subscribe, consoleLog.lines);
	const shownLines = state.path ? lines.filter((line) => line.page.split("?")[0] === state.path) : lines;
	const errors = shownLines.filter((line) => line.level === "error").length;
	const log = useRef<HTMLDivElement>(null);

	// A console line chosen: its script shows with the caret on its line.
	useEffect(() => {
		const wanted = state.goTo;
		const element = area.current;
		if (!wanted || wanted.tab !== tab || !element) return;
		const at = offsetAt(element.value, wanted.line);
		element.focus();
		element.setSelectionRange(at, at);
	}, [state.goTo, tab]);
	// The newest line stays in view.
	useEffect(() => {
		const list = log.current;
		if (list && shownLines.length) list.scrollTop = list.scrollHeight;
	}, [shownLines.length]);

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (formatting.onKeyDown(event)) return;
		// ⌘S / Ctrl+S saves at once (BA-32), as in the HTML pane: never the browser's Save page.
		if (
			matches(event.nativeEvent, "editor.save") ||
			((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s")
		) {
			event.preventDefault();
			void pane.saveNow();
		}
	};
	const note =
		tab === "component" && component
			? !component.editable
				? fill(words.structure.readOnly, { name: component.name })
				: component.pages > 1
					? fill(shown.usedOn, { name: component.name, count: String(component.pages) })
					: shown.help
			: tab === "page" && !state.scripts?.page
				? shown.noPage
				: state.saving
					? words.code.saving
					: shown.help;

	const scriptSettings = state.settings ?? settingsOf(component);
	return (
		<div className="flex min-h-0 grow flex-col gap-1" data-wc-js-pane={state.status} data-wc-script={tab}>
			{state.status === "ready" && tab === "component" && component?.editable && scriptSettings ? (
				<ScriptSettingsRow
					words={words}
					settings={scriptSettings}
					libraries={component.libraries}
					onChange={(next) => pane.changeSettings(next)}
				/>
			) : null}
			{state.status === "ready" ? (
				<CodeWell
					ref={area}
					language="js"
					value={text}
					onChange={(next) => pane.change(next)}
					onKeyDown={onKeyDown}
					onBlur={() => {
						if (!pane.store.get().dirty[pane.store.get().tab]) return;
						void (async () => {
							const now = pane.store.get();
							const tidied =
								settings.formatOnLeave && editable ? await formattedOnLeaving(now.texts[now.tab], "js") : null;
							if (tidied) pane.change(tidied);
							await pane.flush();
						})();
					}}
					label={scriptTitle(words, tab)}
					describedBy={noteId}
					problems={formatting.problemLine ? [formatting.problemLine] : []}
					readOnly={!editable}
					wrap={settings.wrap}
					data={{ "data-wc-code-box": "js" }}
				/>
			) : (
				<p className="text-chrome-muted m-0 p-3 text-[12px]" role="status">
					{state.status === "failed" ? state.failure : shown.loading}
				</p>
			)}
			<NoteLine
				id={noteId}
				format={formatting}
				words={words}
				problem={state.failure && state.status === "ready" ? { text: state.failure } : null}
				help={note}
			/>
			<section
				aria-label={shown.console}
				className="border-chrome-line flex max-h-[45%] min-h-[64px] shrink-0 flex-col border-t"
				data-wc-console=""
			>
				<div className="flex h-7 shrink-0 items-center gap-1.5 px-1">
					<h3 className="text-chrome-strong m-0 text-[11px] font-semibold">{shown.console}</h3>
					<span className="text-chrome-muted text-[11px]">
						{errors === 0 ? "" : errors === 1 ? shown.oneError : fill(shown.errors, { count: String(errors) })}
					</span>
					<span className="grow" />
					<span className="group relative inline-flex">
						<button
							type="button"
							aria-label={shown.clear}
							onClick={() => consoleLog.clear()}
							className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-6 place-items-center rounded-[5px] ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-console-clear=""
						>
							<TrashIcon aria-hidden="true" className="size-3.5" />
						</button>
						<Tip label={shown.clear} side="top" align="end" />
					</span>
					<button
						type="button"
						onClick={() => void pane.run()}
						disabled={state.status !== "ready"}
						aria-busy={state.running ? true : undefined}
						className={`bg-chrome-raised text-chrome-strong hover:bg-chrome-hover inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-[11px] font-semibold disabled:opacity-60 ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-run=""
					>
						<PlayIcon aria-hidden="true" className="size-3" />
						{state.running ? shown.running : shown.run}
					</button>
				</div>
				<div
					ref={log}
					role="log"
					aria-label={shown.console}
					className="min-h-0 grow overflow-y-auto font-mono text-[11px] leading-[18px]"
					data-wc-console-lines=""
				>
					<ul className="m-0 flex list-none flex-col p-0">
						{shownLines.length === 0 ? (
							<li className="text-chrome-muted px-1.5 font-sans">{shown.empty}</li>
						) : (
							shownLines.map((line) => <ConsoleRow key={line.id} line={line} pane={pane} words={words} />)
						)}
					</ul>
				</div>
			</section>
			{state.conflict ? (
				<ConflictDialog
					words={words}
					text={fill(words.code.conflict.text, { name: scriptTitle(words, state.conflict.tab) })}
					onChoose={(choice) => pane.choose(choice)}
				/>
			) : null}
		</div>
	);
}

/** One line of the console: its level, what it says, and the script and line it came from. */
function ConsoleRow({ line, pane, words }: { line: ConsoleLine; pane: JsPane; words: Words }) {
	const shown = words.code.js;
	if (line.component) return <ComponentLine line={line} component={line.component} pane={pane} words={words} />;
	const tab = pane.scriptOf(line.source);
	const script = tab
		? scriptTitle(words, tab)
		: line.source
			? (() => {
					try {
						return new URL(line.source, window.location.href).pathname;
					} catch {
						return line.source;
					}
				})()
			: null;
	const where = script ? (line.line ? fill(shown.at, { script, line: String(line.line) }) : script) : null;
	const text = line.text || (script ? fill(shown.didNotLoad, { script }) : "");
	const Glyph = line.level === "error" ? CircleAlertIcon : line.level === "warn" ? TriangleAlertIcon : InfoIcon;
	return (
		<li
			className={`border-chrome-line flex items-start gap-1.5 border-b px-1.5 py-0.5 ${
				line.level === "error" ? "text-red-200" : line.level === "warn" ? "text-chrome-warn" : "text-chrome-text"
			}`}
			data-wc-console-line={line.level}
			data-wc-console-script={tab ?? ""}
		>
			<Glyph aria-hidden="true" className="mt-[3px] size-3 flex-none" />
			<span className="sr-only">{shown.levels[line.level]}</span>
			<span className="min-w-0 grow break-words whitespace-pre-wrap">{text}</span>
			{where ? (
				tab ? (
					<button
						type="button"
						onClick={() => pane.open(line)}
						className={`text-chrome-accent shrink-0 rounded-sm font-sans underline-offset-2 hover:underline ${FOCUS_RING}`}
						data-wc-console-where=""
					>
						{where}
					</button>
				) : (
					<span className="text-chrome-muted shrink-0 font-sans">{where}</span>
				)
			) : null}
		</li>
	);
}

/**
 * A Component script's call that failed on a Placement (BA-32): "{name} failed on a Placement: …",
 * against its Component script, with the Placement a click away on Staff's page (it is selected).
 */
function ComponentLine({
	line,
	component,
	pane,
	words,
}: {
	line: ConsoleLine;
	component: { id: string; name: string };
	pane: JsPane;
	words: Words;
}) {
	const shown = words.code.js;
	const placement = line.placement ?? null;
	return (
		<li
			className="border-chrome-line flex items-start gap-1.5 border-b px-1.5 py-0.5 text-red-200"
			data-wc-console-line="error"
			data-wc-console-script="component"
			data-wc-console-component={component.id}
		>
			<CircleAlertIcon aria-hidden="true" className="mt-[3px] size-3 flex-none" />
			<span className="sr-only">{shown.levels.error}</span>
			<span className="min-w-0 grow break-words whitespace-pre-wrap">
				{fill(shown.componentError, { name: component.name, message: line.text })}
			</span>
			{placement ? (
				<button
					type="button"
					onClick={() => pane.showPlacement(placement)}
					className={`text-chrome-accent shrink-0 rounded-sm font-sans underline-offset-2 hover:underline ${FOCUS_RING}`}
					data-wc-console-placement=""
				>
					{shown.showPlacement}
				</button>
			) : null}
		</li>
	);
}

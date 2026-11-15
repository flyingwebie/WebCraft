import { CircleAlertIcon, InfoIcon, PlayIcon, TrashIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useRef, useSyncExternalStore } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { sourceOf } from "../editing/selection.ts";
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
 * with the caret on the line.
 */

export type ScriptTab = "page" | "site" | "component";

type CodeScript = { code: string; version: string | null; src: string | null };
type ComponentScript = CodeScript & {
	componentId: string;
	name: string;
	editable: boolean;
	pages: number;
	runtime: string;
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
	show(tab: ScriptTab): void;
	run(): Promise<void>;
	/** Opens the script a console line came from, the caret on its line. */
	open(line: ConsoleLine): void;
	/** The script a console line came from, by its address: its tab, if it is one of the page's. */
	scriptOf(source: string | null): ScriptTab | null;
	choose(choice: "reload" | "overwrite" | "cancel"): void;
	flush(): Promise<void>;
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

	const load = async (path: string, ref: string | null) => {
		const asked = ++loadRun;
		store.set((state) => ({ status: state.scripts && state.path === path ? state.status : "loading" }));
		const answer = await request<Scripts>("code/scripts", { path, ref });
		if (asked !== loadRun) return;
		if (!answer.ok) {
			store.set({ status: "failed", failure: fill(words().code.notRead, { reason: answer.code }) });
			return;
		}
		const scripts = answer.data;
		store.set((state) => {
			const texts = {
				page: state.dirty.page ? state.texts.page : (scripts.page?.code ?? ""),
				site: state.dirty.site ? state.texts.site : scripts.site.code,
				component:
					state.dirty.component && state.scripts?.component?.componentId === scripts.component?.componentId
						? state.texts.component
						: (scripts.component?.code ?? ""),
			};
			const tabs = tabsOf(scripts);
			return {
				status: "ready",
				scripts,
				texts,
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
		const body =
			tab === "component"
				? scripts.component
					? {
							path,
							kind: "component",
							componentId: scripts.component.componentId,
							code,
							version: version === undefined ? scripts.component.version : version,
						}
					: null
				: tab === "page"
					? scripts.page
						? { path, kind: "page", code, version: version === undefined ? scripts.page.version : version }
						: null
					: { path, kind: "site", code, version: version === undefined ? scripts.site.version : version };
		if (!body) return;
		store.set({ saving: true });
		const answer = await request<CodeScript>("code/saveScript", body);
		store.set({ saving: false });
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
		store.set((now) => {
			const next = { ...now.scripts } as Scripts;
			if (tab === "site") next.site = { ...next.site, ...saved };
			else if (tab === "page" && next.page) next.page = { ...next.page, ...saved };
			else if (tab === "component" && next.component) next.component = { ...next.component, ...saved };
			const typedSince = now.texts[tab] !== code;
			return { scripts: next, dirty: { ...now.dirty, [tab]: typedSince }, failure: null };
		});
	};

	const flush = async () => {
		window.clearTimeout(saveTimer);
		if (saving) await saving;
		saving = (async () => {
			for (const tab of ["site", "page", "component"] as const) await save(tab);
		})();
		try {
			await saving;
		} finally {
			saving = null;
		}
	};

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
			window.clearTimeout(saveTimer);
			saveTimer = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
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
					if (!page.querySelector(`script[src="${component.runtime}"]`)) add(component.runtime);
					add(component.src, true).dataset.wcComponentScript = component.componentId;
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
		destroy() {
			window.clearTimeout(saveTimer);
			unsubscribe();
		},
	};
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
		formatting.onKeyDown(event);
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

	return (
		<div className="flex min-h-0 grow flex-col gap-1" data-wc-js-pane={state.status} data-wc-script={tab}>
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

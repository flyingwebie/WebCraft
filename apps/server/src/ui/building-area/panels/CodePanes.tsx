import { CopyIcon, Maximize2Icon, Minimize2Icon } from "lucide-react";

import type { ReactNode } from "react";
import { LAYOUT_VERSION } from "../docks/layout.ts";
import type { MenuEntry } from "../docks/Menu.tsx";
import type { PanelKey } from "../docks/panels.ts";
import { managementApi } from "../management.ts";
import { CssActions, CssBody, type CssPane, createCssPane } from "./CssPane.tsx";
import type { CodePaneParts, CodePanesDeps, CodePanesInstance, PaneUi } from "./code-panes.tsx";
import { codeRequests } from "./code-requests.ts";
import { createHtmlPane, HtmlActions, HtmlBody, type HtmlPane } from "./HtmlPane.tsx";
import { createJsPane, JsActions, JsBody, type JsPane, scriptTitle } from "./JsPane.tsx";
import { ExpandButton, type PaneSettings } from "./pane-parts.tsx";
import { type PaneStore, paneStore, usePane } from "./pane-store.ts";

/**
 * The code panes' own file (BA-11), fetched the first time something is selected (`code-panes.tsx`):
 * the HTML, CSS and JS panes made once for the shell's life, their settings, and what each gives the
 * docks (its body, its header's controls, the words beside its title and its menu: Expand, Copy all,
 * "Format when I leave the box" and "Wrap long lines", `builder/10`).
 */

type Panes = CodePanesInstance & {
	html: HtmlPane;
	css: CssPane;
	js: JsPane;
	settings: PaneStore<PaneSettings>;
	words(): CodePanesDeps["words"];
	setFormatOnLeave(on: boolean): void;
	announce(text: string, urgent?: boolean): void;
};

/** What the headers and menus show, as one value that changes only when one of them does. */
type Header = {
	settings: PaneSettings;
	jsTab: string;
	htmlText: () => string;
	cssText: () => string;
	jsText: () => string;
};

/** Where "Wrap long lines" is kept: in this browser (a convenience; the person's preferences hold no key for it). */
const WRAP_KEY = "webcraft.building.wrapCode";
/** Where the HTML pane's "Only the selected element" is kept, the same way (FX-02). */
const ELEMENT_ONLY_KEY = "webcraft.building.htmlElementOnly";

/** A switch kept in this browser: on unless it was turned off. */
function storedSwitch(key: string): boolean {
	try {
		return localStorage.getItem(key) !== "off";
	} catch {
		return true;
	}
}

function keepSwitch(key: string, on: boolean): void {
	try {
		localStorage.setItem(key, on ? "on" : "off");
	} catch {
		// Kept for this visit.
	}
}

export function createCodePanes(deps: () => CodePanesDeps): Panes {
	const request = codeRequests(deps().config.token);
	const settings = paneStore<PaneSettings>({
		wrap: storedSwitch(WRAP_KEY),
		formatOnLeave: deps().config.formatOnLeave,
		elementOnly: storedSwitch(ELEMENT_ONLY_KEY),
	});
	const html = createHtmlPane(deps, request, () => settings.get().elementOnly);
	const css = createCssPane(deps);
	const js = createJsPane(deps, request);
	// "Only the selected element" switched: the HTML pane shows the selection again, the other way.
	let elementOnly = settings.get().elementOnly;
	const reshown = settings.subscribe(() => {
		if (settings.get().elementOnly === elementOnly) return;
		elementOnly = settings.get().elementOnly;
		html.reshow();
	});

	// The header state: a new value only when the settings or the JS pane's script change.
	let header: Header | null = null;
	const listeners = new Set<() => void>();
	const headerNow = (): Header => {
		const jsTab = js.store.get().tab;
		const now = settings.get();
		if (!header || header.settings !== now || header.jsTab !== jsTab) {
			header = {
				settings: now,
				jsTab,
				htmlText: () => html.store.get().text,
				cssText: () => css.store.get().text,
				jsText: () => js.store.get().texts[js.store.get().tab],
			};
		}
		return header;
	};
	const tell = () => {
		const before = header;
		if (headerNow() !== before) for (const listener of listeners) listener();
	};
	const stops = [settings.subscribe(tell), js.store.subscribe(tell), reshown];

	return {
		html,
		css,
		js,
		settings,
		words: () => deps().words,
		announce: (text, urgent) => deps().announce(text, urgent),
		header: headerNow,
		subscribeHeader(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		setFormatOnLeave(on) {
			settings.set({ formatOnLeave: on });
			const { config, words } = deps();
			managementApi(config.token)
				.me.saveEditorPreferences({
					siteId: config.site.id,
					preferences: { version: LAYOUT_VERSION, formatOnLeave: on },
				})
				.catch(() => deps().announce(words.code.preferenceFailed, true));
		},
		async flush() {
			await Promise.all([html.save(), css.flush(), js.flush()]);
		},
		destroy() {
			for (const stop of stops) stop();
			html.destroy();
			css.destroy();
			js.destroy();
		},
	};
}

/** Each pane's parts for the docks, from the panes' header state now. */
export function paneParts(instance: CodePanesInstance, ui: PaneUi): CodePaneParts {
	const panes = instance as Panes;
	const words = panes.words();
	const header = panes.header() as Header;
	const { settings } = header;

	const expand = (id: PanelKey) => (
		<ExpandButton wide={ui.wide === id} onToggle={() => ui.setWide(ui.wide === id ? null : id)} words={words} />
	);
	const menu = (id: PanelKey, text: () => string, own: readonly MenuEntry[] = []): MenuEntry[] => [
		...own,
		{
			kind: "item",
			key: "wide",
			icon: ui.wide === id ? Minimize2Icon : Maximize2Icon,
			label: ui.wide === id ? words.code.restore : words.code.expand,
			onSelect: () => ui.setWide(ui.wide === id ? null : id),
		},
		{
			kind: "item",
			key: "copy",
			icon: CopyIcon,
			label: words.code.copyAll,
			onSelect: () => {
				navigator.clipboard
					.writeText(text())
					.then(() => panes.announce(words.code.copied))
					.catch(() => panes.announce(words.code.copyFailed, true));
			},
		},
		{ kind: "separator", key: "settings" },
		{
			kind: "switch",
			key: "format-on-leave",
			label: words.code.formatOnLeave,
			checked: settings.formatOnLeave,
			onToggle: () => panes.setFormatOnLeave(!panes.settings.get().formatOnLeave),
		},
		{
			kind: "switch",
			key: "wrap",
			label: words.code.wrap,
			checked: settings.wrap,
			onToggle: () => {
				const wrap = !panes.settings.get().wrap;
				panes.settings.set({ wrap });
				keepSwitch(WRAP_KEY, wrap);
			},
		},
	];

	return {
		bodies: {
			html: <Settled panes={panes} render={(now) => <HtmlBody pane={panes.html} words={words} settings={now} />} />,
			css: <Settled panes={panes} render={(now) => <CssBody pane={panes.css} words={words} settings={now} />} />,
			js: <Settled panes={panes} render={(now) => <JsBody pane={panes.js} words={words} settings={now} />} />,
		},
		actions: {
			html: (
				<>
					<HtmlActions pane={panes.html} words={words} />
					{expand("html")}
				</>
			),
			css: (
				<>
					<CssActions pane={panes.css} words={words} />
					{expand("css")}
				</>
			),
			js: (
				<>
					<JsActions pane={panes.js} words={words} />
					{expand("js")}
				</>
			),
		},
		subs: {
			html: ui.selectionName,
			css: "",
			js: scriptTitle(words, panes.js.store.get().tab),
		},
		menus: {
			html: menu("html", header.htmlText, [
				{
					kind: "switch",
					key: "element-only",
					label: words.code.html.elementOnly,
					checked: settings.elementOnly,
					onToggle: () => {
						const elementOnly = !panes.settings.get().elementOnly;
						panes.settings.set({ elementOnly });
						keepSwitch(ELEMENT_ONLY_KEY, elementOnly);
					},
				},
				{ kind: "separator", key: "element-only-line" },
			]),
			css: menu("css", header.cssText),
			js: menu("js", header.jsText),
		},
	};
}

/** A pane's body with the boxes' settings as they are now. */
function Settled({ panes, render }: { panes: Panes; render(settings: PaneSettings): ReactNode }) {
	const now = usePane(panes.settings);
	return render(now);
}

import { type ComponentType, useEffect, useRef, useState } from "react";

import { matches } from "../../builder/shortcuts.ts";
import type { MenuHost } from "./host.ts";
import { COMMAND_MENU_EVENT, type MenuRequest, type MenuTab } from "./state.ts";

/** The menu's own file, once fetched. */
type MenuComponent = ComponentType<{
	host: MenuHost;
	request: MenuRequest | null;
	onRequest(next: MenuRequest | null): void;
}>;

/** The keys of the tabs a menu has: Members get no Insert. */
const KEYS: readonly [MenuTab, string][] = [
	["actions", "menu.actions"],
	["goTo", "menu.goTo"],
	["insert", "menu.insert"],
];

/**
 * The Command menu's place in the shell (BA-10), in the shell's first file: its keys (⌘K Actions, ⌘P
 * Go to, ⌘I Insert, winning over the code panes; a tab's own key closes it), the requests the page and
 * the insert row send (`COMMAND_MENU_EVENT`), and the menu itself, whose file (`CommandMenu.tsx`) is
 * fetched the first time it opens. Nothing opens it under the narrow-window notice.
 */
export function useCommandMenu(options: { tabs: readonly MenuTab[]; announce(text: string, urgent?: boolean): void }) {
	const [request, setRequest] = useState<MenuRequest | null>(null);
	const latest = useRef({ request, tabs: options.tabs });
	latest.current = { request, tabs: options.tabs };
	useEffect(() => {
		const open = (next: MenuRequest) => {
			if (document.querySelector("[data-wc-narrow]")) return;
			if (!latest.current.tabs.includes(next.tab)) return;
			const now = latest.current.request;
			// A tab's own key closes it; another opens that tab.
			setRequest(now?.tab === next.tab && !next.step && !next.only ? null : next);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.isComposing || event.defaultPrevented) return;
			// Another dialog keeps its own keys (the Media picker, a confirmation).
			if (
				event
					.composedPath()
					.some((each) => each instanceof Element && each.matches("dialog[open]:not([data-wc-command-menu])"))
			)
				return;
			for (const [tab, id] of KEYS) {
				if (!matches(event, id)) continue;
				event.preventDefault();
				event.stopPropagation();
				open({ tab });
				return;
			}
		};
		const onRequest = (event: Event) => {
			const detail = (event as CustomEvent<MenuRequest | null>).detail;
			if (detail?.tab) open(detail);
		};
		window.addEventListener("keydown", onKey, true);
		document.addEventListener(COMMAND_MENU_EVENT, onRequest);
		return () => {
			window.removeEventListener("keydown", onKey, true);
			document.removeEventListener(COMMAND_MENU_EVENT, onRequest);
		};
	}, []);
	return { request, setRequest };
}

/** Draws the menu while it is asked for; fetches its file the first time. */
export function CommandMenuHost({
	host,
	request,
	onRequest,
}: {
	host: MenuHost;
	request: MenuRequest | null;
	onRequest(next: MenuRequest | null): void;
}) {
	const [Menu, setMenu] = useState<MenuComponent | null>(null);
	const asked = useRef(false);
	const announce = useRef(host.announce);
	announce.current = host.announce;
	const failed = host.words.commandMenu.loadFailed;
	useEffect(() => {
		if (!request || Menu || asked.current) return;
		asked.current = true;
		import("./CommandMenu.tsx").then(
			(module) => setMenu(() => module.CommandMenu),
			() => {
				asked.current = false;
				onRequest(null);
				announce.current(failed, true);
			},
		);
	}, [request, Menu, onRequest, failed]);
	return Menu ? <Menu host={host} request={request} onRequest={onRequest} /> : null;
}

import type { Permission } from "@webcraft/core";
import type { AdminLanguageCode } from "@webcraft/core/admin-languages";
import { DialogContainer } from "@webcraft/ui/components/dialog.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import type { BarCommands, BarKit, EditHistory } from "../../site/edit-bar/kit.ts";
import { CommandMenu, type MenuState, ShortcutsDialog, useEditorKeys } from "../builder/CommandMenu.tsx";
import { COMMAND_TABS, type CommandTab, type HistoryTarget } from "../builder/commands.ts";
import { type BuilderTarget, targetPath } from "../builder/model.ts";
import { ariaKeys, matches, withKeys } from "../builder/shortcuts.ts";
import { useEditorAnnouncement } from "../builder/use-editor-announcement.ts";
import { AdminIntl, useT } from "../i18n.tsx";
import type { PageLayoutController } from "../page-layouts/controller.ts";
import { arranging, type EditMenuData, editActions, editGoTo, editInserts } from "./commands.ts";
import { toolsHost } from "./host.ts";
import { COMMAND_MENU_MIN_WIDTH } from "./width.ts";

/** Something React follows from outside it: what it is now, and a way to hear it change. */
type Followed<Value> = { get(): Value; subscribe(listener: () => void): () => void };

/** What a document event last handed over as its `detail` (null takes it away), starting from `initial`. */
function handedOver<Value>(doc: Document, event: string, initial: Value | null): Followed<Value | null> {
	let value = initial;
	const listeners = new Set<() => void>();
	doc.addEventListener(event, (handed) => {
		value = (handed as CustomEvent<Value | null>).detail ?? null;
		for (const listener of listeners) listener();
	});
	return {
		get: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** Draws again whenever something with a `subscribe` says it changed (the Page layout, the Undo history). */
function useChanges(source: { subscribe(listener: () => void): () => void } | null) {
	const [, changed] = useState(0);
	useEffect(() => source?.subscribe(() => changed((count) => count + 1)), [source]);
}

/** Before a history owner hands its history over: nothing to undo or redo. */
const NO_HISTORY: HistoryTarget = { undo() {}, redo() {}, canUndo: () => false, canRedo: () => false };

const WITHOUT_INSERT: readonly CommandTab[] = ["actions", "goTo"];

/** Where Edit mode's text takes formatting: rich text regions and the body, as the page tags them. */
const RICH_TEXT = '[data-wc-type="richText"], [data-wc-type="body"]';

/**
 * In rich text, ⌘K and ⌘I are the text's own (a link, italic): the menu's Actions and Insert open
 * there from the Edit bar's search button, and Go to's key (⌘P) still works.
 */
function typingInRichText(event: KeyboardEvent, tab: CommandTab): boolean {
	return tab !== "goTo" && event.composedPath().some((each) => each instanceof Element && each.matches(RICH_TEXT));
}

/**
 * The Command menu in Edit mode (#139): #131's menu on its third canvas, for everyone in Edit mode,
 * each command shown by the Permission it declares (`can()` on the Site, as the server answers it).
 * The Edit bar's search button and the menu's keys open it; it isn't offered in a narrow window.
 */
function EditCommandMenu({
	kit,
	bar,
	layouts,
	histories,
}: {
	kit: BarKit;
	bar: BarCommands;
	layouts: Followed<PageLayoutController | null>;
	histories: Followed<EditHistory | null>;
}) {
	const t = useT();
	const [, announce] = useEditorAnnouncement();
	const [menu, setMenu] = useState<MenuState | null>(null);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const [data, setData] = useState<EditMenuData | null>(null);
	const layout = useSyncExternalStore(layouts.subscribe, layouts.get);
	const history = useSyncExternalStore(histories.subscribe, histories.get);
	useChanges(layout);
	useChanges(history);
	const editing = useSyncExternalStore(
		useCallback(
			(listener) => {
				kit.doc.addEventListener("webcraft:edit-mode", listener);
				return () => kit.doc.removeEventListener("webcraft:edit-mode", listener);
			},
			[kit],
		),
		() => kit.editing(),
	);
	const width = useMemo(() => kit.win.matchMedia(`(min-width: ${COMMAND_MENU_MIN_WIDTH}px)`), [kit]);
	const wide = useSyncExternalStore(
		useCallback(
			(listener) => {
				width.addEventListener("change", listener);
				return () => width.removeEventListener("change", listener);
			},
			[width],
		),
		() => width.matches,
	);

	const inserts = editInserts(t, layout);
	const tabs = inserts ? COMMAND_TABS : WITHOUT_INSERT;
	const shown = wide && menu && tabs.includes(menu.tab) ? menu : null;
	// A window made narrow, or a tab that went (Preview, arranging turned off), closes what was open.
	useEffect(() => {
		if (menu && !shown) setMenu(null);
		if (!wide) setShortcutsOpen(false);
	}, [menu, shown, wide]);

	// What the person may do is read from the server the first time the menu or the shortcuts list is
	// asked for, so a page costs nothing until then. Go to reads its lists again each time it opens.
	const known = useRef(false);
	/** Whether what was last read was read for the menu as it is open now: Go to then doesn't read it twice. */
	const fresh = useRef(false);
	const load = useCallback(async () => {
		const answer = await kit.call("commandMenu", {});
		if (!answer.ok) {
			announce(kit.errorText(answer.code), "interrupt");
			return false;
		}
		setData(answer.data as EditMenuData);
		known.current = true;
		fresh.current = true;
		return true;
	}, [kit, announce]);
	/** Opens something once what the person may do is known; nothing opens when that can't be read. */
	const whenKnown = useCallback(
		(open: () => void) => {
			if (known.current) open();
			else
				void load().then((read) => {
					if (read) open();
				});
		},
		[load],
	);
	const show = useCallback(
		(next: MenuState | null) => {
			if (next) whenKnown(() => setMenu(next));
			else setMenu(null);
		},
		[whenKnown],
	);
	const open = shown !== null;
	const goingTo = shown?.tab === "goTo";
	useEffect(() => {
		if (!open) fresh.current = false;
	}, [open]);
	useEffect(() => {
		if (!goingTo) return;
		if (fresh.current) fresh.current = false;
		else void load();
	}, [goingTo, load]);
	const can = useCallback(
		(permission: Permission) => !!data && (data.permissions as readonly Permission[]).includes(permission),
		[data],
	);

	// The Edit bar's search button: named, with the menu's key in its tooltip, shown while the menu is offered.
	useEffect(() => {
		const button = bar.button;
		const name = t("builder.commandMenu.open");
		button.setAttribute("aria-label", name);
		button.title = withKeys(name, "menu.actions");
		button.setAttribute("aria-keyshortcuts", ariaKeys("menu.actions"));
		const pressed = () => show({ tab: "actions" });
		button.addEventListener("click", pressed);
		return () => button.removeEventListener("click", pressed);
	}, [bar, t, show]);
	useEffect(() => {
		bar.button.hidden = !wide;
	}, [bar, wide]);

	useEditorKeys({
		enabled: wide,
		menu: shown,
		setMenu: show,
		tabs,
		typing: typingInRichText,
		openShortcuts: () => whenKnown(() => setShortcutsOpen(true)),
		// Undo and Redo's keys are their history's own to bind: they work where the menu isn't offered too.
		element: null,
	});
	// Save Draft's key, outside dialogs (theirs stay their own).
	useEffect(() => {
		if (!wide || !editing) return;
		const key = (event: KeyboardEvent) => {
			if (event.isComposing || !matches(event, "editor.save")) return;
			if (event.composedPath().some((each) => each instanceof Element && each.matches("[role=dialog]"))) return;
			event.preventDefault();
			void bar.save();
		};
		kit.win.addEventListener("keydown", key);
		return () => kit.win.removeEventListener("keydown", key);
	}, [kit, bar, wide, editing]);

	/** Leaves for another page once what is on its way to the Draft is saved; stays when it wasn't. */
	const leaveTo = async (url: string) => {
		if (await bar.settle()) kit.win.location.assign(url);
	};
	const actions = editActions(t, { bar, editing, history: history ?? NO_HISTORY, layout });
	const goTo = data
		? editGoTo(t, data, layout, {
				page: (path) => void leaveTo(path),
				builder: (target: BuilderTarget) =>
					void leaveTo(new URL(`/builder/${data.siteId}/${targetPath(target)}`, data.adminOrigin).href),
				selected: (label) => announce(t("builder.commandMenu.editMode.selected", { name: label })),
			})
		: null;

	return (
		<>
			<CommandMenu
				canvas="edit"
				state={shown}
				onState={setMenu}
				can={can}
				tabs={tabs}
				actions={actions}
				goTo={goTo}
				insert={null}
				placing={inserts}
				// Opened from the Page layout drawer's tree, focus goes back to its selected row while the tree still shows.
				onRowFocus={() => {
					if (layout?.state().panel === "tree") layout.openLayout();
				}}
			/>
			<ShortcutsDialog
				open={shortcutsOpen && wide}
				onOpenChange={setShortcutsOpen}
				can={can}
				edit={{ arranging: arranging(layout), history: history !== null }}
			/>
		</>
	);
}

/** Puts the Command menu on a page in Edit mode, for the editing bar (`loadTools`). */
function mount(kit: BarKit, language: AdminLanguageCode, styles: string, bar: BarCommands) {
	const container = toolsHost(kit, "webcraft-edit-commands", styles);
	if (!container) return;
	// Heard from now on, whichever comes first: the Page layout's controller, the Undo history.
	const layouts = handedOver<PageLayoutController>(kit.doc, "webcraft:page-layout", null);
	const histories = handedOver<EditHistory>(kit.doc, "webcraft:edit-history", kit.history());
	createRoot(container).render(
		<AdminIntl language={language}>
			<DialogContainer value={container}>
				<EditCommandMenu kit={kit} bar={bar} layouts={layouts} histories={histories} />
			</DialogContainer>
		</AdminIntl>,
	);
}
document.dispatchEvent(new CustomEvent("webcraft:edit-commands", { detail: { mount } }));

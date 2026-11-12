import type { Permission } from "@webcraft/core";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import { Button } from "@webcraft/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@webcraft/ui/components/dialog.tsx";
import { Input } from "@webcraft/ui/components/input.tsx";
import { CommandIcon } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

import { useT } from "../i18n.tsx";
import {
	type Canvas,
	COMMAND_TABS,
	type Command,
	type CommandTab,
	type HistoryTarget,
	recentCommands,
	rememberCommand,
	TAB_SHORTCUTS,
	visibleCommands,
} from "./commands.ts";
import { elementBuilder, type InsertItem, InsertStep, insertItems, insertNow, SHORT_LIST } from "./insert-items.tsx";
import type { Catalogue } from "./model.ts";
import {
	ariaKeys,
	chordText,
	matches,
	SHORTCUTS,
	type ShortcutArea,
	type SpokenKey,
	shortcutSpoken,
	shortcutText,
	withKeys,
} from "./shortcuts.ts";
import { useEditorAnnouncement } from "./use-editor-announcement.ts";

/** What the menu shows: its tab, and in Insert a question being asked or a narrowed list. */
export type MenuState = {
	tab: CommandTab;
	/** An Insert item that needs a choice, asked at once (from the insert toolbar, or Wrap in Loop). */
	step?: { item: string; mode: "insert" | "wrap" };
	/** Insert lists only this group (the insert toolbar's Component button). */
	only?: InsertItem["group"];
};

/** How Insert puts things in the tree: the insert toolbar's rules (Inside/After, the place-marker line). */
export type InsertTarget = {
	siteId: string;
	tree: ElementTree;
	catalogue: Catalogue;
	where: "inside" | "after";
	canInside: boolean;
	onWhere(where: "inside" | "after"): void;
	/** The selected layer's name, or null when nothing is selected (Insert goes at the end of the body). */
	selected: string | null;
	/** Puts nodes in the tree there; answers why not. */
	onInsert(nodes: TreeNode[], where: "inside" | "after"): string | undefined;
	/** Wraps the selected layer in the node a question made (Wrap in Loop, Wrap in Condition). */
	onWrap?(wrapper: TreeNode): string | undefined;
	/** Shows (or hides) the insert toolbar's place-marker line. */
	onPreview?(show: boolean, where: "inside" | "after"): void;
};

/** The element focus was in, looking through shadow roots (Code mode draws in one). */
export function deepActiveElement(): HTMLElement | null {
	let active = document.activeElement as HTMLElement | null;
	while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement as HTMLElement;
	return active;
}

const PANEL_EXCLUDED =
	"input, textarea, select, [contenteditable]:not([contenteditable='false']), [role=dialog], [role=tree], [role=menu], [role=listbox], [data-code-panel], webcraft-edit-bar";

/** Whether a key press happened in a code panel, a text field, a dialog, a menu or the tree (they own their keys). */
function ownedElsewhere(event: KeyboardEvent): boolean {
	return event.composedPath().some((each) => each instanceof Element && each.matches(PANEL_EXCLUDED));
}

/** Whether a key press happened in another dialog than the Command menu (its own keys stay there). */
function inOtherDialog(event: KeyboardEvent): boolean {
	return event
		.composedPath()
		.some((each) => each instanceof Element && each.matches("[role=dialog]:not([data-command-menu])"));
}

function historyKey(event: KeyboardEvent, history: HistoryTarget): boolean {
	if (!matches(event, "editor.undo") && !matches(event, "editor.redo")) return false;
	event.preventDefault();
	void (matches(event, "editor.redo") ? history.redo() : history.undo());
	return true;
}

/** Code mode's history exists before any source panel loads, and survives switching sources. */
export function useHistoryKeys(history: HistoryTarget) {
	const latest = useRef(history);
	latest.current = history;
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.isComposing ||
				document.documentElement.classList.contains("wc-code-covered") ||
				event.composedPath().some((each) => each instanceof Element && each.matches("[role=dialog]"))
			)
				return;
			historyKey(event, latest.current);
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, []);
}

/**
 * The editor's keys, on either canvas: ⌘K, ⌘P and ⌘I open the Command menu at their tab (or close it
 * when that tab is open) and ⌘/ opens the Keyboard shortcuts list, winning over the code panels; ⌘D,
 * ⌫ and Esc act on the selected layer only outside the code panels, text fields and the tree. The
 * answer also handles key presses a canvas forwards (the Builder's canvas frame).
 */
export function useEditorKeys(options: {
	enabled: boolean;
	/** Checked as each key is pressed: true while something covers the editor. */
	blocked?(): boolean;
	menu: MenuState | null;
	setMenu(menu: MenuState | null): void;
	openShortcuts(): void;
	history?: HistoryTarget;
	element: { duplicate(): void; delete(): void; parent(): void } | null;
}): (event: KeyboardEvent) => void {
	const latest = useRef(options);
	latest.current = options;
	const handler = useRef<(event: KeyboardEvent, phase: "capture" | "bubble") => void>(() => {});
	handler.current = (event, phase) => {
		const { enabled, blocked, menu, setMenu, openShortcuts, element, history } = latest.current;
		if (!enabled || blocked?.() || event.isComposing) return;
		if (phase === "capture") {
			if (inOtherDialog(event)) return;
			for (const tab of COMMAND_TABS) {
				if (!matches(event, TAB_SHORTCUTS[tab])) continue;
				event.preventDefault();
				event.stopPropagation();
				setMenu(menu?.tab === tab ? null : { tab });
				return;
			}
			if (matches(event, "menu.shortcuts")) {
				event.preventDefault();
				event.stopPropagation();
				setMenu(null);
				openShortcuts();
			}
			return;
		}
		if (menu || event.defaultPrevented || inOtherDialog(event)) return;
		if (history && historyKey(event, history)) return;
		if (!element || ownedElsewhere(event)) return;
		const run = matches(event, "element.duplicate")
			? element.duplicate
			: matches(event, "element.delete")
				? element.delete
				: matches(event, "element.parent")
					? element.parent
					: null;
		if (!run) return;
		event.preventDefault();
		run();
	};
	useEffect(() => {
		const capture = (event: KeyboardEvent) => handler.current(event, "capture");
		const bubble = (event: KeyboardEvent) => handler.current(event, "bubble");
		window.addEventListener("keydown", capture, true);
		window.addEventListener("keydown", bubble);
		return () => {
			window.removeEventListener("keydown", capture, true);
			window.removeEventListener("keydown", bubble);
		};
	}, []);
	return (event) => {
		handler.current(event, "capture");
		if (!event.defaultPrevented) handler.current(event, "bubble");
	};
}

/** The toolbar button that opens the Command menu (touch, and the pointer). */
export function CommandMenuButton({ onOpen }: { onOpen(): void }) {
	const t = useT();
	return (
		<Button
			type="button"
			size="icon-sm"
			variant="ghost"
			aria-haspopup="dialog"
			aria-label={t("builder.commandMenu.open")}
			aria-keyshortcuts={ariaKeys("menu.actions")}
			title={withKeys(t("builder.commandMenu.open"), "menu.actions")}
			onClick={onOpen}
		>
			<CommandIcon aria-hidden="true" />
		</Button>
	);
}

type Row = { command: Command; index: number };

/**
 * The Command menu (#119, #125): one for both canvases. Actions (⌘K), Go to (⌘P) and Insert (⌘I) are a
 * tab list; Tab and ⇧Tab switch tabs. The search box drives a list box; the highlighted result is
 * read as its label, group and key, and the number of results once typing pauses. In Insert the
 * search box says where the element goes, and ⌥↵ inserts the other way. Focus goes back where the
 * menu was opened, except after Go to an element or an insert (the tree row).
 */
export function CommandMenu({
	canvas,
	state,
	onState,
	can,
	actions,
	goTo,
	insert,
	onRowFocus,
}: {
	canvas: Canvas;
	state: MenuState | null;
	onState(state: MenuState | null): void;
	can(permission: Permission): boolean;
	actions: readonly Command[];
	/** Go to's destinations and the page's layers; null while they load. */
	goTo: readonly Command[] | null;
	insert: InsertTarget | null;
	/** Puts focus on the selected tree row (after Go to an element, Rename, or an insert). */
	onRowFocus(): void;
}) {
	const t = useT();
	const id = useId();
	const open = state !== null;
	const tab = state?.tab ?? "actions";
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [recent, setRecent] = useState<string[]>(() => recentCommands());
	const [, announce] = useEditorAnnouncement();
	const [step, setStep] = useState<{ item: InsertItem; mode: "insert" | "wrap" } | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const origin = useRef<HTMLElement | null>(null);
	const focusRow = useRef(false);
	/** The command chosen: it runs once the menu has closed and focus has gone back. */
	const pending = useRef<(() => void | Promise<void>) | null>(null);
	const search = useRef<HTMLInputElement>(null);
	const tabButtons = useRef(new Map<CommandTab, HTMLButtonElement>());
	/** A tab chosen with the arrow keys keeps focus; any other way to a tab focuses the search box. */
	const tabFocus = useRef<CommandTab | null>(null);

	// Where the menu was opened from: focus goes back there. Remembered as it opens.
	const wasOpen = useRef(false);
	if (open && !wasOpen.current) {
		// Opened again before the last choice ran (its closing was cut short): it runs now.
		const chosen = pending.current;
		pending.current = null;
		if (chosen) queueMicrotask(() => void chosen());
		origin.current = deepActiveElement();
		focusRow.current = false;
	}
	wasOpen.current = open;
	// Insert's catalogue is made only while its tab is open.
	const listing = open && tab === "insert";
	const items = useMemo(
		() => (insert && listing ? insertItems(t, insert.tree, insert.catalogue) : []),
		[t, insert, listing],
	);

	// Opening a tab starts afresh; a question asked from outside (the toolbar, Wrap in) opens at once.
	const stepKey = state?.step ? `${state.step.item}:${state.step.mode}` : "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: a tab or a requested question starts the list afresh.
	useEffect(() => {
		setQuery("");
		setActive(0);
		setProblem(null);
		const wanted = state?.step ? items.find((item) => item.id === state.step?.item) : undefined;
		setStep(wanted && state?.step ? { item: wanted, mode: state.step.mode } : null);
		if (!open) return;
		requestAnimationFrame(() => {
			const wanted = tabFocus.current;
			tabFocus.current = null;
			if (wanted) tabButtons.current.get(wanted)?.focus();
			else search.current?.focus();
		});
	}, [open, tab, stepKey]);

	const insertCommands = useMemo<Command[]>(() => {
		if (!insert) return [];
		const groupName = (item: InsertItem) => t(`builder.insert.groups.${item.group}`);
		return items.map((item) => ({
			id: `insert:${item.id}`,
			tab: "insert",
			group: groupName(item),
			label: item.label,
			hint: item.hint,
			keywords: [item.id, item.hint],
			permission: "structure.edit",
			canvases: ["code", "builder"],
			focus: "row",
			run: () => {},
		}));
	}, [insert, items, t]);

	const all = tab === "actions" ? actions : tab === "goTo" ? (goTo ?? []) : insertCommands;
	const listed = useMemo(() => {
		const found = visibleCommands(all, { tab, canvas, can, query, recent });
		if (tab !== "insert" || query.trim()) return found;
		const only = state?.only;
		/** Where an item stands in the short list (every Component where the toolbar's Component button is). */
		const rank = (command: Command) => {
			const item = items.find((each) => `insert:${each.id}` === command.id);
			if (!item) return -1;
			if (only) return item.group === only ? 0 : -1;
			return SHORT_LIST.indexOf(item.group === "components" ? "components" : item.id);
		};
		const short = (command: Command) => rank(command) >= 0;
		return {
			recent: found.recent.filter(short),
			results: found.results.filter(short).sort((a, b) => rank(a) - rank(b)),
		};
	}, [all, tab, canvas, can, query, recent, items, state?.only]);
	const rows: Row[] = [...listed.recent, ...listed.results].map((command, index) => ({ command, index }));
	const current = rows[Math.min(active, rows.length - 1)];

	// The number of results is read once, after a pause in typing.
	useEffect(() => {
		if (!open || !query) return;
		const timer = setTimeout(() => announce(t("builder.commandMenu.count", { count: rows.length })), 600);
		return () => clearTimeout(timer);
	}, [open, query, rows.length, t, announce]);

	// Insert shows the insert toolbar's place-marker line while it is open.
	const where = insert?.canInside ? insert.where : "after";
	const previewing = open && tab === "insert" && !!insert;
	const preview = useRef(insert?.onPreview);
	preview.current = insert?.onPreview;
	useEffect(() => {
		if (!previewing) return;
		preview.current?.(true, where);
		return () => preview.current?.(false, where);
	}, [previewing, where]);

	/**
	 * Closes the menu. Focus goes back where it was opened; opened from the tree, it goes to the tree's
	 * selected row (focusing another row would select it).
	 */
	const close = (rowFocus = false) => {
		focusRow.current = rowFocus || !!origin.current?.closest("[role=tree]");
		onState(null);
	};
	/** Once the menu has closed (and the dialog has handled focus), a tree row takes it when asked. */
	const finished = () => {
		const chosen = pending.current;
		const toRow = focusRow.current;
		pending.current = null;
		setTimeout(() => {
			const before = deepActiveElement();
			if (chosen) void chosen();
			// A command that moved focus itself (Publish's confirmation, a code panel) keeps it.
			if (toRow && deepActiveElement() === before) onRowFocus();
		}, 0);
	};

	const keysOf = (command: Command) => (command.shortcut ? shortcutText(command.shortcut) : "");
	const keyWords = (name: SpokenKey) => t(`builder.commandMenu.keyNames.${name}`);
	const spokenOf = (command: Command) =>
		command.shortcut
			? t("builder.commandMenu.optionKeys", {
					label: command.label,
					group: command.group,
					keys: shortcutSpoken(command.shortcut, keyWords),
				})
			: t("builder.commandMenu.option", { label: command.label, group: command.group });
	/** What a screen reader hears after the visible label: the group and the key ("Duplicate, Element, Command D"). */
	const readAfter = (command: Command) => {
		const spoken = spokenOf(command);
		return spoken.startsWith(command.label) ? spoken.slice(command.label.length) : `, ${spoken}`;
	};

	const insertNodes = (nodes: TreeNode[], inverse: boolean, mode: "insert" | "wrap") => {
		if (!insert) return;
		const way = inverse ? (where === "inside" ? "after" : insert.canInside ? "inside" : "after") : where;
		const refused = mode === "wrap" ? insert.onWrap?.(nodes[0] as TreeNode) : insert.onInsert(nodes, way);
		if (refused) {
			setProblem(refused);
			announce(refused, "interrupt");
			return;
		}
		close(true);
	};

	const run = (command: Command, inverse = false) => {
		if (command.disabled) return;
		setRecent(rememberCommand(command.id));
		if (command.tab === "insert" && insert) {
			const item = items.find((each) => `insert:${each.id}` === command.id);
			if (!item) return;
			const nodes = insertNow(item, insert.tree, insert.catalogue);
			if (nodes) insertNodes(nodes, inverse, "insert");
			else {
				setProblem(null);
				setStep({ item, mode: "insert" });
			}
			return;
		}
		pending.current = () => command.run({ inverse });
		close(command.focus === "row");
	};

	const switchTab = (next: CommandTab) => onState({ tab: next });

	const keyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Tab") {
			event.preventDefault();
			const at = COMMAND_TABS.indexOf(tab) + (event.shiftKey ? -1 : 1);
			switchTab(COMMAND_TABS[(at + COMMAND_TABS.length) % COMMAND_TABS.length] as CommandTab);
		} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const move = event.key === "ArrowDown" ? 1 : -1;
			setActive((before) => (rows.length ? (Math.min(before, rows.length - 1) + move + rows.length) % rows.length : 0));
		} else if (event.key === "Home" || event.key === "End") {
			event.preventDefault();
			setActive(event.key === "Home" ? 0 : Math.max(0, rows.length - 1));
		} else if (event.key === "Enter") {
			event.preventDefault();
			if (current) run(current.command, event.altKey && tab === "insert");
		}
	};

	const whereText = !insert
		? ""
		: insert.selected === null
			? t("builder.commandMenu.insert.end")
			: t(where === "inside" ? "builder.commandMenu.insert.inside" : "builder.commandMenu.insert.after", {
					name: insert.selected,
				});
	const inverseText =
		insert?.selected && insert.canInside
			? t(where === "inside" ? "builder.commandMenu.insert.inverseAfter" : "builder.commandMenu.insert.inverseInside")
			: null;

	const groups: { name: string; rows: Row[] }[] = [];
	if (listed.recent.length)
		groups.push({ name: t("builder.commandMenu.recent"), rows: rows.slice(0, listed.recent.length) });
	for (const row of rows.slice(listed.recent.length)) {
		const last = groups.at(-1);
		if (last && groups.length > (listed.recent.length ? 1 : 0) && last.name === row.command.group) last.rows.push(row);
		else groups.push({ name: row.command.group, rows: [row] });
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) close();
			}}
			onOpenChangeComplete={(next) => {
				if (!next) finished();
			}}
		>
			<DialogContent
				data-command-menu=""
				closeLabel={t("builder.commandMenu.close")}
				className="top-[12vh] translate-y-0 gap-3 sm:max-w-xl"
				finalFocus={() => {
					if (focusRow.current) return false;
					const back = origin.current;
					return back?.isConnected ? back : true;
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("builder.commandMenu.title")}</DialogTitle>
					<DialogDescription className="sr-only">{t("builder.commandMenu.tabs.label")}</DialogDescription>
				</DialogHeader>
				<div role="tablist" aria-label={t("builder.commandMenu.tabs.label")} className="flex gap-1 border-b pb-2">
					{COMMAND_TABS.map((each) => (
						<button
							key={each}
							type="button"
							role="tab"
							id={`${id}-tab-${each}`}
							ref={(button) => {
								if (button) tabButtons.current.set(each, button);
								else tabButtons.current.delete(each);
							}}
							tabIndex={each === tab ? 0 : -1}
							aria-selected={each === tab}
							aria-controls={`${id}-panel`}
							aria-keyshortcuts={ariaKeys(TAB_SHORTCUTS[each])}
							title={withKeys(t(`builder.commandMenu.tabs.${each}`), TAB_SHORTCUTS[each])}
							className="aria-selected:bg-accent aria-selected:text-accent-foreground focus-visible:ring-ring/50 flex items-center gap-2 rounded-md px-2 py-1 text-sm font-medium outline-none focus-visible:ring-3"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => switchTab(each)}
							onKeyDown={(event) => {
								const at = COMMAND_TABS.indexOf(each);
								const next =
									event.key === "ArrowRight" || event.key === "ArrowLeft"
										? COMMAND_TABS[
												(at + (event.key === "ArrowRight" ? 1 : -1) + COMMAND_TABS.length) % COMMAND_TABS.length
											]
										: event.key === "Home"
											? COMMAND_TABS[0]
											: event.key === "End"
												? COMMAND_TABS.at(-1)
												: undefined;
								if (!next) return;
								event.preventDefault();
								tabFocus.current = next;
								if (next === tab) tabButtons.current.get(next)?.focus();
								else switchTab(next);
							}}
						>
							{t(`builder.commandMenu.tabs.${each}`)}
							<span aria-hidden="true" className="text-muted-foreground text-xs">
								{shortcutText(TAB_SHORTCUTS[each])}
							</span>
						</button>
					))}
				</div>
				<div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="grid gap-2">
					{tab === "insert" && insert ? (
						<fieldset className="flex flex-wrap items-center gap-2">
							<legend className="sr-only">{t("builder.insert.where")}</legend>
							{(["inside", "after"] as const).map((value) => (
								<Button
									key={value}
									type="button"
									size="sm"
									variant="outline"
									disabled={value === "inside" && !insert.canInside}
									aria-pressed={where === value}
									onClick={() => insert.onWhere(value)}
								>
									{t(`builder.toolbar.${value}`)}
								</Button>
							))}
						</fieldset>
					) : null}
					{step && insert ? (
						<div className="grid gap-3">
							<p className="text-sm font-medium">{step.item.label}</p>
							<p className="text-muted-foreground text-sm">{step.item.hint}</p>
							<InsertStep
								step={step.item}
								siteId={insert.siteId}
								catalogue={insert.catalogue}
								allowed={new Set(insert.catalogue.elements)}
								build={elementBuilder(insert.tree)}
								onBack={() => {
									setStep(null);
									setProblem(null);
									requestAnimationFrame(() => search.current?.focus());
								}}
								onInsert={(nodes) => insertNodes(nodes, false, step.mode)}
								problem={problem}
								tree={insert.tree}
								baseId={id}
							/>
						</div>
					) : (
						<>
							<Input
								ref={search}
								role="combobox"
								aria-label={t(`builder.commandMenu.search.${tab}`)}
								aria-expanded="true"
								aria-controls={`${id}-list`}
								aria-autocomplete="list"
								aria-activedescendant={current ? `${id}-option-${current.index}` : undefined}
								aria-describedby={tab === "insert" ? `${id}-where${inverseText ? ` ${id}-inverse` : ""}` : undefined}
								placeholder={t(`builder.commandMenu.placeholder.${tab}`)}
								value={query}
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => {
									setQuery(event.target.value);
									setActive(0);
									setProblem(null);
								}}
								onKeyDown={keyDown}
							/>
							{tab === "insert" ? (
								<p className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
									<span id={`${id}-where`}>{whereText}</span>
									{inverseText ? (
										<span>
											<span aria-hidden="true">{chordText({ key: "Enter", alt: true })}</span>{" "}
											<span id={`${id}-inverse`}>{inverseText}</span>
										</span>
									) : null}
								</p>
							) : null}
							<div
								id={`${id}-list`}
								role="listbox"
								aria-label={t(`builder.commandMenu.tabs.${tab}`)}
								className="grid max-h-80 overflow-y-auto rounded-md border p-1"
							>
								{tab === "goTo" && goTo === null ? (
									<p className="text-muted-foreground p-2 text-sm">{t("builder.commandMenu.loading")}</p>
								) : null}
								{groups.map((group) => (
									// biome-ignore lint/a11y/useSemanticElements: a list box groups its options with role="group", never a fieldset.
									<div key={`${group.name}-${group.rows[0]?.index}`} role="group" aria-label={group.name}>
										<p
											aria-hidden="true"
											className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium uppercase"
										>
											{group.name}
										</p>
										{group.rows.map((row) => (
											<div
												key={`${row.command.id}-${row.index}`}
												id={`${id}-option-${row.index}`}
												role="option"
												tabIndex={-1}
												aria-selected={row === current}
												aria-disabled={row.command.disabled || undefined}
												className={`aria-selected:bg-accent aria-selected:text-accent-foreground flex cursor-default items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-sm ${row.command.parent ? "ps-5" : ""}`}
												onMouseDown={(event) => event.preventDefault()}
												onMouseMove={() => setActive(row.index)}
												onClick={(event) => run(row.command, event.altKey && tab === "insert")}
												onKeyDown={() => {}}
											>
												<span className="truncate">
													{row.command.label}
													<span className="sr-only">{readAfter(row.command)}</span>
												</span>
												<span
													aria-hidden="true"
													className="text-muted-foreground flex shrink-0 items-baseline gap-2 text-xs"
												>
													{row.command.hint ? <span className="truncate font-mono">{row.command.hint}</span> : null}
													{keysOf(row.command) ? <kbd className="font-sans">{keysOf(row.command)}</kbd> : null}
												</span>
											</div>
										))}
									</div>
								))}
							</div>
							<p className="text-destructive text-sm empty:hidden">
								{rows.length === 0 && (tab !== "goTo" || goTo !== null)
									? t("builder.commandMenu.none")
									: (problem ?? "")}
							</p>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

const AREAS: readonly ShortcutArea[] = ["menu", "editor", "element", "tree", "insert"];

/** Keyboard shortcuts (⌘/): the shortcut registry, grouped by area, only what the person may do. */
export function ShortcutsDialog({
	open,
	onOpenChange,
	can,
}: {
	open: boolean;
	onOpenChange(open: boolean): void;
	can(permission: Permission): boolean;
}) {
	const t = useT();
	const id = useId();
	const origin = useRef<HTMLElement | null>(null);
	const wasOpen = useRef(false);
	if (open && !wasOpen.current) origin.current = deepActiveElement();
	wasOpen.current = open;
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				closeLabel={t("builder.commandMenu.shortcuts.close")}
				className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
				finalFocus={() => (origin.current?.isConnected ? origin.current : true)}
			>
				<DialogHeader>
					<DialogTitle>{t("builder.commandMenu.shortcuts.title")}</DialogTitle>
					<DialogDescription>{t("builder.commandMenu.shortcuts.intro")}</DialogDescription>
				</DialogHeader>
				{AREAS.map((area) => {
					const listed = SHORTCUTS.filter((each) => each.area === area && can(each.permission));
					if (!listed.length) return null;
					return (
						<table key={area} className="w-full text-sm" aria-labelledby={`${id}-${area}`}>
							<caption id={`${id}-${area}`} className="pb-1 text-start font-semibold">
								{t(`builder.commandMenu.areas.${area}`)}
							</caption>
							<thead className="sr-only">
								<tr>
									<th scope="col">{t("builder.commandMenu.shortcuts.keys")}</th>
									<th scope="col">{t("builder.commandMenu.shortcuts.action")}</th>
								</tr>
							</thead>
							<tbody>
								{listed.map((each) => (
									<tr key={each.id} className="border-t">
										<td className="w-36 py-1 pe-3 align-top">
											{each.chords.map((chord, index) => (
												<span key={chordText(chord)}>
													{index > 0 ? " · " : null}
													<kbd className="bg-muted rounded px-1 font-sans text-xs">{chordText(chord)}</kbd>
												</span>
											))}
										</td>
										<td className="py-1">{t(each.label)}</td>
									</tr>
								))}
							</tbody>
						</table>
					);
				})}
			</DialogContent>
		</Dialog>
	);
}

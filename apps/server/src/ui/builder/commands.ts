import type { Permission } from "@webcraft/core";

import type { useT } from "../i18n.tsx";
import type { LayerAction } from "./LayersPanel.tsx";
import type { ShortcutId } from "./shortcuts.ts";

type T = ReturnType<typeof useT>;

/** The two canvases of the one editor (ADR 0035): Code mode on the live page, and the Builder. */
export type Canvas = "code" | "builder";

/** The Command menu's tabs, each with its own key. */
export type CommandTab = "actions" | "goTo" | "insert";
export const COMMAND_TABS: readonly CommandTab[] = ["actions", "goTo", "insert"];
export const TAB_SHORTCUTS: Record<CommandTab, ShortcutId> = {
	actions: "menu.actions",
	goTo: "menu.goTo",
	insert: "menu.insert",
};

/** Where focus goes after a command ran: back where the menu was opened, or to a tree row. */
export type CommandFocus = "return" | "row";

/**
 * One command of the Command menu: Actions, a Go to destination, or an Insert item. Each declares the
 * Permission it needs (`can()`, ADR 0028) and the canvases it applies to; the menu hides the rest.
 */
export type Command = {
	id: string;
	tab: CommandTab;
	/** What a screen reader reads after the label: "Duplicate, Element, Command D". */
	group: string;
	label: string;
	/** Words the search matches besides the label. */
	keywords: readonly string[];
	/** A short note shown beside the label (a path, a tag). */
	hint?: string;
	shortcut?: ShortcutId;
	permission: Permission;
	canvases: readonly Canvas[];
	/** `inverse`: ⌥↵ in the Insert tab, which inserts the other way. */
	run(options: { inverse: boolean }): void | Promise<void>;
	focus?: CommandFocus;
	/** Nested under a heading of its own (a Post Type's Entries). */
	parent?: string;
};

/** The selected layer, as the Actions see it. */
export type CommandSelection = {
	kind: "element" | "placement" | "other";
	name: string;
	/** A Placement that visitors don't see (Hidden placement). */
	hidden?: boolean;
	/** Whether it holds anything to unwrap. */
	canUnwrap: boolean;
};

/** Undo and Redo, supplied by the canvas. #136 replaces today's adapters with the tab's own-step history. */
export type HistoryTarget = { undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean };

export type WrapKind = "div" | "section" | "a" | "loop" | "condition";

/**
 * What a canvas supplies for the built-in Actions. A missing optional method hides its command on
 * that canvas. Selection actions go through the shared layer actions (`runLayerAction`).
 */
export type EditorCommandTarget = {
	canvas: Canvas;
	selection: CommandSelection | null;
	history: HistoryTarget;
	save(): void | Promise<void>;
	/** Opens the canvas's own confirmation; never publishes at once. */
	publish(): void;
	/** Code mode: Open in builder. The Builder: View on a page. */
	switchCanvas?(): void;
	openSiteCss?(): void;
	openPageScript?(): void;
	safeMode?: { on: boolean; set(on: boolean): void };
	preview?(): void;
	leave?(): void;
	layer(action: LayerAction | "parent"): void;
	wrap?(kind: WrapKind): void;
	unwrap?(): void;
	editComponent?(): void;
	toggleHidden?(): void;
	/** Make Component (#134): asks for a name and moves the selected element or Placement into a new Component. */
	makeComponent?(): void;
	/** New Component (#134): asks for a name and opens the new, empty Component's markup. */
	newComponent?(): void;
	/** Commands other tickets add. */
	extra?: readonly Command[];
};

const BOTH: readonly Canvas[] = ["code", "builder"];

/** The built-in Actions for what the canvas has now. */
export function editorCommands(target: EditorCommandTarget, t: T): Command[] {
	const editor = t("builder.commandMenu.groups.editor");
	const commands: Command[] = [];
	const add = (
		id: string,
		label: string,
		keywords: string,
		run: () => void | Promise<void>,
		more: Partial<Command> = {},
	) =>
		commands.push({
			id,
			tab: "actions",
			group: editor,
			label,
			keywords: keywords.split(" ").filter(Boolean),
			permission: "structure.edit",
			canvases: BOTH,
			run,
			...more,
		});
	const words = (key: Parameters<T>[0]) => t(key);

	add("save", words("builder.commandMenu.actions.save"), t("builder.commandMenu.keywords.save"), () => target.save(), {
		shortcut: "editor.save",
	});
	add(
		"publish",
		words("builder.commandMenu.actions.publish"),
		t("builder.commandMenu.keywords.publish"),
		() => target.publish(),
		{
			// Publishing in the Builder publishes Structure; Code mode's Publish publishes the page's Content.
			permission: target.canvas === "builder" ? "structure.edit" : "entry.publish",
		},
	);
	add(
		"undo",
		words("builder.commandMenu.actions.undo"),
		t("builder.commandMenu.keywords.undo"),
		() => target.history.undo(),
		{
			shortcut: "editor.undo",
		},
	);
	add(
		"redo",
		words("builder.commandMenu.actions.redo"),
		t("builder.commandMenu.keywords.redo"),
		() => target.history.redo(),
		{
			shortcut: "editor.redo",
		},
	);
	if (target.switchCanvas)
		add(
			"switchCanvas",
			target.canvas === "code"
				? words("builder.commandMenu.actions.openBuilder")
				: words("builder.commandMenu.actions.viewOnPage"),
			t("builder.commandMenu.keywords.switchCanvas"),
			() => target.switchCanvas?.(),
		);
	if (target.openSiteCss)
		add("siteCss", words("builder.commandMenu.actions.siteCss"), t("builder.commandMenu.keywords.siteCss"), () =>
			target.openSiteCss?.(),
		);
	if (target.openPageScript)
		add(
			"pageScript",
			words("builder.commandMenu.actions.pageScript"),
			t("builder.commandMenu.keywords.pageScript"),
			() => target.openPageScript?.(),
			{ canvases: ["code"] },
		);
	if (target.safeMode) {
		const on = target.safeMode.on;
		add(
			"safeMode",
			on ? words("builder.commandMenu.actions.safeModeOff") : words("builder.commandMenu.actions.safeModeOn"),
			t("builder.commandMenu.keywords.safeMode"),
			() => target.safeMode?.set(!on),
			{ canvases: ["code"], permission: "site.view" },
		);
	}
	if (target.preview)
		add(
			"preview",
			words("builder.commandMenu.actions.preview"),
			t("builder.commandMenu.keywords.preview"),
			() => target.preview?.(),
			{ canvases: ["code"], permission: "site.view" },
		);
	if (target.newComponent)
		add(
			"newComponent",
			words("builder.commandMenu.actions.newComponent"),
			t("builder.commandMenu.keywords.newComponent"),
			() => target.newComponent?.(),
		);
	if (target.leave)
		add(
			"leave",
			words("builder.commandMenu.actions.leave"),
			t("builder.commandMenu.keywords.leave"),
			() => target.leave?.(),
			{
				canvases: ["code"],
				permission: "site.view",
			},
		);

	const selected = target.selection;
	if (selected) {
		const element = t("builder.commandMenu.groups.element");
		const on = { group: element };
		if (selected.kind === "element")
			add(
				"rename",
				words("builder.commandMenu.actions.rename"),
				t("builder.commandMenu.keywords.rename"),
				() => target.layer("rename"),
				{ ...on, shortcut: "tree.rename", focus: "row" },
			);
		add(
			"duplicate",
			words("builder.commandMenu.actions.duplicate"),
			t("builder.commandMenu.keywords.duplicate"),
			() => target.layer("duplicate"),
			{ ...on, shortcut: "element.duplicate" },
		);
		add(
			"copy",
			words("builder.commandMenu.actions.copy"),
			t("builder.commandMenu.keywords.copy"),
			() => target.layer("copy"),
			{
				...on,
				shortcut: "tree.copy",
			},
		);
		add(
			"paste",
			words("builder.commandMenu.actions.paste"),
			t("builder.commandMenu.keywords.paste"),
			() => target.layer("paste"),
			{ ...on, shortcut: "tree.paste" },
		);
		add(
			"delete",
			words("builder.commandMenu.actions.delete"),
			t("builder.commandMenu.keywords.delete"),
			() => target.layer("delete"),
			{ ...on, shortcut: "element.delete" },
		);
		add(
			"parent",
			words("builder.commandMenu.actions.parent"),
			t("builder.commandMenu.keywords.parent"),
			() => target.layer("parent"),
			{ ...on, shortcut: "element.parent", focus: "row" },
		);
		if (target.wrap)
			for (const kind of ["div", "section", "a", "loop", "condition"] as const)
				add(
					`wrap-${kind}`,
					t("builder.commandMenu.actions.wrap", { what: t(`builder.commandMenu.wrap.${kind}`) }),
					`${t("builder.commandMenu.keywords.wrap")} ${kind}`,
					() => target.wrap?.(kind),
					on,
				);
		if (target.makeComponent && selected.kind !== "other")
			add(
				"makeComponent",
				words("builder.commandMenu.actions.makeComponent"),
				t("builder.commandMenu.keywords.makeComponent"),
				() => target.makeComponent?.(),
				on,
			);
		if (target.unwrap && selected.canUnwrap)
			add(
				"unwrap",
				words("builder.commandMenu.actions.unwrap"),
				t("builder.commandMenu.keywords.unwrap"),
				() => target.unwrap?.(),
				on,
			);
		if (selected.kind === "placement") {
			const placement = { group: t("builder.commandMenu.groups.placement") };
			if (target.editComponent)
				add(
					"editComponent",
					words("builder.commandMenu.actions.editComponent"),
					t("builder.commandMenu.keywords.editComponent"),
					() => target.editComponent?.(),
					placement,
				);
			if (target.toggleHidden)
				add(
					"toggleHidden",
					selected.hidden
						? words("builder.commandMenu.actions.showPlacement")
						: words("builder.commandMenu.actions.hidePlacement"),
					t("builder.commandMenu.keywords.hidePlacement"),
					() => target.toggleHidden?.(),
					placement,
				);
		}
	}
	return [...commands, ...(target.extra ?? [])];
}

/** Whether every word typed is in the command's label or keywords. */
export function commandMatches(
	command: Pick<Command, "label" | "keywords" | "hint" | "group">,
	query: string,
): boolean {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const haystack = [command.label, command.hint ?? "", command.group, ...command.keywords].join(" ").toLowerCase();
	return words.every((word) => haystack.includes(word));
}

/** What the menu lists on a tab: the person may do it (`can()`), it applies to this canvas, and it matches. */
export function visibleCommands(
	commands: readonly Command[],
	options: {
		tab: CommandTab;
		canvas: Canvas;
		can(permission: Permission): boolean;
		query: string;
		recent: readonly string[];
	},
): { recent: Command[]; results: Command[] } {
	const allowed = commands.filter(
		(command) =>
			command.tab === options.tab && command.canvases.includes(options.canvas) && options.can(command.permission),
	);
	if (options.query.trim())
		return { recent: [], results: allowed.filter((command) => commandMatches(command, options.query)) };
	const recent = options.recent
		.map((id) => allowed.find((command) => command.id === id))
		.filter((command): command is Command => !!command);
	return { recent, results: allowed.filter((command) => !recent.includes(command)) };
}

/** The last five commands used, newest first (per browser; the menu works without storage). */
const RECENT_KEY = "webcraft-command-recent";
export const RECENT_LIMIT = 5;

export function recentCommands(): string[] {
	try {
		const stored = JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? "[]");
		return Array.isArray(stored)
			? stored.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT)
			: [];
	} catch {
		return [];
	}
}

export function rememberCommand(id: string): string[] {
	const next = [id, ...recentCommands().filter((each) => each !== id)].slice(0, RECENT_LIMIT);
	try {
		globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// Without storage, Recent lasts as long as the page.
	}
	return next;
}

import type { Permission } from "@webcraft/core";

import type { MessageKey } from "../i18n.tsx";

/** One way to press a shortcut. `mod` is ⌘ on Apple devices and Ctrl elsewhere.
 * `Letter` represents tree type-ahead, including letters outside the Latin alphabet. */
export type Chord = { key: string; mod?: true; shift?: true; alt?: true };

/** Where a shortcut works: how the Keyboard shortcuts list groups them. */
export type ShortcutArea = "menu" | "editor" | "element" | "tree" | "insert";

/**
 * When a shortcut applies: anywhere in the editor (even in a code panel, where it wins), outside the
 * code panels and text fields, only in the Layers panel, or only in the Command menu's Insert tab.
 */
export type ShortcutScope = "anywhere" | "outsideCode" | "tree" | "menu" | "code";

export type Shortcut = {
	id: string;
	area: ShortcutArea;
	chords: readonly Chord[];
	label: MessageKey;
	scope: ShortcutScope;
	/** The ⌘/ list shows only what the person may do (ADR 0028). */
	permission: Permission;
};

/**
 * The one shortcut registry (#125): the Command menu's key column, tooltips, `aria-keyshortcuts` and
 * the Keyboard shortcuts list (⌘/) all read it. Keys added later (#137) are appended here.
 */
export const SHORTCUTS = [
	{ id: "menu.actions", area: "menu", chords: [{ key: "k", mod: true }], label: "builder.commandMenu.tabs.actions" },
	{ id: "menu.goTo", area: "menu", chords: [{ key: "p", mod: true }], label: "builder.commandMenu.tabs.goTo" },
	{ id: "menu.insert", area: "menu", chords: [{ key: "i", mod: true }], label: "builder.commandMenu.tabs.insert" },
	{
		id: "menu.shortcuts",
		area: "menu",
		chords: [{ key: "/", mod: true }],
		label: "builder.commandMenu.shortcuts.open",
	},
	{ id: "editor.save", area: "editor", chords: [{ key: "s", mod: true }], label: "builder.commandMenu.actions.save" },
	{ id: "editor.undo", area: "editor", chords: [{ key: "z", mod: true }], label: "builder.commandMenu.actions.undo" },
	{
		id: "editor.redo",
		area: "editor",
		chords: [
			{ key: "z", mod: true, shift: true },
			{ key: "y", mod: true },
		],
		label: "builder.commandMenu.actions.redo",
	},
	{
		id: "element.duplicate",
		area: "element",
		chords: [{ key: "d", mod: true }],
		label: "builder.commandMenu.actions.duplicate",
		scope: "outsideCode",
	},
	{
		id: "element.delete",
		area: "element",
		chords: [{ key: "Backspace" }, { key: "Delete" }],
		label: "builder.commandMenu.actions.delete",
		scope: "outsideCode",
	},
	{
		id: "element.parent",
		area: "element",
		chords: [{ key: "Escape" }],
		label: "builder.commandMenu.actions.parent",
		scope: "outsideCode",
	},
	{ id: "tree.cut", area: "tree", chords: [{ key: "x", mod: true }], label: "builder.layers.action.cut" },
	{ id: "tree.copy", area: "tree", chords: [{ key: "c", mod: true }], label: "builder.layers.action.copy" },
	{ id: "tree.paste", area: "tree", chords: [{ key: "v", mod: true }], label: "builder.layers.action.paste" },
	{ id: "tree.rename", area: "tree", chords: [{ key: "F2" }], label: "builder.layers.action.rename" },
	{
		id: "tree.rows",
		area: "tree",
		chords: [{ key: "ArrowUp" }, { key: "ArrowDown" }],
		label: "builder.commandMenu.keys.rows",
	},
	{ id: "tree.ends", area: "tree", chords: [{ key: "Home" }, { key: "End" }], label: "builder.commandMenu.keys.ends" },
	{
		id: "tree.open",
		area: "tree",
		chords: [{ key: "ArrowRight" }, { key: "ArrowLeft" }],
		label: "builder.commandMenu.keys.openClose",
	},
	{ id: "tree.toggle", area: "tree", chords: [{ key: "Enter" }], label: "builder.commandMenu.keys.toggle" },
	{ id: "tree.typeahead", area: "tree", chords: [{ key: "Letter" }], label: "builder.commandMenu.keys.typeahead" },
	{ id: "tree.openLevel", area: "tree", chords: [{ key: "*" }], label: "builder.commandMenu.keys.openLevel" },
	{
		id: "tree.toggleBranch",
		area: "tree",
		chords: [{ key: "Enter", alt: true }],
		label: "builder.commandMenu.keys.toggleBranch",
	},
	{
		id: "editor.regions",
		area: "editor",
		chords: [{ key: "F6" }, { key: "F6", shift: true }],
		label: "builder.commandMenu.keys.regions",
	},
	{
		id: "editor.indent",
		area: "editor",
		chords: [{ key: "]", mod: true }],
		label: "builder.commandMenu.keys.indent",
		scope: "code",
	},
	{
		id: "editor.outdent",
		area: "editor",
		chords: [{ key: "[", mod: true }],
		label: "builder.commandMenu.keys.outdent",
		scope: "code",
	},
	{
		id: "tree.moveUp",
		area: "tree",
		chords: [{ key: "ArrowUp", alt: true }],
		label: "builder.layers.action.moveUp",
	},
	{
		id: "tree.moveDown",
		area: "tree",
		chords: [{ key: "ArrowDown", alt: true }],
		label: "builder.layers.action.moveDown",
	},
	{
		id: "tree.moveIn",
		area: "tree",
		chords: [{ key: "ArrowRight", alt: true }],
		label: "builder.layers.action.moveIn",
	},
	{
		id: "tree.moveOut",
		area: "tree",
		chords: [{ key: "ArrowLeft", alt: true }],
		label: "builder.layers.action.moveOut",
	},
	{ id: "tree.pick", area: "tree", chords: [{ key: " " }], label: "builder.commandMenu.keys.pick" },
	{ id: "tree.putBack", area: "tree", chords: [{ key: "Escape" }], label: "builder.commandMenu.keys.putBack" },
	{
		id: "tree.layerMenu",
		area: "tree",
		chords: [{ key: "F10", shift: true }, { key: "ContextMenu" }],
		label: "builder.commandMenu.keys.layerMenu",
	},
	{
		id: "insert.inverse",
		area: "insert",
		chords: [{ key: "Enter", alt: true }],
		label: "builder.commandMenu.insert.inverse",
		scope: "menu",
	},
].map((each) => ({
	scope: each.area === "tree" ? "tree" : "anywhere",
	permission: "structure.edit",
	...each,
})) as readonly Shortcut[];

export type ShortcutId = string;

/** Whether this browser runs on an Apple device, where `mod` is ⌘ and keys show as symbols. */
export function onApple(): boolean {
	if (typeof navigator === "undefined") return false;
	const platform =
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
		navigator.platform ??
		"";
	return /mac|iphone|ipad|ipod/i.test(platform || navigator.userAgent);
}

export function shortcut(id: ShortcutId): Shortcut | undefined {
	return SHORTCUTS.find((each) => each.id === id);
}

const SYMBOLS: Record<string, [apple: string, other: string]> = {
	ArrowUp: ["↑", "↑"],
	ArrowDown: ["↓", "↓"],
	ArrowLeft: ["←", "←"],
	ArrowRight: ["→", "→"],
	Enter: ["↵", "Enter"],
	Backspace: ["⌫", "Backspace"],
	Delete: ["⌦", "Delete"],
	Escape: ["Esc", "Esc"],
	" ": ["Space", "Space"],
	Letter: ["A–Z", "A–Z"],
	ContextMenu: ["Menu", "Menu"],
};
/** Which of the message catalogue's key names (`builder.commandMenu.keyNames.*`) a key is spoken as. */
const SPOKEN: Record<string, SpokenKey> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
	Enter: "enter",
	Backspace: "delete",
	Delete: "forwardDelete",
	Escape: "escape",
	" ": "space",
	"/": "slash",
	Letter: "letter",
	"*": "asterisk",
	"[": "leftBracket",
	"]": "rightBracket",
};

/** A key or modifier's spoken name, in the person's Admin language. */
export type SpokenKey =
	| "command"
	| "control"
	| "shift"
	| "option"
	| "alt"
	| "up"
	| "down"
	| "left"
	| "right"
	| "enter"
	| "delete"
	| "forwardDelete"
	| "escape"
	| "space"
	| "slash"
	| "letter"
	| "asterisk"
	| "leftBracket"
	| "rightBracket";
export type KeyWords = (name: SpokenKey) => string;
const ARIA: Record<string, string> = { " ": "Space", "/": "Slash" };

function keyName(key: string): string {
	return key.length === 1 ? key.toUpperCase() : key;
}

/** A chord as it shows: `⌘D`, `⇧⌘Z`, `⌥↵` on Apple devices; `Ctrl+D`, `Ctrl+Shift+Z` elsewhere. */
export function chordText(chord: Chord, apple = onApple()): string {
	const key = SYMBOLS[chord.key]?.[apple ? 0 : 1] ?? keyName(chord.key);
	if (apple) return `${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.mod ? "⌘" : ""}${key}`;
	return [chord.mod ? "Ctrl" : "", chord.shift ? "Shift" : "", chord.alt ? "Alt" : "", key].filter(Boolean).join("+");
}

/**
 * A chord as a screen reader says it, its key names from the message catalogue: "Command D",
 * "Option Enter" in English, "Comando D" in Italian. Letters are said as themselves.
 */
export function chordSpoken(chord: Chord, words: KeyWords, apple = onApple()): string {
	const named = SPOKEN[chord.key];
	return [
		chord.mod ? words(apple ? "command" : "control") : "",
		chord.shift ? words("shift") : "",
		chord.alt ? words(apple ? "option" : "alt") : "",
		named ? words(named) : keyName(chord.key),
	]
		.filter(Boolean)
		.join(" ");
}

/** The shortcut's keys as they show (its first chord). */
export function shortcutText(id: ShortcutId, apple = onApple()): string {
	const chord = shortcut(id)?.chords[0];
	return chord ? chordText(chord, apple) : "";
}

/** The shortcut's keys as a screen reader says them (its first chord). */
export function shortcutSpoken(id: ShortcutId, words: KeyWords, apple = onApple()): string {
	const chord = shortcut(id)?.chords[0];
	return chord ? chordSpoken(chord, words, apple) : "";
}

/** Every chord of a shortcut, for `aria-keyshortcuts`: `Meta+D` on Apple devices, `Control+D` elsewhere. */
export function ariaKeys(id: ShortcutId, apple = onApple()): string {
	return (
		(shortcut(id)?.chords ?? [])
			// Type-ahead is a category of keys, not an ARIA key token.
			.filter((chord) => chord.key !== "Letter")
			.map((chord) =>
				[
					chord.mod ? (apple ? "Meta" : "Control") : "",
					chord.shift ? "Shift" : "",
					chord.alt ? "Alt" : "",
					ARIA[chord.key] ?? keyName(chord.key),
				]
					.filter(Boolean)
					.join("+"),
			)
			.join(" ")
	);
}

/** A tooltip with the keys: "Undo (⌘Z)". */
export function withKeys(label: string, id: ShortcutId): string {
	const keys = shortcutText(id);
	return keys ? `${label} (${keys})` : label;
}

/** Whether a key press is one of the shortcut's chords. Ctrl and ⌘ both count as `mod`. */
export function matches(
	event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
	id: ShortcutId,
) {
	const mod = event.ctrlKey || event.metaKey;
	return (shortcut(id)?.chords ?? []).some(
		(chord) =>
			!!chord.mod === mod &&
			!!chord.alt === event.altKey &&
			(chord.key === "Letter"
				? /^\p{L}$/u.test(event.key)
				: chord.key.length === 1
					? event.key.toLowerCase() === chord.key
					: event.key === chord.key) &&
			(!!chord.shift === event.shiftKey || ["/", "*", "Letter"].includes(chord.key)),
	);
}

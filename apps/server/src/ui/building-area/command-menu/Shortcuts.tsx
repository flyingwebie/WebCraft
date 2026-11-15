import { useEffect, useId, useRef, useSyncExternalStore } from "react";

import { type ShortcutId, shortcutText } from "../../builder/shortcuts.ts";
import type { Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";

/**
 * The Keyboard shortcuts list (BA-33; the old Command menu's ⌘/): what the keys do in the building area,
 * listing only what the person may do (a Member: the keys of editing everywhere; Staff also Layers' and
 * the code panes'). ⌘/ (Ctrl+/) opens and closes it; a modal `<dialog>` on the chrome, focus on Close,
 * Escape closes it and focus goes back where it was.
 */

let open = false;
const listeners = new Set<() => void>();

export function toggleShortcuts(next = !open): void {
	if (next === open) return;
	open = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

type KeyWord = keyof Words["shortcuts"]["keys"];
type Row = { word: KeyWord; keys: ShortcutId | string };

const EDITOR: readonly (Row & { staff?: boolean })[] = [
	{ word: "undo", keys: "editor.undo" },
	{ word: "redo", keys: "editor.redo" },
	{ word: "actions", keys: "menu.actions" },
	{ word: "goTo", keys: "menu.goTo" },
	{ word: "insert", keys: "menu.insert", staff: true },
	{ word: "shortcuts", keys: "menu.shortcuts" },
	{ word: "regions", keys: "editor.regions" },
	{ word: "toolbar", keys: "Alt F10" },
	{ word: "escape", keys: "Esc", staff: true },
];
const TREE: readonly Row[] = [
	{ word: "rows", keys: "↑ ↓" },
	{ word: "moveUp", keys: "tree.moveUp" },
	{ word: "moveDown", keys: "tree.moveDown" },
	{ word: "moveIn", keys: "tree.moveIn" },
	{ word: "moveOut", keys: "tree.moveOut" },
	{ word: "pick", keys: "Space" },
	{ word: "putBack", keys: "Esc" },
	{ word: "cut", keys: "tree.cut" },
	{ word: "copy", keys: "tree.copy" },
	{ word: "paste", keys: "tree.paste" },
	{ word: "duplicate", keys: "element.duplicate" },
	{ word: "delete", keys: "element.delete" },
	{ word: "rename", keys: "tree.rename" },
	{ word: "menu", keys: "tree.layerMenu" },
];
const CODE: readonly Row[] = [
	{ word: "save", keys: "editor.save" },
	{ word: "format", keys: "editor.format" },
];

/** A row's keys as they read on this device: a shortcut's own (⌘Z or Ctrl+Z), or the words given. */
function keysOf(keys: string): string {
	return keys.includes(".") ? shortcutText(keys as ShortcutId) || keys : keys;
}

export function ShortcutsList({ words, staff }: { words: Words; staff: boolean }) {
	const shown = useSyncExternalStore(subscribe, () => open);
	return shown ? <ShortcutsDialog words={words} staff={staff} /> : null;
}

function ShortcutsDialog({ words, staff }: { words: Words; staff: boolean }) {
	const said = words.shortcuts;
	const dialog = useRef<HTMLDialogElement>(null);
	const close = useRef<HTMLButtonElement>(null);
	const id = useId();
	useEffect(() => {
		const opened = dialog.current;
		const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		if (opened && !opened.open) opened.showModal();
		close.current?.focus();
		return () => {
			opened?.close();
			if (back?.isConnected) back.focus();
		};
	}, []);
	const groups: { name: string; rows: readonly Row[] }[] = [
		{ name: said.groups.editor, rows: EDITOR.filter((row) => staff || !row.staff) },
		...(staff
			? [
					{ name: said.groups.tree, rows: TREE },
					{ name: said.groups.code, rows: CODE },
				]
			: []),
	];
	return (
		<dialog
			ref={dialog}
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-intro`}
			onCancel={(event) => {
				event.preventDefault();
				toggleShortcuts(false);
			}}
			className="bg-chrome-menu text-chrome-text border-chrome-hover m-auto max-h-[calc(100dvh-64px)] w-[560px] max-w-[calc(100vw-32px)] overflow-auto rounded-[10px] border p-4 font-sans shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/50"
			data-wc-shortcuts=""
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 id={`${id}-title`} className="text-chrome-strong m-0 text-[14px] font-semibold">
						{said.title}
					</h2>
					<p id={`${id}-intro`} className="text-chrome-muted m-0 mt-1 text-[12px]">
						{said.intro}
					</p>
				</div>
				<button
					ref={close}
					type="button"
					onClick={() => toggleShortcuts(false)}
					className={`text-chrome-text hover:bg-chrome-hover h-8 shrink-0 rounded-[7px] px-3 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
				>
					{said.close}
				</button>
			</div>
			{groups.map((group) => (
				<section key={group.name} aria-label={group.name} className="mt-3">
					<h3 className="text-chrome-muted m-0 mb-1 text-[11px] font-semibold tracking-[0.06em] uppercase">
						{group.name}
					</h3>
					<dl className="m-0 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
						{group.rows.map((row) => (
							<div key={row.word} className="contents">
								<dt className="text-[12px]">{said.keys[row.word]}</dt>
								<dd className="text-chrome-strong m-0 font-mono text-[12px]">{keysOf(row.keys)}</dd>
							</div>
						))}
					</dl>
				</section>
			))}
		</dialog>
	);
}

import {
	ChevronRightIcon,
	ClipboardPasteIcon,
	ComponentIcon,
	CopyIcon,
	CopyPlusIcon,
	CornerDownRightIcon,
	Trash2Icon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { shortcutText } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import type { InsertQuestion } from "../command-menu/state.ts";
import type { Icon } from "../controls.tsx";
import type { LayerOps, PlainWrap } from "../editing/layer-ops.ts";

/** What the tree row's menu needs besides the selection's actions. */
export type RowMenuHost = {
	ops: LayerOps;
	/** Asks for a name, then moves the selection into a new Component. */
	makeComponent(): void;
	/** Wrap in a Loop or a Condition: the Command menu asks its question. */
	ask(question: Extract<InsertQuestion, "loop" | "condition">): void;
};

type Item =
	| { id: string; label: string; icon: Icon; keys?: string; danger?: boolean; run(): void }
	| { id: "wrap"; label: string; icon: Icon; submenu: { id: string; label: string; run(): void }[] };

/**
 * A tree row's menu (BA-10, `docking/07`'s "A row's menu"): Copy, Paste, Duplicate, Wrap in (a Div, a
 * Section, a Link, a Loop or a Condition), Make Component, and Delete in red under a rule. Opened by a
 * right-click at the pointer, or by Shift+F10 or the menu key under the row; its first item takes
 * focus, the arrows move, Right opens Wrap in, Escape puts focus back on the row.
 */
export function RowMenu({
	words,
	host,
	name,
	at,
	onClose,
}: {
	words: Words;
	host: RowMenuHost;
	/** The row's name, for the menu's own name. */
	name: string;
	/** Where it opens on the window. */
	at: { x: number; y: number };
	onClose(refocus: boolean): void;
}) {
	const said = words.rowMenu;
	const wraps = words.commandMenu.wrap;
	const menu = useRef<HTMLDivElement>(null);
	const submenu = useRef<HTMLDivElement>(null);
	const [wrapOpen, setWrapOpen] = useState(false);
	const { ops } = host;
	const plain = (kind: PlainWrap) => ({ id: kind, label: wraps[kind], run: () => void ops.wrap(kind, wraps[kind]) });
	const items: Item[] = [
		{ id: "copy", label: said.copy, icon: CopyIcon, keys: shortcutText("tree.copy"), run: () => void ops.copy() },
		...(ops.copied()
			? [
					{
						id: "paste",
						label: said.paste,
						icon: ClipboardPasteIcon,
						keys: shortcutText("tree.paste"),
						run: () => void ops.paste(),
					},
				]
			: []),
		{
			id: "duplicate",
			label: said.duplicate,
			icon: CopyPlusIcon,
			keys: shortcutText("element.duplicate"),
			run: () => void ops.duplicate(),
		},
		{
			id: "wrap",
			label: said.wrapIn,
			icon: CornerDownRightIcon,
			submenu: [
				plain("div"),
				plain("section"),
				plain("a"),
				{ id: "loop", label: wraps.loop, run: () => host.ask("loop") },
				{ id: "condition", label: wraps.condition, run: () => host.ask("condition") },
			],
		},
		{ id: "makeComponent", label: said.makeComponent, icon: ComponentIcon, run: host.makeComponent },
		{
			id: "delete",
			label: said.delete,
			icon: Trash2Icon,
			keys: shortcutText("element.delete"),
			danger: true,
			run: () => void ops.remove(),
		},
	];

	useEffect(() => {
		menu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
		const away = (event: PointerEvent) => {
			if (!menu.current?.contains(event.target as Node)) onClose(false);
		};
		document.addEventListener("pointerdown", away, true);
		return () => document.removeEventListener("pointerdown", away, true);
	}, [onClose]);

	const move = (container: HTMLElement | null, event: KeyboardEvent, onLeft?: () => void) => {
		const entries = [
			...(container?.querySelectorAll<HTMLElement>(":scope > [role=menuitem], :scope > div > [role=menuitem]") ?? []),
		];
		const at = entries.indexOf(document.activeElement as HTMLElement);
		const go = (index: number) => entries[(index + entries.length) % entries.length]?.focus();
		if (event.key === "ArrowDown") go(at + 1);
		else if (event.key === "ArrowUp") go(at - 1);
		else if (event.key === "Home") go(0);
		else if (event.key === "End") go(entries.length - 1);
		else if (event.key === "ArrowLeft" && onLeft) onLeft();
		else if (event.key === "Escape") onClose(true);
		else if (event.key === "Tab") onClose(false);
		else return;
		event.preventDefault();
		event.stopPropagation();
	};

	const choose = (run: () => void) => {
		onClose(true);
		// Once focus is back on the row, the action runs (a dialog it opens keeps focus).
		setTimeout(run, 0);
	};

	const left = Math.min(at.x, window.innerWidth - 240);
	const top = Math.min(at.y, window.innerHeight - 260);

	return (
		<div
			ref={menu}
			role="menu"
			aria-label={fill(said.label, { name })}
			onKeyDown={(event) => move(menu.current, event)}
			className="bg-chrome-menu border-chrome-hover fixed z-50 flex w-[220px] flex-col rounded-lg border p-1 font-sans text-[12px] shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
			style={{ left, top }}
			data-wc-row-menu=""
		>
			{items.map((item) => {
				const Glyph = item.icon;
				if ("submenu" in item)
					return (
						<div key={item.id} className="relative">
							<div
								role="menuitem"
								tabIndex={-1}
								aria-haspopup="menu"
								aria-expanded={wrapOpen}
								onClick={() => setWrapOpen(true)}
								onKeyDown={(event) => {
									if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
										event.preventDefault();
										event.stopPropagation();
										setWrapOpen(true);
										requestAnimationFrame(() =>
											submenu.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(),
										);
									}
								}}
								onPointerEnter={() => setWrapOpen(true)}
								className="text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex h-[30px] cursor-default items-center gap-2 rounded-md px-2 outline-none"
								data-wc-row-menu-item={item.id}
							>
								<Glyph aria-hidden="true" className="size-3.5 shrink-0" />
								<span className="grow">{item.label}</span>
								<ChevronRightIcon aria-hidden="true" className="text-chrome-muted size-3.5 rtl:rotate-180" />
							</div>
							{wrapOpen ? (
								<div
									ref={submenu}
									role="menu"
									aria-label={item.label}
									onKeyDown={(event) =>
										move(submenu.current, event, () => {
											setWrapOpen(false);
											menu.current?.querySelector<HTMLElement>('[data-wc-row-menu-item="wrap"]')?.focus();
										})
									}
									className="bg-chrome-menu border-chrome-hover absolute start-[calc(100%+4px)] top-0 flex w-[180px] flex-col rounded-lg border p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
								>
									{item.submenu.map((entry) => (
										<div
											key={entry.id}
											role="menuitem"
											tabIndex={-1}
											onClick={() => choose(entry.run)}
											onKeyDown={(event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													choose(entry.run);
												}
											}}
											className="text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex h-[30px] cursor-default items-center rounded-md px-2 outline-none"
											data-wc-row-menu-item={`wrap-${entry.id}`}
										>
											{entry.label}
										</div>
									))}
								</div>
							) : null}
						</div>
					);
				return (
					<div key={item.id} className="contents">
						{item.danger ? <hr className="border-chrome-line my-1 border-t" /> : null}
						<div
							role="menuitem"
							tabIndex={-1}
							onClick={() => choose(item.run)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									choose(item.run);
								}
							}}
							onPointerEnter={() => setWrapOpen(false)}
							className={`hover:bg-chrome-hover focus:bg-chrome-hover flex h-[30px] cursor-default items-center gap-2 rounded-md px-2 outline-none ${item.danger ? "text-chrome-danger" : "text-chrome-text"}`}
							data-wc-row-menu-item={item.id}
						>
							<Glyph
								aria-hidden="true"
								className={`size-3.5 shrink-0 ${item.id === "makeComponent" ? "text-[#a78bfa]" : ""}`}
							/>
							<span className="grow">{item.label}</span>
							{item.keys ? (
								<span aria-hidden="true" className="text-chrome-muted font-mono text-[11px]">
									{item.keys}
								</span>
							) : null}
						</div>
					</div>
				);
			})}
		</div>
	);
}

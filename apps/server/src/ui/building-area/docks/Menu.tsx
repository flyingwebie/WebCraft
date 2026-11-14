import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

import { CHROME_EASE, FOCUS_RING, type Icon } from "../controls.tsx";

/** One line of a chrome menu: an action, a switch, or a line between groups. */
export type MenuEntry =
	| { kind: "item"; key: string; icon?: Icon; label: string; onSelect(): void }
	| { kind: "switch"; key: string; label: string; checked: boolean; onToggle(): void }
	| { kind: "separator"; key: string };

/** Where a menu opens: below its button (a panel's header), or beside it (the rail). */
export type MenuPlacement = "below" | "beside";

/** The space a menu keeps from the window's edges. */
const EDGE = 8;

/**
 * A menu on the chrome (`docking/02`, `docking/03`): 6 padding, items 28 high, a switch per panel in
 * the Panels menu. It appears at once (SPEC 10), takes focus on its first item, and has the keys menus
 * have: arrows, Home, End, Escape (back to its button), Tab (closes). A pointer press outside closes it.
 * An action closes it; a switch keeps it open.
 */
export function ChromeMenu({
	open,
	onClose,
	anchor,
	placement,
	label,
	entries,
	width = 208,
	id,
}: {
	open: boolean;
	/** Closes the menu; `focusButton` puts focus back on the button that opened it. */
	onClose(focusButton: boolean): void;
	anchor: RefObject<HTMLElement | null>;
	placement: MenuPlacement;
	label: string;
	entries: readonly MenuEntry[];
	width?: number;
	id?: string;
}) {
	const menu = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

	useLayoutEffect(() => {
		if (!open) {
			setPosition(null);
			return;
		}
		const place = () => {
			const button = anchor.current?.getBoundingClientRect();
			const box = menu.current;
			if (!button || !box) return;
			const height = box.offsetHeight;
			const rtl = getComputedStyle(box).direction === "rtl";
			const maxLeft = window.innerWidth - width - EDGE;
			let left: number;
			let top: number;
			if (placement === "beside") {
				left = rtl ? button.left - 6 - width : button.right + 6;
				// Level with the button, raised as far as it must be to stay above the bottom bar.
				top = Math.min(button.top - 54, window.innerHeight - 48 - height - EDGE);
			} else {
				left = rtl ? button.left : button.right - width;
				top = button.bottom + 4;
				if (top + height > window.innerHeight - EDGE) top = Math.max(EDGE, button.top - 4 - height);
			}
			setPosition({ left: Math.max(EDGE, Math.min(maxLeft, left)), top: Math.max(EDGE, top) });
		};
		place();
		window.addEventListener("resize", place);
		return () => window.removeEventListener("resize", place);
	}, [open, anchor, placement, width]);

	useEffect(() => {
		if (!open) return;
		const first = menu.current?.querySelector<HTMLElement>('[role^="menuitem"]');
		first?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menu.current?.contains(target) || anchor.current?.contains(target))) return;
			onClose(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open, anchor, onClose]);

	if (!open) return null;

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
		const at = all.indexOf(document.activeElement as HTMLElement);
		const move = (index: number) => all[(index + all.length) % all.length]?.focus();
		switch (event.key) {
			case "ArrowDown":
				move(at + 1);
				break;
			case "ArrowUp":
				move(at - 1);
				break;
			case "Home":
				move(0);
				break;
			case "End":
				move(all.length - 1);
				break;
			case "Escape":
				onClose(true);
				break;
			case "Tab":
				onClose(false);
				return;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	const itemLook = `text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex h-7 w-full shrink-0 items-center gap-2 rounded-[5px] px-1.5 text-start text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`;

	return (
		<div
			ref={menu}
			id={id}
			role="menu"
			aria-label={label}
			tabIndex={-1}
			onKeyDown={onKey}
			style={{ width, left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
			className="border-chrome-hover bg-chrome-menu fixed z-50 flex flex-col gap-0.5 rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
			data-wc-menu=""
		>
			{entries.map((entry) => {
				if (entry.kind === "separator") {
					return <hr key={entry.key} className="bg-chrome-hover my-0.5 h-px shrink-0 border-0" />;
				}
				if (entry.kind === "switch") {
					return (
						<button
							key={entry.key}
							type="button"
							role="menuitemcheckbox"
							aria-checked={entry.checked}
							tabIndex={-1}
							onClick={entry.onToggle}
							className={itemLook}
							data-wc-switch={entry.key}
						>
							<span className="grow truncate">{entry.label}</span>
							<span
								aria-hidden="true"
								className={`flex h-[15px] w-[26px] shrink-0 items-center rounded-full px-0.5 ${CHROME_EASE} ${
									entry.checked ? "bg-chrome-ok justify-end" : "justify-start bg-[#3f3f46]"
								}`}
							>
								<span className={`size-[11px] rounded-full ${entry.checked ? "bg-[#052e16]" : "bg-[#d4d4d8]"}`} />
							</span>
						</button>
					);
				}
				const Glyph = entry.icon;
				return (
					<button
						key={entry.key}
						type="button"
						role="menuitem"
						tabIndex={-1}
						onClick={() => {
							onClose(false);
							entry.onSelect();
						}}
						className={itemLook}
						data-wc-menu-item={entry.key}
					>
						{Glyph ? <Glyph aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" /> : null}
						<span className="grow truncate">{entry.label}</span>
					</button>
				);
			})}
		</div>
	);
}

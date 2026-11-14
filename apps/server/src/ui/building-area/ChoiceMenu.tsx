import { CheckIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";

import { FOCUS_RING } from "./controls.tsx";

/** One choice of a menu: its key, its words, and whether it is the one in use. */
export type Choice = { key: string; label: string; detail?: string; current?: boolean };

/** Choices under a heading (a menu's group). */
export type ChoiceGroup = { label: string | null; choices: readonly Choice[] };

/**
 * A menu of choices on the chrome, opened by a button (`aria-haspopup="menu"`): radio items in
 * groups, with the keys menus have (arrows, Home, End, Escape back to the button, Tab out). It opens
 * above its button on the bottom bar and below it in a panel's header. The chosen item has focus
 * when it opens, as a select does.
 */
export function ChoiceMenu({
	id,
	label,
	groups,
	button,
	side,
	align = "start",
	onChoose,
	onClose,
}: {
	id: string;
	label: string;
	groups: readonly ChoiceGroup[];
	/** The button that opened it: focus goes back to it, and a press on it isn't "outside". */
	button: RefObject<HTMLElement | null>;
	side: "top" | "bottom";
	align?: "start" | "end";
	onChoose(choice: Choice): void;
	onClose(focusButton: boolean): void;
}): ReactNode {
	const menu = useRef<HTMLDivElement>(null);
	const latest = useRef(onClose);
	latest.current = onClose;

	useEffect(() => {
		const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
		(all.find((item) => item.getAttribute("aria-checked") === "true") ?? all[0])?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
			latest.current(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [button]);

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
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

	const place = `${side === "top" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+4px)]"} ${align === "start" ? "start-0" : "end-0"}`;
	return (
		<div
			ref={menu}
			id={id}
			role="menu"
			aria-label={label}
			tabIndex={-1}
			onKeyDown={onKey}
			className={`border-chrome-hover bg-chrome-menu absolute z-50 flex max-h-[min(420px,70vh)] w-72 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)] ${place}`}
		>
			{groups.map((group) => (
				// biome-ignore lint/a11y/useSemanticElements: a menu groups its items with role="group", never a fieldset.
				<div
					key={group.label ?? ""}
					role="group"
					aria-label={group.label ?? undefined}
					className="flex flex-col gap-0.5"
				>
					{group.label ? (
						<div
							aria-hidden="true"
							className="text-chrome-muted px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wide uppercase"
						>
							{group.label}
						</div>
					) : null}
					{group.choices.map((choice) => (
						<button
							key={choice.key}
							type="button"
							role="menuitemradio"
							aria-checked={Boolean(choice.current)}
							tabIndex={-1}
							onClick={() => {
								onClose(true);
								if (!choice.current) onChoose(choice);
							}}
							className={`text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-start text-[12px] ${FOCUS_RING}`}
							data-wc-choice={choice.key}
						>
							<span className="min-w-0 grow truncate">{choice.label}</span>
							{choice.detail ? (
								<span className="text-chrome-muted shrink-0 truncate font-mono text-[11px]">{choice.detail}</span>
							) : null}
							{choice.current ? (
								<CheckIcon aria-hidden="true" className="text-chrome-strong size-3.5 shrink-0" />
							) : null}
						</button>
					))}
				</div>
			))}
		</div>
	);
}

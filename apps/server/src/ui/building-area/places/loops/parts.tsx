import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type SelectHTMLAttributes,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

import { CHROME_EASE, FOCUS_RING } from "../../controls.tsx";

/**
 * What the Loops place draws with (`places-assets/08`): the definition's 30 px fields on the chrome
 * (a select with its chevron, a text box), a menu of switches for choosing several things, the
 * columns' small capitals, a section's label, and the Form / Markup switch.
 */

/** A 30 px field of the definition: the chrome's colour, a 1 px line, radius 6. */
export const FIELD_LOOK = `border-chrome-hover bg-chrome text-chrome-text h-[30px] min-w-0 rounded-md border px-2 text-[12px] ${CHROME_EASE} ${FOCUS_RING}`;

/** A select of the chrome, with the chevron the frame draws (the browser's menu, in the dark scheme). */
export function Select({
	className,
	children,
	bare,
	...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { bare?: boolean; children: ReactNode }) {
	return (
		<span className={`relative inline-flex min-w-0 ${className ?? ""}`}>
			<select
				{...rest}
				className={`w-full min-w-0 appearance-none pe-7 [color-scheme:dark] ${
					bare ? `text-chrome-strong h-5 rounded-sm bg-transparent text-[12px] font-medium ${FOCUS_RING}` : FIELD_LOOK
				}`}
			>
				{children}
			</select>
			<ChevronDownIcon
				aria-hidden="true"
				className={`text-chrome-muted pointer-events-none absolute top-1/2 size-3 -translate-y-1/2 ${bare ? "end-0" : "end-2"}`}
			/>
		</span>
	);
}

/** A column's name in small capitals ("DEFINITION", "RESULT"). */
export function ColumnLabel({ id, children }: { id?: string; children: ReactNode }) {
	return (
		<h2 id={id} className="text-chrome-muted m-0 grow text-[12px] font-semibold tracking-[0.4px] uppercase">
			{children}
		</h2>
	);
}

/** A section's label in the definition ("Match", "Order"). */
export function SectionLabel({ id, children }: { id?: string; children: ReactNode }) {
	return (
		<h3 id={id} className="text-chrome-strong m-0 text-[13px] font-semibold">
			{children}
		</h3>
	);
}

/** A badge in the Loop's colour ("Used on 2 pages"). */
export function LoopBadge({ children }: { children: ReactNode }) {
	return (
		<span className="bg-loop/15 text-loop inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-medium whitespace-nowrap">
			{children}
		</span>
	);
}

/** Two choices side by side, the chosen one raised: the definition as Form or Markup. */
export function Segmented<Key extends string>({
	label,
	choices,
	value,
	onChange,
}: {
	label: string;
	choices: readonly { key: Key; label: string }[];
	value: Key;
	onChange(key: Key): void;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: two pressed buttons in a named group, not a fieldset of a form.
		<div
			role="group"
			aria-label={label}
			className="bg-chrome-raised flex gap-0.5 rounded-lg p-0.5"
			data-wc-loop-mode=""
		>
			{choices.map((choice) => (
				<button
					key={choice.key}
					type="button"
					aria-pressed={choice.key === value}
					onClick={() => onChange(choice.key)}
					className={`inline-flex h-[26px] items-center justify-center rounded-md px-3 text-[12px] font-medium ${
						choice.key === value ? "bg-chrome-hover text-chrome-strong" : "text-chrome-muted hover:text-chrome-text"
					} ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-mode={choice.key}
				>
					{choice.label}
				</button>
			))}
		</div>
	);
}

/** One choice of a menu of switches: its key, its words, whether it is on. */
export type Check = { key: string; label: string; checked: boolean };

/**
 * A button that opens a menu of switches (`menuitemcheckbox`), for choosing several things at once
 * (the Post Types a Loop lists, chosen Entries): arrows, Home and End move, Space or Enter switch the
 * one with focus and the menu stays open, Escape goes back to the button, Tab leaves.
 */
export function CheckMenu({
	label,
	shown,
	checks,
	onToggle,
	bare,
	disabled,
	data,
}: {
	/** The menu's name, which the button's name starts with. */
	label: string;
	/** What the button says: the chosen ones' names. */
	shown: string;
	checks: readonly Check[];
	onToggle(key: string, checked: boolean): void;
	/** Drawn as a card's value (Loop settings) rather than a field of its own. */
	bare?: boolean;
	disabled?: boolean;
	data?: Record<`data-${string}`, string>;
}) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();

	useEffect(() => {
		if (!open) return;
		menu.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open]);

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]') ?? [])];
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
				setOpen(false);
				button.current?.focus();
				break;
			case "Tab":
				setOpen(false);
				return;
			default:
				return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<span className="relative flex min-w-0">
			<button
				ref={button}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				aria-label={`${label}: ${shown}`}
				disabled={disabled}
				onClick={() => setOpen((was) => !was)}
				className={`flex w-full min-w-0 items-center gap-2 text-start disabled:opacity-60 ${
					bare
						? `text-chrome-strong h-5 rounded-sm text-[12px] font-medium ${FOCUS_RING}`
						: `${FIELD_LOOK} hover:bg-chrome-raised`
				}`}
				{...data}
			>
				<span className="min-w-0 grow truncate">{shown}</span>
				<ChevronDownIcon aria-hidden="true" className="text-chrome-muted size-3 shrink-0" />
			</button>
			{open ? (
				<div
					ref={menu}
					id={id}
					role="menu"
					aria-label={label}
					tabIndex={-1}
					onKeyDown={onKey}
					className="border-chrome-hover bg-chrome-menu absolute start-0 top-[calc(100%+4px)] z-50 flex max-h-72 w-64 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
				>
					{checks.map((check) => (
						<button
							key={check.key}
							type="button"
							role="menuitemcheckbox"
							aria-checked={check.checked}
							tabIndex={-1}
							onClick={() => onToggle(check.key, !check.checked)}
							className={`text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-start text-[12px] ${FOCUS_RING}`}
							data-wc-check={check.key}
						>
							<span
								aria-hidden="true"
								className={`grid size-3.5 shrink-0 place-items-center rounded-[3px] border ${
									check.checked ? "border-chrome-strong bg-chrome-strong text-[#18181b]" : "border-chrome-muted"
								}`}
							>
								{check.checked ? <CheckIcon className="size-3" /> : null}
							</span>
							<span className="min-w-0 grow truncate">{check.label}</span>
						</button>
					))}
				</div>
			) : null}
		</span>
	);
}

/** Puts text on the clipboard; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

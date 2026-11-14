import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";

import type { Words } from "../../api.ts";
import { type ChoiceGroup, ChoiceMenu } from "../../ChoiceMenu.tsx";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../../controls.tsx";

/**
 * The pieces the Content place draws with (SPEC 4 and 8, `places-content/01`, `client-flows/02`): the
 * inner sidebar's group titles and rows (31 high, radius 6), status badges, the filter chips, the
 * grid's menus and the filled buttons of a place.
 */

/** A place's filled button: the primary orange (Create, New), or quiet. */
export function buttonLook(variant: "primary" | "quiet" | "outline"): string {
	const look = {
		primary: "bg-primary text-primary-foreground hover:bg-primary/90",
		quiet: "bg-chrome-raised text-chrome-text hover:bg-chrome-hover",
		outline: "border border-chrome-hover text-chrome-text hover:bg-chrome-hover",
	}[variant];
	return `inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[7px] px-2.5 text-[12px] font-semibold disabled:opacity-60 ${look} ${CHROME_EASE} ${FOCUS_RING}`;
}

/** A group title of the inner sidebar (32 high), with a badge and a small add button after it. */
export function SidebarLabel({ children, badge, add }: { children: ReactNode; badge?: ReactNode; add?: ReactNode }) {
	return (
		<div className="flex h-8 items-center gap-2 px-2">
			<h2 className="text-chrome-strong m-0 text-[12px] font-semibold">{children}</h2>
			{badge}
			{add ? <span className="ms-auto inline-flex">{add}</span> : null}
		</div>
	);
}

/** A row of the inner sidebar: an icon, its name and a count; the open one is drawn raised. */
export function SidebarRow({
	icon: Glyph,
	label,
	count,
	current,
	onOpen,
	data,
}: {
	icon: Icon;
	label: string;
	count?: number | null;
	current: boolean;
	onOpen(): void;
	data?: Record<`data-${string}`, string>;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			aria-current={current ? "page" : undefined}
			className={`flex h-[31px] w-full items-center gap-2 rounded-md px-2 text-start text-[12px] font-medium ${
				current
					? "bg-chrome-raised text-chrome-strong"
					: "text-chrome-muted hover:bg-chrome-raised hover:text-chrome-text"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			{...data}
		>
			<Glyph aria-hidden="true" className="size-3.5 shrink-0" />
			<span className="min-w-0 grow truncate">{label}</span>
			{count != null ? (
				<span
					className={`inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-[5px] text-[11px] font-semibold ${
						current ? "bg-chrome-strong text-[#18181b]" : "bg-chrome-hover text-chrome-muted"
					}`}
				>
					{count}
				</span>
			) : null}
		</button>
	);
}

/** A small badge on the chrome: a status in words. */
export type BadgeKind = "neutral" | "draft" | "live" | "info";

const BADGE: Record<BadgeKind, string> = {
	neutral: "bg-chrome-hover text-chrome-text",
	draft: "bg-[#422006] text-chrome-warn",
	live: "bg-[#0f2e1c] text-chrome-ok",
	info: "bg-[#172554] text-[#bfdbfe]",
};

export function Badge({ kind, children }: { kind: BadgeKind; children: ReactNode }) {
	return (
		<span
			className={`inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-medium whitespace-nowrap ${BADGE[kind]}`}
		>
			{children}
		</span>
	);
}

/** An Entry's status as a badge: Published, Draft, Unpublished changes; In review beside it while it waits. */
export function StatusBadges({
	words,
	status,
	inReview,
	memberWords = false,
}: {
	words: Words;
	status: "draft" | "published" | "changed";
	inReview: boolean;
	/** A Member's list says only Published, Draft or In review. */
	memberWords?: boolean;
}) {
	const shown = words.content.status;
	if (memberWords && inReview) return <Badge kind="info">{shown.review}</Badge>;
	return (
		<span className="flex min-w-0 flex-wrap items-center gap-1">
			{status === "published" || (memberWords && status === "changed") ? (
				<Badge kind="live">{shown.published}</Badge>
			) : status === "draft" ? (
				<Badge kind="draft">{shown.draft}</Badge>
			) : (
				<Badge kind="info">{shown.changed}</Badge>
			)}
			{inReview ? <Badge kind="neutral">{shown.review}</Badge> : null}
		</span>
	);
}

/** A filter chip (30 high): "Status: All ⌄", a menu of its choices below it. */
export function FilterMenu({
	label,
	shown,
	groups,
	onChoose,
	data,
}: {
	/** The menu's name ("Status"). */
	label: string;
	/** What the chip says ("Status: All"). */
	shown: string;
	groups: readonly ChoiceGroup[];
	onChoose(key: string): void;
	data?: Record<`data-${string}`, string>;
}) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const id = useId();
	return (
		<span className="relative inline-flex">
			<button
				ref={button}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				onClick={() => setOpen((was) => !was)}
				className={`border-chrome-hover bg-chrome-raised text-chrome-text hover:bg-chrome-hover inline-flex h-[30px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium whitespace-nowrap ${CHROME_EASE} ${FOCUS_RING}`}
				{...data}
			>
				{shown}
				<ChevronDownIcon aria-hidden="true" className="text-chrome-muted size-3" />
			</button>
			{open ? (
				<ChoiceMenu
					id={id}
					label={label}
					groups={groups}
					button={button}
					side="bottom"
					align="end"
					onChoose={(choice) => onChoose(choice.key)}
					onClose={(focusButton) => {
						setOpen(false);
						if (focusButton) button.current?.focus();
					}}
				/>
			) : null}
		</span>
	);
}

/** An icon button of a place (24 or 30 square), with its name as a tooltip. */
export function PlaceIconButton({
	icon: Glyph,
	label,
	onClick,
	size = 24,
	unavailable,
	data,
	expanded,
	controls,
	buttonRef,
}: {
	icon: Icon;
	label: string;
	onClick?(): void;
	size?: 24 | 30;
	/** Shown, but not for now: says so in its name and tooltip. */
	unavailable?: string;
	data?: Record<`data-${string}`, string>;
	expanded?: boolean;
	controls?: string;
	buttonRef?: Ref<HTMLButtonElement>;
}) {
	const name = unavailable ? `${label} · ${unavailable}` : label;
	return (
		<span className="group relative inline-flex">
			<button
				ref={buttonRef}
				type="button"
				aria-label={name}
				aria-disabled={unavailable ? true : undefined}
				aria-haspopup={expanded === undefined ? undefined : "menu"}
				aria-expanded={expanded}
				aria-controls={controls}
				onClick={unavailable ? undefined : onClick}
				className={`text-chrome-muted inline-grid shrink-0 place-items-center rounded-[5px] ${
					size === 30 ? "size-[30px]" : "size-6"
				} ${unavailable ? "cursor-default opacity-50" : "hover:bg-chrome-hover hover:text-chrome-strong"} ${CHROME_EASE} ${FOCUS_RING}`}
				{...data}
			>
				<Glyph aria-hidden="true" className="size-3.5" />
			</button>
			<Tip label={name} side="bottom" />
		</span>
	);
}

/** One action of an action menu. */
export type Action = { key: string; label: string; run(): void };

/** A menu of actions (`role="menu"`) under an icon button: arrows, Home, End, Escape back, Tab out. */
export function ActionMenu({
	icon,
	label,
	actions,
	data,
}: {
	icon: Icon;
	label: string;
	actions: readonly Action[];
	data?: Record<`data-${string}`, string>;
}) {
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const id = useId();

	useEffect(() => {
		if (!open) return;
		menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
		const outside = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && (menu.current?.contains(target) || button.current?.contains(target))) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [open]);

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
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
		<span className="relative inline-flex">
			<PlaceIconButton
				icon={icon}
				label={label}
				onClick={() => setOpen((was) => !was)}
				expanded={open}
				controls={open ? id : undefined}
				buttonRef={button}
				data={data}
			/>
			{open ? (
				<div
					ref={menu}
					id={id}
					role="menu"
					aria-label={label}
					tabIndex={-1}
					onKeyDown={onKey}
					className="border-chrome-hover bg-chrome-menu absolute end-0 top-[calc(100%+4px)] z-50 flex w-56 flex-col gap-0.5 rounded-lg border p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
				>
					{actions.map((action) => (
						<button
							key={action.key}
							type="button"
							role="menuitem"
							tabIndex={-1}
							onClick={() => {
								setOpen(false);
								button.current?.focus();
								action.run();
							}}
							className={`text-chrome-text hover:bg-chrome-hover focus:bg-chrome-hover flex h-7 items-center rounded-[5px] px-1.5 text-start text-[12px] font-medium ${FOCUS_RING}`}
							data-wc-action={action.key}
						>
							{action.label}
						</button>
					))}
				</div>
			) : null}
		</span>
	);
}

/** The add button after a sidebar's group title (the Post Types' "+"). */
export const AddIcon = PlusIcon;

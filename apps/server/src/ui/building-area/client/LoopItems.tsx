import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	ArrowUpRightIcon,
	CopyIcon,
	ListIcon,
	RefreshCwIcon,
	Trash2Icon,
	Undo2Icon,
	XIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../controls.tsx";
import { type LoopItems as LoopItemsController, REMOVED_FOR_MS } from "./loop-items.ts";

/** The item bar's height: it sits on the item's top edge, half above it (`client/05`). */
const BAR_HEIGHT = 32;
/** Where the query chip sits inside its item, from the item's corner. */
const CHIP_INSET = 16;
const CHIP_WIDTH = 260;

/**
 * What client editing draws for Loop items (BA-16, `client/05`), over the page: the selected item's
 * bar, a query Loop's item's chip, and "{item} removed · Undo" for 8 seconds. They follow the page as
 * it moves; the outlines and the "Add" cards are drawn by `loop-items.ts`, the item's Fields by
 * `ItemPanel.tsx`.
 */
export function LoopItems({ items, words }: { items: LoopItemsController; words: Words }) {
	const { selected, query, removed, busy } = useSyncExternalStore(items.subscribe, items.snapshot);
	const [, setMoved] = useState(0);
	useEffect(() => items.onMove(() => setMoved((count) => count + 1)), [items]);
	// The Alt+F10 already answered, kept here: the bar and the chip are drawn anew when it selects.
	const barReached = useRef(selected?.reach ?? 0);
	const chipReached = useRef(query?.reach ?? 0);
	const canvas = items.canvasBox();
	const selectedBox = selected ? items.boxOf(selected.key) : null;
	const queryBox = query ? items.boxOf(query.key) : null;
	return (
		<>
			{selected && selectedBox && canvas ? (
				<ItemBar
					items={items}
					words={words}
					name={selected.name}
					itemKey={selected.key}
					first={selected.index === 0}
					last={selected.index === selected.count - 1}
					across={selected.across}
					reach={selected.reach}
					reached={barReached}
					busy={busy}
					left={clamp(selectedBox.left + 8, canvas.left + 4, canvas.right - 240)}
					top={clamp(selectedBox.top - 6 - BAR_HEIGHT / 2, canvas.top + 4, canvas.bottom - BAR_HEIGHT - 4)}
				/>
			) : null}
			{query && queryBox && canvas ? (
				<QueryChip
					items={items}
					words={words}
					itemKey={query.key}
					from={query.from}
					link={query.link}
					reach={query.reach}
					reached={chipReached}
					left={clamp(queryBox.left + CHIP_INSET, canvas.left + 4, canvas.right - CHIP_WIDTH - 4)}
					top={clamp(queryBox.top + CHIP_INSET, canvas.top + 4, canvas.bottom - 96)}
				/>
			) : null}
			{removed ? <RemovedToast key={removed.at} words={words} name={removed.name} items={items} busy={busy} /> : null}
		</>
	);
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(value, Math.max(low, high)));
}

/**
 * The selected item's bar (SPEC 13.3): its name, a rule, then move earlier, move later, duplicate and
 * remove. A toolbar: Alt+F10 from the item reaches it, the arrow keys, Home and End move between its
 * buttons, Escape gives focus back to the item.
 */
function ItemBar({
	items,
	words,
	name,
	itemKey,
	first,
	last,
	across,
	reach,
	reached,
	busy,
	left,
	top,
}: {
	items: LoopItemsController;
	words: Words;
	name: string;
	itemKey: string;
	first: boolean;
	last: boolean;
	across: boolean;
	reach: number;
	reached: { current: number };
	busy: boolean;
	left: number;
	top: number;
}) {
	const said = words.client.items;
	const bar = useRef<HTMLDivElement>(null);
	const [current, setCurrent] = useState(0);
	const tools: { key: string; label: string; icon: Icon; off: boolean; act(): void }[] = [
		{
			key: "earlier",
			label: said.moveEarlier,
			icon: across ? ArrowLeftIcon : ArrowUpIcon,
			off: first,
			act: () => void items.move(-1),
		},
		{
			key: "later",
			label: said.moveLater,
			icon: across ? ArrowRightIcon : ArrowDownIcon,
			off: last,
			act: () => void items.move(1),
		},
		{ key: "duplicate", label: said.duplicate, icon: CopyIcon, off: false, act: () => void items.duplicate() },
		{ key: "remove", label: said.remove, icon: Trash2Icon, off: false, act: () => void items.remove() },
	];
	const usable = tools.flatMap((tool, index) => (tool.off ? [] : [index]));
	// The button reached with Tab is the last one used, or the first that can be used.
	const shown = usable.includes(current) ? current : (usable[0] ?? 0);

	// Alt+F10 from the item: focus goes to the bar.
	useEffect(() => {
		if (reach === reached.current) return;
		reached.current = reach;
		bar.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
	}, [reach, reached]);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// From the button focus is on, even one a move just turned off.
		const from = current;
		let next: number | undefined;
		if (event.key === "ArrowRight" || event.key === "ArrowDown")
			next = usable.find((index) => index > from) ?? usable[0];
		else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
			next = [...usable].reverse().find((index) => index < from) ?? usable.at(-1);
		else if (event.key === "Home") next = usable[0];
		else if (event.key === "End") next = usable.at(-1);
		else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			items.focusItem(itemKey);
			return;
		} else return;
		event.preventDefault();
		if (next === undefined) return;
		setCurrent(next);
		bar.current?.querySelectorAll<HTMLElement>("[data-wc-item-tool]")[next]?.focus();
	};

	return (
		<div
			ref={bar}
			role="toolbar"
			aria-label={fill(said.tools, { name })}
			aria-orientation="horizontal"
			onKeyDown={onKeyDown}
			className="border-chrome-hover fixed z-20 flex h-8 max-w-[360px] items-center gap-0.5 rounded-lg border bg-[#18181b] ps-2.5 pe-1 shadow-[0_8px_20px_rgba(0,0,0,0.4)]"
			style={{ left, top }}
			data-wc-item-bar=""
		>
			<ListIcon aria-hidden="true" className="text-chrome-text size-[13px] shrink-0" />
			<span
				className="text-chrome-strong min-w-0 truncate ps-1.5 pe-2 text-[12px] font-semibold"
				data-wc-item-bar-name=""
			>
				{name}
			</span>
			<span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-[#3f3f46]" />
			{tools.map((tool, index) => (
				<button
					key={tool.key}
					type="button"
					aria-label={tool.label}
					// Off, not disabled: a move that took the item to an end keeps focus on its button.
					aria-disabled={tool.off || busy ? true : undefined}
					tabIndex={index === shown ? 0 : -1}
					onFocus={() => setCurrent(index)}
					onClick={() => {
						if (!tool.off && !busy) tool.act();
					}}
					className={`group text-chrome-text hover:bg-chrome-hover hover:text-chrome-strong relative inline-grid size-[26px] shrink-0 place-items-center rounded-md aria-disabled:opacity-35 ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-item-tool={tool.key}
				>
					<tool.icon aria-hidden="true" className="size-3.5" />
					<Tip label={tool.label} side="top" />
				</button>
			))}
		</div>
	);
}

/**
 * The chip of a query Loop's item (SPEC 13.3): it says where the items come from ("These are your
 * latest Blog posts") and opens the Entry's own page in the shell, or its editor in the admin. It
 * stays while the pointer is on it or focus is in it.
 */
function QueryChip({
	items,
	words,
	itemKey,
	from,
	link,
	reach,
	reached,
	left,
	top,
}: {
	items: LoopItemsController;
	words: Words;
	itemKey: string;
	from: string;
	link: { href: string; page: boolean } | null;
	reach: number;
	reached: { current: number };
	left: number;
	top: number;
}) {
	const said = words.client.items.query;
	const action = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (reach === reached.current) return;
		reached.current = reach;
		action.current?.focus();
	}, [reach, reached]);
	useEffect(() => () => items.holdChip(false), [items]);
	const look = `text-chrome-accent inline-flex items-center gap-1.5 rounded-md text-[12px] font-semibold hover:underline ${FOCUS_RING}`;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the pointer on the chip only keeps it shown.
		<div
			onPointerEnter={() => items.holdChip(true)}
			onPointerLeave={() => items.holdChip(false)}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				items.focusItem(itemKey);
			}}
			className="border-chrome-hover fixed z-20 flex w-[260px] flex-col gap-2.5 rounded-xl border bg-[#18181b] p-3.5 shadow-[0_12px_32px_rgba(0,0,0,0.4)]"
			style={{ left, top }}
			data-wc-query-chip=""
		>
			<p className="text-chrome-strong m-0 flex items-start gap-2 text-[12px] leading-4 font-semibold">
				<RefreshCwIcon aria-hidden="true" className="text-chrome-accent mt-px size-3.5 shrink-0" />
				<span data-wc-query-from="">{from}</span>
			</p>
			{link?.page ? (
				<button
					ref={(element) => {
						action.current = element;
					}}
					type="button"
					onClick={() => items.openEntry()}
					className={`${look} self-start`}
					data-wc-query-open=""
				>
					<ArrowUpRightIcon aria-hidden="true" className="size-[13px]" />
					{said.open}
				</button>
			) : link ? (
				<a
					ref={(element) => {
						action.current = element;
					}}
					href={link.href}
					target="_blank"
					rel="noopener noreferrer"
					className={`${look} self-start`}
					data-wc-query-open=""
				>
					<ArrowUpRightIcon aria-hidden="true" className="size-[13px]" />
					{said.openInAdmin}
				</a>
			) : null}
		</div>
	);
}

/**
 * "{item} removed" with Undo (BA-16), at the top centre for 8 seconds, held while the pointer or focus
 * is on it. Undo puts the item back where it was (`loop/restore`).
 */
function RemovedToast({
	words,
	name,
	items,
	busy,
}: {
	words: Words;
	name: string;
	items: LoopItemsController;
	busy: boolean;
}) {
	const said = words.client.items;
	const [held, setHeld] = useState(false);
	useEffect(() => {
		if (held) return;
		const timer = setTimeout(() => items.dismissRemoved(), REMOVED_FOR_MS);
		return () => clearTimeout(timer);
	}, [held, items]);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hovering only holds the toast.
		<div
			className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center"
			onPointerEnter={() => setHeld(true)}
			onPointerLeave={() => setHeld(false)}
			onFocus={() => setHeld(true)}
			onBlur={() => setHeld(false)}
			data-wc-item-toast=""
		>
			<div className="border-chrome-hover bg-chrome-menu text-chrome-strong pointer-events-auto flex items-center gap-3 rounded-[10px] border py-2 ps-3 pe-2 text-[14px] font-medium shadow-[0_12px_32px_rgba(0,0,0,0.55)]">
				<Trash2Icon aria-hidden="true" className="text-chrome-muted size-[18px] shrink-0" />
				<span className="max-w-[320px] truncate">{fill(said.removed, { name })}</span>
				<button
					type="button"
					disabled={busy}
					aria-label={fill(said.undoLabel, { name })}
					onClick={() => void items.restore()}
					className={`bg-chrome-hover text-chrome-strong inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-[13px] font-semibold hover:bg-[#34343b] disabled:opacity-50 ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-item-undo=""
				>
					<Undo2Icon aria-hidden="true" className="size-3.5" />
					{said.undo}
				</button>
				<button
					type="button"
					aria-label={said.dismiss}
					onClick={() => items.dismissRemoved()}
					className={`text-chrome-muted hover:text-chrome-strong inline-grid size-6 place-items-center rounded-md ${CHROME_EASE} ${FOCUS_RING}`}
				>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			</div>
		</div>
	);
}

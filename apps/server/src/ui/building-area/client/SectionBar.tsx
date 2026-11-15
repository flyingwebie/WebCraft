import {
	ChevronDownIcon,
	ChevronUpIcon,
	CircleCheckIcon,
	EyeIcon,
	EyeOffIcon,
	LayoutPanelTopIcon,
	SettingsIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon } from "../controls.tsx";
import { useMoves, useSections } from "./AddSection.tsx";
import { type MemberSections, REMOVED_FOR_MS, type SectionRow } from "./sections.ts";

/**
 * A section on the page (SPEC 13.3, `client/06`): chosen by its edge or its name (a click on the
 * section's own part, not on what is changed in it), or from the Sections list, it is outlined, its
 * name sits inside its top edge on the left ("Hero · section") and its bar on the right: move up, move
 * down, hide, settings in the side panel, remove. The section under the pointer is named the same way,
 * lighter. Drawn in the shell over the frame, clipped to the page.
 */

const MARK = "#4f46e5";
const MARK_SOFT = "#4f46e599";

export function SectionMarks({
	sections,
	words,
	onSettings,
}: {
	sections: MemberSections;
	words: Words;
	/** Settings on the bar: the side panel opens on the section's settings. */
	onSettings(id: string): void;
}) {
	const snapshot = useSections(sections);
	useMoves(sections);
	const frame = sections.frameBox();
	if (snapshot.status !== "ready" || !frame) return null;
	const chosen = snapshot.onPage
		? snapshot.rows.find((row) => row.id === snapshot.selected && row.kind === "section")
		: null;
	const pointed =
		snapshot.hovered && snapshot.hovered !== chosen?.id
			? snapshot.rows.find((row) => row.id === snapshot.hovered && row.kind === "section")
			: null;
	/** A section's box on the shell's window, inside the frame. */
	const boxOf = (row: SectionRow) => {
		const union = sections.sectionBox(row.id);
		if (!union) return null;
		return {
			left: union.left - frame.left,
			top: union.top - frame.top,
			width: union.width,
			height: union.height,
		};
	};
	const pointedBox = pointed ? boxOf(pointed) : null;
	const chosenBox = chosen ? boxOf(chosen) : null;
	return (
		<div
			className="pointer-events-none fixed z-[15] overflow-hidden"
			style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
			data-wc-section-marks=""
		>
			{pointed && pointedBox ? (
				<div
					aria-hidden="true"
					className="absolute box-border"
					style={{ ...place(pointedBox), border: `1.5px solid ${MARK_SOFT}` }}
					data-wc-section-mark="hover"
				>
					<Chip row={pointed} words={words} top={chipTop(pointedBox)} />
				</div>
			) : null}
			{chosen && chosenBox ? (
				<div
					className="absolute box-border"
					style={{ ...place(chosenBox), border: `2px solid ${MARK}` }}
					data-wc-section-mark="selected"
				>
					<Chip row={chosen} words={words} top={chipTop(chosenBox)} />
					<Bar sections={sections} row={chosen} words={words} top={chipTop(chosenBox)} onSettings={onSettings} />
				</div>
			) : null}
		</div>
	);
}

type Box = { left: number; top: number; width: number; height: number };

const place = (box: Box) => ({ left: box.left, top: box.top, width: box.width, height: box.height });

/** The chip and bar stay inside the section's top edge, and in view while the section's top is scrolled away. */
const chipTop = (box: Box) => Math.max(10, Math.min(-box.top + 10, box.height - 42));

function Chip({ row, words, top }: { row: SectionRow; words: Words; top: number }) {
	return (
		<span
			aria-hidden="true"
			className="absolute start-2.5 flex h-[26px] items-center gap-1.5 rounded-[7px] px-[9px] text-[12px] leading-4 whitespace-nowrap text-white shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
			style={{ top, backgroundColor: MARK }}
			data-wc-section-chip=""
		>
			<LayoutPanelTopIcon aria-hidden="true" className="size-[13px]" />
			<span className="font-semibold">{row.name}</span>
			<span className="font-normal text-white/80">{`· ${words.sections.chip}`}</span>
		</span>
	);
}

/** The section's bar (`client/06`): 32 high, its tools 26 × 26; the arrow keys move between them. */
function Bar({
	sections,
	row,
	words,
	top,
	onSettings,
}: {
	sections: MemberSections;
	row: SectionRow;
	words: Words;
	top: number;
	onSettings(id: string): void;
}) {
	const said = words.sections;
	const bar = useRef<HTMLDivElement>(null);
	const tools: { key: string; icon: Icon; label: string; off: boolean; run(): void }[] = [
		{
			key: "up",
			icon: ChevronUpIcon,
			label: said.moveUp,
			off: sections.refusal("moveUp", row.id) !== null,
			run: () => sections.act("moveUp", row.id),
		},
		{
			key: "down",
			icon: ChevronDownIcon,
			label: said.moveDown,
			off: sections.refusal("moveDown", row.id) !== null,
			run: () => sections.act("moveDown", row.id),
		},
		{
			key: "hide",
			icon: row.hidden ? EyeOffIcon : EyeIcon,
			label: row.hidden ? said.show : said.hide,
			off: sections.refusal("hide", row.id) !== null,
			run: () => sections.act("hide", row.id),
		},
		{ key: "settings", icon: SettingsIcon, label: said.settings, off: false, run: () => onSettings(row.id) },
		{
			key: "remove",
			icon: Trash2Icon,
			label: said.remove,
			off: sections.refusal("delete", row.id) !== null,
			run: () => sections.remove(row.id),
		},
	];
	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const all = [...(bar.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
		const at = all.indexOf(document.activeElement as HTMLButtonElement);
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const step = event.key === "ArrowRight" ? (rtl ? -1 : 1) : event.key === "ArrowLeft" ? (rtl ? 1 : -1) : 0;
		let next = -1;
		if (step) next = (at + step + all.length) % all.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = all.length - 1;
		else if (event.key === "Escape") {
			event.preventDefault();
			sections.select(row.id, { onPage: false });
			return;
		} else return;
		event.preventDefault();
		all[next]?.focus();
	};
	return (
		<div
			ref={bar}
			role="toolbar"
			aria-label={fill(said.bar, { name: row.label })}
			onKeyDown={onKey}
			className="border-chrome-hover pointer-events-auto absolute end-2.5 flex h-8 items-center gap-0.5 rounded-lg border bg-[#18181b] px-1 shadow-[0_8px_20px_rgba(0,0,0,0.4)]"
			style={{ top: top - 3 }}
			data-wc-section-bar={row.id}
		>
			{tools.map((tool, index) => (
				<span key={tool.key} className="flex items-center">
					{index === 2 ? <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-[#2a2a30]" /> : null}
					<button
						type="button"
						aria-label={tool.label}
						aria-disabled={tool.off ? true : undefined}
						tabIndex={index === 0 ? 0 : -1}
						onClick={() => {
							if (!tool.off) tool.run();
						}}
						className={`group text-chrome-text relative grid size-[26px] place-items-center rounded-md ${
							tool.off ? "cursor-default opacity-35" : "hover:bg-chrome-hover hover:text-chrome-strong"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-section-tool={tool.key}
					>
						<tool.icon aria-hidden="true" className="size-3.5" />
						<span
							aria-hidden="true"
							className="border-chrome-hover bg-chrome-tip text-chrome-strong pointer-events-none absolute start-1/2 top-[calc(100%+8px)] z-40 hidden h-[26px] -translate-x-1/2 items-center rounded-md border px-2 text-[11px] font-medium whitespace-nowrap group-hover:flex group-focus-visible:flex rtl:translate-x-1/2"
						>
							{tool.label}
						</span>
					</button>
				</span>
			))}
		</div>
	);
}

/**
 * "Section removed · Undo" (`client-flows/05`): removing asks nothing; this toast, top centre, offers
 * Undo for 8 s, paused while the pointer or focus is on it.
 */
export function RemovedToast({ sections, words }: { sections: MemberSections; words: Words }) {
	const snapshot = useSections(sections);
	const removed = snapshot.removed;
	const [held, setHeld] = useState(false);
	useEffect(() => {
		if (!removed || held) return;
		const timer = window.setTimeout(() => sections.dismissRemoved(), REMOVED_FOR_MS);
		return () => window.clearTimeout(timer);
	}, [removed, held, sections]);
	if (!removed) return null;
	const said = words.sections;
	return (
		<section
			key={removed.key}
			className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center"
			onPointerEnter={() => setHeld(true)}
			onPointerLeave={() => setHeld(false)}
			onFocus={() => setHeld(true)}
			onBlur={() => setHeld(false)}
			aria-label={said.removed}
			data-wc-section-toast=""
		>
			<div className="border-chrome-hover bg-chrome-menu text-chrome-strong pointer-events-auto flex items-center gap-3 rounded-[10px] border py-2 ps-3 pe-2 text-[14px] font-medium shadow-[0_12px_32px_rgba(0,0,0,0.55)]">
				<CircleCheckIcon aria-hidden="true" className="text-chrome-ok size-[18px] shrink-0" />
				<span>{said.removed}</span>
				<button
					type="button"
					onClick={() => sections.undoRemove()}
					className={`bg-chrome-hover text-chrome-strong rounded-[7px] px-3 py-1.5 text-[13px] font-semibold hover:bg-[#34343b] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-section-undo=""
				>
					{said.undo}
				</button>
				<button
					type="button"
					aria-label={said.dismiss}
					onClick={() => sections.dismissRemoved()}
					className={`text-chrome-muted hover:text-chrome-strong inline-grid size-6 place-items-center rounded-md ${CHROME_EASE} ${FOCUS_RING}`}
				>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			</div>
		</section>
	);
}

import { PlusIcon, SearchIcon } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import { FOOTER_ROW, HEADER_ROW } from "../../page-layouts/controller.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import type { AllowedComponent, MemberSections, SectionKind, SectionsSnapshot } from "./sections.ts";

/**
 * Adding a section (SPEC 13.4, `client/07`, `client-flows/05` "between two sections"):
 * - `SectionPicker`: the side panel's picker of the Allowed components, as cards with a picture and
 *   one line, in groups, with search. Pointing at a card (or giving it focus) shows where it lands on
 *   the page; a click adds it with its sample words, chosen and brought into view;
 * - `AddSectionLine`: near the boundary between two sections, a line across the page with
 *   "+ Add section", which opens the picker for that place;
 * - `Sketch`: the small picture of a section, drawn from what its Props hold (no render of the page).
 */

/** The picker's groups, in order: what the sections show (text alone, plain or in columns, is "Words"). */
const GROUPS = ["photoWords", "words", "grid", "banner"] as const;
type Group = (typeof GROUPS)[number];
const groupOf = (kind: SectionKind): Group => (kind === "twoCol" || kind === "plain" ? "words" : kind);

/** The page's colours of the marks (`client-flows/05`): indigo for what may change. */
const MARK = "#4f46e5";

/** Reads the sections' snapshot in React. */
export function useSections(sections: MemberSections): SectionsSnapshot {
	return useSyncExternalStore(sections.subscribe, sections.snapshot);
}

/** Draws again whenever the page moves under the shell (scrolled, resized, drawn again). */
export function useMoves(sections: MemberSections): number {
	const [moves, setMoves] = useState(0);
	useEffect(() => sections.onMove(() => setMoves((count) => count + 1)), [sections]);
	return moves;
}

/** A section's one line in the picker: the Props it asks for, or that it asks for none. */
export function describe(component: AllowedComponent, words: Words): string {
	const labels = component.props.map((prop) => prop.label).filter(Boolean);
	return labels.length > 0 ? labels.join(", ") : words.sections.nothingToFill;
}

/** Where the picker adds, in words: "After Hero", "At the top of the page", "At the end of the page". */
export function whereText(snapshot: SectionsSnapshot, words: Words): string {
	const said = words.sections;
	const after = snapshot.addAfter;
	if (after === HEADER_ROW) return said.atStart;
	if (after === null || after === FOOTER_ROW) return said.atEnd;
	const row = snapshot.rows.find((each) => each.id === after);
	return row ? fill(said.after, { name: row.label }) : said.atEnd;
}

/** A section's small picture: lines and boxes of what its Props hold, light on the dark chrome. */
export function Sketch({ kind, size }: { kind: SectionKind; size: "row" | "card" }) {
	const line = (key: string, width: string, height = 4, opacity = 1) => (
		<span
			key={key}
			className="block shrink-0 rounded-[2px] bg-[#71717a]"
			style={{ width, height, opacity }}
			aria-hidden="true"
		/>
	);
	const box = (key: string, className: string, opacity = 0.45) => (
		<span key={key} className={`block shrink-0 rounded-[4px] bg-[#71717a] ${className}`} style={{ opacity }} />
	);
	let body: ReactNode;
	switch (kind) {
		case "photoWords":
			body = (
				<span className="flex h-full w-full items-center gap-2 px-1.5">
					{box("photo", size === "card" ? "h-11 w-[22px]" : "h-6 w-3")}
					<span className="flex grow flex-col gap-1">
						{line("a", "70%", 5)}
						{line("b", "54%")}
						{line("c", "60%")}
					</span>
				</span>
			);
			break;
		case "grid":
			body = (
				<span className="grid h-full w-full grid-cols-2 gap-1 p-1.5">
					{box("a", "h-full w-full", 0.4)}
					{box("b", "h-full w-full", 0.4)}
					{box("c", "h-full w-full", 0.4)}
					{box("d", "h-full w-full", 0.4)}
				</span>
			);
			break;
		case "banner":
			body = (
				<span className="flex h-full w-full flex-col justify-center gap-1 px-2">
					{line("a", "66%", 6)}
					{line("b", "85%")}
					{box("button", size === "card" ? "mt-0.5 h-3.5 w-[42px] rounded-full" : "h-2 w-5 rounded-full", 0.55)}
				</span>
			);
			break;
		case "twoCol":
			body = (
				<span className="grid h-full w-full grid-cols-2 items-center gap-2 px-2">
					<span className="flex flex-col gap-1">
						{line("a", "100%", 5)}
						{line("b", "85%")}
						{line("c", "92%")}
					</span>
					<span className="flex flex-col gap-1">
						{line("d", "100%", 5)}
						{line("e", "85%")}
						{line("f", "70%")}
					</span>
				</span>
			);
			break;
		default:
			body = (
				<span className="flex h-full w-full flex-col items-center justify-center gap-[3px] px-1.5">
					{line("a", "70%")}
					{line("b", "45%")}
				</span>
			);
	}
	return (
		<span
			aria-hidden="true"
			className={
				size === "card"
					? "bg-chrome-well block h-14 w-full shrink-0 overflow-hidden rounded-md"
					: "bg-chrome-raised block h-9 w-14 shrink-0 overflow-hidden rounded-md border border-[#2f2f36]"
			}
		>
			{body}
		</span>
	);
}

/** The picker of the Allowed components (`client/07`): search, groups, cards. */
export function SectionPicker({
	sections,
	snapshot,
	words,
	handled,
}: {
	sections: MemberSections;
	snapshot: SectionsSnapshot;
	words: Words;
	/** The focus asked for so far (`SectionsPanel`): the picker takes the next one. */
	handled: RefObject<number>;
}) {
	const said = words.sections;
	const [query, setQuery] = useState("");
	const search = useRef<HTMLInputElement>(null);
	const searchId = useId();

	// Focus goes to the search as the picker opens (and when asked again).
	useEffect(() => {
		if (handled.current === snapshot.focusRequest) return;
		handled.current = snapshot.focusRequest;
		search.current?.focus({ preventScroll: true });
	}, [snapshot.focusRequest, handled]);
	// Nothing is pointed at once the picker goes.
	useEffect(() => () => sections.point(null), [sections]);

	const shown = useMemo(() => {
		const wanted = query.trim().toLocaleLowerCase();
		return snapshot.components.filter(
			(component) =>
				!wanted ||
				component.name.toLocaleLowerCase().includes(wanted) ||
				describe(component, words).toLocaleLowerCase().includes(wanted),
		);
	}, [snapshot.components, query, words]);

	return (
		<div className="flex flex-col gap-4" data-wc-section-picker="">
			<label htmlFor={searchId} className="sr-only">
				{said.search}
			</label>
			<span className="relative block">
				<SearchIcon
					aria-hidden="true"
					className="text-chrome-faint absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2"
				/>
				<input
					ref={search}
					id={searchId}
					type="search"
					value={query}
					placeholder={said.search}
					onChange={(event) => setQuery(event.target.value)}
					className={`bg-chrome-raised text-chrome-strong placeholder:text-chrome-faint focus:border-chrome-focus focus:ring-chrome-focus h-[30px] w-full rounded-lg border border-[#2f2f36] ps-8 pe-2 text-[13px] outline-none focus:ring-1 ${CHROME_EASE}`}
				/>
			</span>
			{snapshot.components.length === 0 ? (
				<p className="text-chrome-muted m-0 text-[13px]">{said.noneAllowed}</p>
			) : shown.length === 0 ? (
				<p className="text-chrome-muted m-0 text-[13px]" role="status">
					{fill(said.noMatch, { query: query.trim() })}
				</p>
			) : (
				GROUPS.map((kind) => {
					const cards = shown.filter((component) => groupOf(component.kind) === kind);
					if (cards.length === 0) return null;
					const heading = `${searchId}-${kind}`;
					return (
						<section key={kind} aria-labelledby={heading} className="flex flex-col gap-2">
							<h3 id={heading} className="text-chrome-faint m-0 text-[11px] font-semibold tracking-[0.04em] uppercase">
								{said.groups[kind]}
							</h3>
							<ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
								{cards.map((component) => (
									<li key={component.id} className="min-w-0">
										<Card
											component={component}
											words={words}
											busy={snapshot.busy}
											pointed={snapshot.pointing === component.id}
											onPoint={(on) => sections.point(on ? component.id : null)}
											onAdd={() => sections.add(component.id)}
										/>
									</li>
								))}
							</ul>
						</section>
					);
				})
			)}
		</div>
	);
}

function Card({
	component,
	words,
	busy,
	pointed,
	onPoint,
	onAdd,
}: {
	component: AllowedComponent;
	words: Words;
	busy: boolean;
	pointed: boolean;
	onPoint(on: boolean): void;
	onAdd(): void;
}) {
	const line = describe(component, words);
	return (
		<button
			type="button"
			aria-label={`${component.name}. ${line}`}
			aria-disabled={busy ? true : undefined}
			onClick={() => {
				if (!busy) onAdd();
			}}
			onPointerEnter={() => onPoint(true)}
			onPointerLeave={() => onPoint(false)}
			onFocus={() => onPoint(true)}
			onBlur={() => onPoint(false)}
			className={`flex h-32 w-full min-w-0 flex-col gap-1.5 overflow-hidden rounded-[10px] p-2 text-start ${
				pointed
					? "bg-chrome-raised border-2 border-[#6366f1] p-[7px]"
					: "hover:bg-chrome-raised border border-[#2f2f36]"
			} ${CHROME_EASE} ${FOCUS_RING}`}
			data-wc-section-card={component.id}
		>
			<Sketch kind={component.kind} size="card" />
			<span className="text-chrome-strong block w-full truncate text-[12px] font-semibold">{component.name}</span>
			<span className="text-chrome-muted line-clamp-2 block w-full text-[11px] leading-[14px]">{line}</span>
		</button>
	);
}

/**
 * Near the boundary between two sections: a line across the page with "+ Add section" (`client/07`).
 * Drawn in the shell over the frame, where the pointer found the boundary; the line stays while the
 * pointer is on its button.
 */
export function AddSectionLine({
	sections,
	words,
	onAdd,
}: {
	sections: MemberSections;
	words: Words;
	onAdd(after: string): void;
}) {
	const snapshot = useSections(sections);
	useMoves(sections);
	const boundary = snapshot.boundary;
	const frame = sections.frameBox();
	if (!boundary || !frame || snapshot.status !== "ready") return null;
	const nextBox = boundary.next ? sections.sectionBox(boundary.next) : null;
	const aboveBox = sections.sectionBox(boundary.after);
	const y = nextBox ? nextBox.top : aboveBox ? aboveBox.bottom : null;
	if (y === null || y < frame.top || y > frame.bottom) return null;
	const where = whereText({ ...snapshot, addAfter: boundary.after }, words);
	return (
		<div
			className="pointer-events-none fixed z-20 flex h-7 items-center justify-center"
			style={{ left: frame.left, width: frame.width, top: y - 14 }}
			data-wc-add-section-line=""
		>
			<span aria-hidden="true" className="absolute inset-x-0 top-[13px] h-0.5" style={{ backgroundColor: MARK }} />
			<button
				type="button"
				aria-label={`${words.sections.add}: ${where}`}
				onPointerEnter={() => sections.holdBoundary(true)}
				onPointerLeave={() => sections.holdBoundary(false)}
				onFocus={() => sections.holdBoundary(true)}
				onBlur={() => sections.holdBoundary(false)}
				onClick={() => {
					sections.holdBoundary(false);
					onAdd(boundary.after);
				}}
				className="focus-visible:ring-offset-chrome pointer-events-auto relative flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold text-white shadow-[0_4px_14px_rgba(79,70,229,0.5)] outline-none focus-visible:ring-2 focus-visible:ring-[#fb923c] focus-visible:ring-offset-1"
				style={{ backgroundColor: MARK }}
			>
				<PlusIcon aria-hidden="true" className="size-3.5" />
				{words.sections.add}
			</button>
		</div>
	);
}

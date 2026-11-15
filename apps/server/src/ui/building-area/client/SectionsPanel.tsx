import {
	ArrowDownIcon,
	ArrowUpIcon,
	CopyIcon,
	EllipsisIcon,
	EyeIcon,
	EyeOffIcon,
	GripVerticalIcon,
	LockIcon,
	Rows3Icon,
	SettingsIcon,
	Trash2Icon,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useId, useRef, useState } from "react";

import { FOOTER_ROW, HEADER_ROW } from "../../page-layouts/controller.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";
import { SectionPicker, Sketch, useSections, whereText } from "./AddSection.tsx";
import { plural } from "./ClientBar.tsx";
import { MenuItem, MenuList, SectionSettings } from "./SectionSettings.tsx";
import { SidePanel } from "./SidePanel.tsx";
import type { MemberSections, SectionRow, SectionsSnapshot } from "./sections.ts";

/**
 * The Sections side panel (SPEC 13.4, `client/06`): the page's sections in order, each a row with a
 * small picture, its name, a drag handle, hide, and a menu (Settings, Duplicate, Move up, Move down,
 * Hide, Remove). The Site template's header and footer are locked rows ("Same on every page"); a
 * section whose place the agency fixed carries a lock; a hidden one is faded with a crossed eye. At its
 * foot, "Add section" opens the picker (`AddSection.tsx`); Settings opens the section's Props
 * (`SectionSettings.tsx`). The list is one tree for the keyboard: the arrow keys, Home and End move,
 * typing a name finds it, Space picks a section up to move it with the arrows (Escape puts it back),
 * Alt with the arrows moves it at once, Enter opens its settings, Delete removes it.
 */
export function SectionsPanel({
	sections,
	words,
	page,
}: {
	sections: MemberSections;
	words: Words;
	/** The page's title, naming the list. */
	page: string;
}) {
	const snapshot = useSections(sections);
	const said = words.sections;
	// The focus asked for so far: a view that opens takes the next one (the panel opening keeps its heading's).
	const handled = useRef(snapshot.focusRequest);
	if (snapshot.status === "loading") return <p className="text-chrome-muted m-0 text-[13px]">{said.loading}</p>;
	if (snapshot.status === "none")
		return <p className="text-chrome-muted m-0 text-[13px]">{said.refusals.unavailable}</p>;
	if (snapshot.view === "add")
		return <SectionPicker sections={sections} snapshot={snapshot} words={words} handled={handled} />;
	if (snapshot.view === "settings" && snapshot.selected && snapshot.props[snapshot.selected])
		return (
			<SectionSettings
				key={snapshot.selected}
				sections={sections}
				snapshot={snapshot}
				id={snapshot.selected}
				words={words}
				handled={handled}
			/>
		);
	return <SectionList sections={sections} snapshot={snapshot} words={words} page={page} handled={handled} />;
}

/** The side panel holding the Sections (`client/06`, `client/07`): its header follows the view. */
export function SectionsSidePanel({
	id,
	sections,
	words,
	page,
	language,
	onClose,
}: {
	id: string;
	sections: MemberSections;
	words: Words;
	page: string;
	language: string;
	onClose(): void;
}) {
	const snapshot = useSections(sections);
	const heading = sectionsHeading(snapshot, words, page, language, () => sections.view("list"));
	return (
		<SidePanel
			id={id}
			kind="sections"
			words={words}
			title={heading.title}
			page={heading.sub}
			icon={Rows3Icon}
			back={heading.back}
			foot={
				snapshot.status === "ready" && snapshot.view === "list" ? (
					<SectionsFoot sections={sections} words={words} />
				) : null
			}
			onClose={onClose}
		>
			<SectionsPanel sections={sections} words={words} page={page} />
		</SidePanel>
	);
}

/** What the side panel's header says for the view: its name, what is under it, and the way back. */
export function sectionsHeading(
	snapshot: SectionsSnapshot,
	words: Words,
	page: string,
	language: string,
	back: () => void,
): { title: string; sub: string; back: { label: string; onBack(): void } | null } {
	const said = words.sections;
	if (snapshot.status === "ready" && snapshot.view === "add")
		return { title: said.addTitle, sub: whereText(snapshot, words), back: { label: said.back, onBack: back } };
	const row = snapshot.rows.find((each) => each.id === snapshot.selected);
	if (snapshot.status === "ready" && snapshot.view === "settings" && row)
		return {
			title: fill(said.settingsTitle, { name: row.name }),
			sub: row.label,
			back: { label: said.back, onBack: back },
		};
	return {
		title: said.title,
		sub: snapshot.status === "ready" ? plural(said.count, snapshot.count, language).replace("{page}", page) : page,
		back: null,
	};
}

/** The panel's foot: "Add section", after the chosen row (or at the end). */
export function SectionsFoot({ sections, words }: { sections: MemberSections; words: Words }) {
	const snapshot = useSections(sections);
	if (snapshot.status !== "ready" || snapshot.view !== "list") return null;
	return (
		<button
			type="button"
			onClick={() => sections.view("add", { after: afterOf(snapshot) })}
			className={`border-chrome-line text-chrome-strong hover:bg-chrome-hover flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[#3f3f46] text-[14px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`}
			data-wc-sections-add=""
		>
			<PlusSign />
			{words.sections.add}
		</button>
	);
}

function PlusSign() {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 24 24"
			className="size-4"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
		>
			<path d="M12 5v14M5 12h14" />
		</svg>
	);
}

/** Where "Add section" adds: after the chosen section (or the header: at the top), else at the end. */
function afterOf(snapshot: SectionsSnapshot): string | null {
	const chosen = snapshot.selected;
	if (chosen === HEADER_ROW) return HEADER_ROW;
	if (chosen && chosen !== FOOTER_ROW && snapshot.rows.some((row) => row.id === chosen)) return chosen;
	return null;
}

/** How long typed letters keep finding a row by its name. */
const TYPEAHEAD_MS = 600;

function SectionList({
	sections,
	snapshot,
	words,
	page,
	handled,
}: {
	sections: MemberSections;
	snapshot: SectionsSnapshot;
	words: Words;
	page: string;
	handled: RefObject<number>;
}) {
	const said = words.sections;
	const tree = useRef<HTMLDivElement>(null);
	const keysId = useId();
	const menuId = useId();
	const [menu, setMenu] = useState<{ id: string; top: number; right: number } | null>(null);
	const [drag, setDrag] = useState<{ id: string; from: number; to: number; pointer: number } | null>(null);
	const typed = useRef({ text: "", at: 0 });
	const rows = snapshot.rows;
	const placements = rows.filter((row) => row.kind === "section");
	const focusable = rows.some((row) => row.id === snapshot.selected) ? snapshot.selected : (rows[0]?.id ?? null);

	const rowElement = (id: string | null) =>
		id ? (tree.current?.querySelector<HTMLElement>(`[data-wc-section-row="${CSS.escape(id)}"]`) ?? null) : null;

	// Focus goes to the chosen row when asked (a move, a copy, a removal, a section added, the list opened).
	useEffect(() => {
		if (handled.current === snapshot.focusRequest) return;
		handled.current = snapshot.focusRequest;
		(rowElement(snapshot.selected) ?? rowElement(rows[0]?.id ?? null))?.focus({ preventScroll: false });
	});

	const choose = (row: SectionRow | undefined, focus = true) => {
		if (!row) return;
		sections.select(row.id, { onPage: row.kind === "section" });
		if (focus) rowElement(row.id)?.focus();
	};

	const openMenu = (row: SectionRow, button: HTMLElement) => {
		const box = button.getBoundingClientRect();
		setMenu({ id: row.id, top: box.bottom + 4, right: Math.max(8, window.innerWidth - box.right) });
	};

	const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		if (!target.matches("[role='treeitem']")) return;
		const at = rows.findIndex((row) => row.id === target.dataset.wcSectionRow);
		const row = rows[at];
		if (!row) return;
		const section = row.kind === "section";
		const go = (index: number) => choose(rows[Math.max(0, Math.min(rows.length - 1, index))]);
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp": {
				const down = event.key === "ArrowDown";
				if (snapshot.grabbed || event.altKey) {
					if (section) sections.act(down ? "moveDown" : "moveUp", row.id);
				} else go(at + (down ? 1 : -1));
				break;
			}
			case "Home":
				go(0);
				break;
			case "End":
				go(rows.length - 1);
				break;
			case " ":
				if (!section) return;
				sections.grab(snapshot.grabbed ? "drop" : "pick");
				break;
			case "Enter":
				if (snapshot.grabbed) sections.grab("drop");
				else if (section) sections.view("settings");
				else return;
				break;
			case "Escape":
				if (!snapshot.grabbed) return;
				sections.grab("cancel");
				break;
			case "Delete":
			case "Backspace":
				if (!section) return;
				sections.remove(row.id);
				break;
			case "F10":
				if (!event.shiftKey || !section) return;
				openMenu(row, target.querySelector<HTMLElement>("[data-wc-section-more]") ?? target);
				break;
			case "ContextMenu":
				if (!section) return;
				openMenu(row, target.querySelector<HTMLElement>("[data-wc-section-more]") ?? target);
				break;
			default: {
				if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
				// Typing finds a row by its name.
				const now = Date.now();
				typed.current = {
					text: (now - typed.current.at > TYPEAHEAD_MS ? "" : typed.current.text) + event.key.toLocaleLowerCase(),
					at: now,
				};
				const text = typed.current.text;
				const order = [
					...rows.slice(at + (text.length === 1 ? 1 : 0)),
					...rows.slice(0, at + (text.length === 1 ? 1 : 0)),
				];
				const found = order.find((each) => each.label.toLocaleLowerCase().startsWith(text));
				if (found) choose(found);
				break;
			}
		}
		event.preventDefault();
		event.stopPropagation();
	};

	/** A drag by the handle: the row follows the pointer, a line shows where it lands, Escape cancels. */
	const startDrag = (event: PointerEvent<HTMLSpanElement>, row: SectionRow) => {
		if (event.button !== 0 || sections.refusal("moveUp", row.id) === "locked") return;
		event.preventDefault();
		const from = placements.findIndex((each) => each.id === row.id);
		if (from < 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		sections.select(row.id, { onPage: true });
		setDrag({ id: row.id, from, to: from, pointer: event.pointerId });
	};
	const moveDrag = (event: PointerEvent<HTMLSpanElement>) => {
		if (!drag || event.pointerId !== drag.pointer) return;
		const boxes = placements.map((each) => rowElement(each.id)?.getBoundingClientRect() ?? null);
		let to = 0;
		boxes.forEach((box, index) => {
			if (box && event.clientY > box.top + box.height / 2) to = index + (index >= drag.from ? 0 : 1);
		});
		to = Math.max(0, Math.min(placements.length - 1, to));
		if (to !== drag.to) setDrag({ ...drag, to });
	};
	const endDrag = (event: PointerEvent<HTMLSpanElement>, cancel: boolean) => {
		if (!drag || event.pointerId !== drag.pointer) return;
		setDrag(null);
		if (!cancel && drag.to !== drag.from) sections.drop(drag.from, drag.to);
	};
	useEffect(() => {
		if (!drag) return;
		const cancel = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setDrag(null);
		};
		document.addEventListener("keydown", cancel, true);
		return () => document.removeEventListener("keydown", cancel, true);
	}, [drag]);

	/** Where the drop line is drawn: above the row the dragged one would take the place of, or below the last. */
	const dropLine = (row: SectionRow): "before" | "after" | null => {
		if (!drag || drag.to === drag.from) return null;
		const index = placements.findIndex((each) => each.id === row.id);
		if (drag.to > drag.from) return index === drag.to ? "after" : null;
		return index === drag.to ? "before" : null;
	};

	if (rows.length === 0) return <p className="text-chrome-muted m-0 text-[13px]">{said.empty}</p>;
	const menuRow = menu ? rows.find((row) => row.id === menu.id) : undefined;
	return (
		<>
			<p id={keysId} className="sr-only">
				{said.keys}
			</p>
			<div
				ref={tree}
				role="tree"
				aria-label={fill(said.list, { page })}
				aria-describedby={keysId}
				onKeyDown={onKey}
				className="flex flex-col gap-0.5"
				data-wc-sections-list=""
			>
				{rows.map((row, index) => {
					const selected = row.id === snapshot.selected;
					const section = row.kind === "section";
					const line = dropLine(row);
					const hint = !section
						? said.sameEverywhere
						: row.locked
							? said.lockedHint
							: row.hidden
								? said.hiddenHint
								: null;
					return (
						// biome-ignore lint/a11y/useKeyWithClickEvents: the tree's keys are on the tree (arrows, Enter, Space).
						<div
							key={row.id}
							role="treeitem"
							aria-level={1}
							aria-setsize={rows.length}
							aria-posinset={index + 1}
							aria-selected={selected}
							aria-labelledby={hint ? `${keysId}-${index}-name ${keysId}-${index}-hint` : `${keysId}-${index}-name`}
							tabIndex={row.id === focusable ? 0 : -1}
							onClick={() => choose(row)}
							className={`group relative flex h-14 shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 ${
								selected ? "bg-[#2a2a30]" : "hover:bg-chrome-raised"
							} ${snapshot.grabbed && selected ? "ring-2 ring-[#6366f1]" : ""} ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-section-row={row.id}
							data-wc-section-kind={row.kind}
							data-grabbed={snapshot.grabbed && selected ? "true" : undefined}
						>
							{line ? (
								<span
									aria-hidden="true"
									className={`absolute inset-x-2 h-0.5 rounded-full bg-[#6366f1] ${line === "before" ? "-top-px" : "-bottom-px"}`}
								/>
							) : null}
							{section && !row.locked ? (
								<span
									aria-hidden="true"
									title={fill(said.grip, { name: row.label })}
									onPointerDown={(event) => startDrag(event, row)}
									onPointerMove={moveDrag}
									onPointerUp={(event) => endDrag(event, false)}
									onPointerCancel={(event) => endDrag(event, true)}
									className="text-chrome-faint grid h-8 w-3.5 shrink-0 cursor-grab touch-none place-items-center"
									data-wc-section-grip=""
								>
									<GripVerticalIcon className="size-3.5" />
								</span>
							) : (
								<span
									aria-hidden="true"
									className="text-chrome-faint grid h-8 w-3.5 shrink-0 place-items-center opacity-40"
								>
									<GripVerticalIcon className="size-3.5" />
								</span>
							)}
							<Sketch kind={row.sketch} size="row" />
							<span className="flex min-w-0 grow flex-col gap-px">
								<span
									id={`${keysId}-${index}-name`}
									className={`truncate text-[13px] font-medium ${row.hidden ? "text-chrome-muted" : "text-chrome-text"}`}
								>
									{row.label}
								</span>
								{hint ? (
									<span id={`${keysId}-${index}-hint`} className="text-chrome-muted truncate text-[11px]">
										{hint}
									</span>
								) : null}
							</span>
							{row.locked ? <LockIcon aria-hidden="true" className="text-chrome-muted size-3.5 shrink-0" /> : null}
							{section ? (
								<>
									{row.hidden ? (
										<EyeOffIcon
											aria-hidden="true"
											className="text-chrome-muted size-3.5 shrink-0 group-focus-within:hidden group-hover:hidden"
										/>
									) : null}
									<span
										className={`flex shrink-0 items-center gap-0.5 ${
											selected || menu?.id === row.id ? "flex" : "hidden group-focus-within:flex group-hover:flex"
										}`}
									>
										<button
											type="button"
											tabIndex={selected ? 0 : -1}
											aria-label={fill(row.hidden ? said.showNamed : said.hideNamed, { name: row.label })}
											aria-disabled={sections.refusal("hide", row.id) ? true : undefined}
											onClick={(event) => {
												event.stopPropagation();
												sections.act("hide", row.id);
											}}
											className={`text-chrome-muted hover:text-chrome-strong grid size-7 place-items-center rounded-md hover:bg-[#3f3f46] aria-disabled:opacity-35 ${CHROME_EASE} ${FOCUS_RING}`}
											data-wc-section-eye=""
										>
											{row.hidden ? (
												<EyeOffIcon aria-hidden="true" className="size-3.5" />
											) : (
												<EyeIcon aria-hidden="true" className="size-3.5" />
											)}
										</button>
										<button
											type="button"
											tabIndex={selected ? 0 : -1}
											aria-label={fill(said.more, { name: row.label })}
											aria-haspopup="menu"
											aria-expanded={menu?.id === row.id}
											aria-controls={menu?.id === row.id ? menuId : undefined}
											onClick={(event) => {
												event.stopPropagation();
												if (menu?.id === row.id) setMenu(null);
												else openMenu(row, event.currentTarget);
											}}
											className={`grid size-7 place-items-center rounded-md ${
												menu?.id === row.id
													? "text-chrome-strong bg-[#3f3f46]"
													: "text-chrome-muted hover:text-chrome-strong hover:bg-[#3f3f46]"
											} ${CHROME_EASE} ${FOCUS_RING}`}
											data-wc-section-more=""
										>
											<EllipsisIcon aria-hidden="true" className="size-3.5" />
										</button>
									</span>
								</>
							) : null}
						</div>
					);
				})}
			</div>
			{menu && menuRow ? (
				<RowMenu
					id={menuId}
					row={menuRow}
					sections={sections}
					words={words}
					at={menu}
					onClose={(focus) => {
						setMenu(null);
						if (focus) rowElement(menu.id)?.querySelector<HTMLElement>("[data-wc-section-more]")?.focus();
					}}
				/>
			) : null}
		</>
	);
}

/** A section's menu (`client/06`): Settings, Duplicate, Move up, Move down, Hide, then Remove. */
function RowMenu({
	id,
	row,
	sections,
	words,
	at,
	onClose,
}: {
	id: string;
	row: SectionRow;
	sections: MemberSections;
	words: Words;
	at: { top: number; right: number };
	onClose(focus: boolean): void;
}) {
	const said = words.sections;
	const list = useRef<HTMLDivElement>(null);
	const latest = useRef(onClose);
	latest.current = onClose;
	useEffect(() => {
		list.current?.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")?.focus();
		const outside = (event: globalThis.PointerEvent) => {
			const target = event.target as Node | null;
			if (target && list.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-wc-section-more]")) return;
			latest.current(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, []);
	const run = (work: () => void) => {
		onClose(true);
		work();
	};
	return (
		<MenuList id={id} label={fill(said.menu, { name: row.label })} refTo={list} onClose={onClose} fixed={at}>
			<MenuItem
				icon={SettingsIcon}
				label={said.settings}
				off={false}
				onRun={() =>
					run(() => {
						sections.select(row.id, { onPage: true });
						sections.view("settings");
					})
				}
			/>
			<MenuItem
				icon={CopyIcon}
				label={said.duplicate}
				off={sections.refusal("duplicate", row.id) !== null}
				onRun={() => run(() => sections.act("duplicate", row.id))}
			/>
			<MenuItem
				icon={ArrowUpIcon}
				label={said.moveUp}
				off={sections.refusal("moveUp", row.id) !== null}
				onRun={() => run(() => sections.act("moveUp", row.id))}
			/>
			<MenuItem
				icon={ArrowDownIcon}
				label={said.moveDown}
				off={sections.refusal("moveDown", row.id) !== null}
				onRun={() => run(() => sections.act("moveDown", row.id))}
			/>
			<MenuItem
				icon={row.hidden ? EyeIcon : EyeOffIcon}
				label={row.hidden ? said.show : said.hide}
				off={sections.refusal("hide", row.id) !== null}
				onRun={() => run(() => sections.act("hide", row.id))}
			/>
			<MenuItem
				icon={Trash2Icon}
				label={said.remove}
				off={sections.refusal("delete", row.id) !== null}
				danger
				separated
				onRun={() => run(() => sections.remove(row.id))}
			/>
		</MenuList>
	);
}

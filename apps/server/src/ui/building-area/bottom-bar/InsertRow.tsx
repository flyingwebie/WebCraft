import {
	BetweenHorizontalStartIcon,
	BookImageIcon,
	ComponentIcon,
	GitBranchIcon,
	HeadingIcon,
	ImageIcon,
	LinkIcon,
	ListIcon,
	PilcrowIcon,
	PlayIcon,
	PlusIcon,
	RectangleHorizontalIcon,
	RepeatIcon,
	ScanIcon,
	ShapesIcon,
	SquareDashedIcon,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ariaKeys, shortcutText } from "../../editor/shortcuts.ts";
import type { Words } from "../api.ts";
import type { DropDetail } from "../canvas/Frame.tsx";
import type { MenuRequest } from "../command-menu/state.ts";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../controls.tsx";
import { type Inserter, type InsertKind, ROW_ELEMENTS } from "../editing/insert.ts";

/** Each kind's icon on the row (SPEC 6, `builder/04`): the kit's icons. */
export const KIND_ICONS: Record<InsertKind | "more", Icon> = {
	section: RectangleHorizontalIcon,
	container: ScanIcon,
	div: SquareDashedIcon,
	header: RectangleHorizontalIcon,
	footer: RectangleHorizontalIcon,
	heading: HeadingIcon,
	text: PilcrowIcon,
	link: LinkIcon,
	button: RectangleHorizontalIcon,
	list: ListIcon,
	image: ImageIcon,
	figure: BookImageIcon,
	video: PlayIcon,
	icon: ShapesIcon,
	loop: RepeatIcon,
	condition: GitBranchIcon,
	form: ListIcon,
	component: ComponentIcon,
	outlet: BetweenHorizontalStartIcon,
	more: PlusIcon,
};

/** The tinted fills and icon colours of the row's kinds that aren't plain elements (SPEC 4's chrome colours). */
const TINTS: Partial<Record<InsertKind | "more", string>> = {
	loop: "bg-[#fbbf24]/15 text-[#fbbf24] hover:bg-[#fbbf24]/25",
	condition: "bg-[#60a5fa]/15 text-[#60a5fa] hover:bg-[#60a5fa]/25",
	component: "bg-[#a78bfa]/15 text-[#a78bfa] hover:bg-[#a78bfa]/25",
	more: "bg-[#4ade80]/15 text-[#4ade80] hover:bg-[#4ade80]/25",
	outlet: "text-[#ddd6fe] hover:bg-[#a78bfa]/25",
};

/**
 * The insert row (SPEC 4 and 6, `builder/04`, `docking/07`): in the middle of the bottom bar, buttons
 * 28 × 28, 8 apart. Section, Container, Div, Heading, Text, Link, Image, Video, Icon, List, then the
 * tinted Loop, Condition, Component and "more" (the Command menu on Insert). A Template whose tree may
 * hold Template-only commands adds a tinted group at the left (the page content outlet). One rule
 * everywhere (`editing/insert.ts`): inside the selection if it can hold it, otherwise after it; ⌘ (Ctrl)
 * held forces after. The button under the pointer or with focus shows where it will land: a line on the
 * canvas and in the tree (`InsertLine.tsx`). Loop, Condition and Component ask their question in the
 * Command menu first.
 */
export function InsertRow({
	words,
	inserter,
	onMenu,
	onPage,
	template,
}: {
	words: Words;
	inserter: Inserter;
	/** Opens the Command menu (on Insert, at a question, or listing the Components). */
	onMenu(request: MenuRequest): void;
	/** On a Page: Section starts a new Page section (D2, ADR 0038), as its tooltip says. */
	onPage: boolean;
	/** The open Template may hold the page content outlet: its tinted group shows. */
	template: boolean;
}) {
	const items = words.insert.items;
	// The landing line follows the store; the row itself needs nothing from it.
	useSyncExternalStore(inserter.subscribe, inserter.current);
	// A row's button dragged onto the page inserts there, and the selection's chip dragged moves it (BA-33).
	useEffect(() => {
		const onDrop = (event: Event) => {
			const { source, target, fraction } = (event as CustomEvent<DropDetail>).detail;
			if (source !== "move" && !source.startsWith("insert:")) return;
			void inserter.dropAt(source, target?.getAttribute("data-wc-code") ?? null, fraction);
		};
		document.addEventListener("webcraft:drop", onDrop);
		return () => document.removeEventListener("webcraft:drop", onDrop);
	}, [inserter]);
	const kinds: (InsertKind | "more")[] = [
		...(template ? (["outlet"] as const) : []),
		...ROW_ELEMENTS,
		"loop",
		"condition",
		"component",
		"more",
	];
	// One Tab stop; the arrow keys, Home and End move along the row (a toolbar).
	const [stop, setStop] = useState(0);
	const row = useRef<HTMLDivElement>(null);
	const focusAt = (index: number) => {
		const next = (index + kinds.length) % kinds.length;
		setStop(next);
		row.current?.querySelectorAll<HTMLButtonElement>("[data-wc-insert]")[next]?.focus();
	};

	const run = (kind: InsertKind | "more", forceAfter: boolean) => {
		inserter.preview(null);
		switch (kind) {
			case "more":
				onMenu({ tab: "insert", forceAfter });
				return;
			case "loop":
			case "condition":
				onMenu({ tab: "insert", step: kind, forceAfter });
				return;
			case "component":
				onMenu({ tab: "insert", only: "components", forceAfter });
				return;
			default:
				void inserter.insert(kind, { forceAfter });
		}
	};

	const button = (kind: InsertKind | "more", index: number) => {
		const Glyph = KIND_ICONS[kind];
		const label = kind === "section" && onPage ? items.section.tip : items[kind].name;
		const more = kind === "more";
		const show = (forceAfter: boolean) => {
			if (!more) inserter.preview(kind, forceAfter);
		};
		return (
			<button
				key={kind}
				type="button"
				aria-label={label}
				aria-keyshortcuts={more ? ariaKeys("menu.insert") : undefined}
				tabIndex={index === Math.min(stop, kinds.length - 1) ? 0 : -1}
				onClick={(event: MouseEvent) => run(kind, event.metaKey || event.ctrlKey)}
				onKeyDown={(event: KeyboardEvent) => {
					// ⌘↵ or Ctrl+Enter inserts after, as ⌘ with a click does.
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						run(kind, true);
					} else if (event.key === "Meta" || event.key === "Control") show(true);
					else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
						event.preventDefault();
						const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
						const forward = event.key === (rtl ? "ArrowLeft" : "ArrowRight");
						focusAt(event.key === "Home" ? 0 : event.key === "End" ? kinds.length - 1 : index + (forward ? 1 : -1));
					}
				}}
				onKeyUp={(event: KeyboardEvent) => {
					if (event.key === "Meta" || event.key === "Control") show(false);
				}}
				onPointerEnter={(event: PointerEvent) => show(event.metaKey || event.ctrlKey)}
				onPointerMove={(event: PointerEvent) => show(event.metaKey || event.ctrlKey)}
				onPointerLeave={() => inserter.preview(null)}
				onFocus={() => {
					setStop(index);
					show(false);
				}}
				onBlur={() => inserter.preview(null)}
				className={`group relative inline-grid size-7 shrink-0 place-items-center rounded-md ${
					TINTS[kind] ?? "text-chrome-text hover:bg-chrome-hover hover:text-chrome-strong"
				} ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-insert={kind}
				// The plain elements and Section can be dragged onto the page, where they land (BA-33).
				data-wc-drag={(ROW_ELEMENTS as readonly string[]).includes(kind) ? `insert:${kind}` : undefined}
			>
				<Glyph aria-hidden="true" className="size-4" />
				<Tip label={label} keys={more ? shortcutText("menu.insert") : undefined} side="top" />
			</button>
		);
	};

	return (
		<div
			ref={row}
			role="toolbar"
			aria-label={words.insert.row}
			className="flex h-8 items-center gap-2"
			data-wc-insert-buttons=""
		>
			{template ? (
				// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a group of the row's buttons, not a form's fieldset.
				<div
					role="group"
					aria-label={words.insert.templateGroup}
					className="flex h-8 items-center gap-2 rounded-lg bg-[#a78bfa]/15 px-0.5"
				>
					{button("outlet", 0)}
				</div>
			) : null}
			{kinds.slice(template ? 1 : 0).map((kind, at) => button(kind, at + (template ? 1 : 0)))}
		</div>
	);
}

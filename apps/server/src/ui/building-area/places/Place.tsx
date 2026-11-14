import { ArrowLeftIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";

/** Whether a key press is meant for a field (or a menu) rather than the place: Escape stays theirs. */
function keptBy(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.matches("input, textarea, select, [role='textbox'], [role='combobox']") ||
			target.closest("[role='menu'], [role='dialog'], [role='listbox']") !== null)
	);
}

/**
 * The frame every place uses (SPEC 2, 4 and 8; `places-content/01`): it takes the working area right
 * of the rail and above the bottom bar, in place of the canvas and the docks, at once (no slide, no
 * fade). Its header (40 high) has the back button in the same spot in every place (40 × 28, an arrow;
 * for a Member, "Back to {page}" in words) and the place's title (16 px); with an inner sidebar (256
 * wide) the header heads the sidebar, as the frames draw it, and the pane beside it is the place's own.
 *
 * Escape with no field focused leaves the place, as the back button does. It is drawn inside the
 * shell's `<main>` over the canvas, so the skip link and F6's canvas stop land in it while it is open.
 */
export function Place({
	words,
	title,
	backTo,
	onBack,
	sidebar,
	sidebarLabel,
	actions,
	aside,
	children,
	place,
	shape = "ruled",
	sidebarFoot,
}: {
	words: Words;
	/** The place's name ("Content"). */
	title: string;
	/** For a Member: the page the back button names ("Back to {page}"); null draws the Staff's arrow. */
	backTo: string | null;
	onBack(): void;
	/** The inner sidebar's rows (256 wide), if the place has one. */
	sidebar?: ReactNode;
	/** The inner sidebar's name, for screen readers. */
	sidebarLabel?: string;
	/** The header's own controls, at its end (a place with no sidebar, or the `header` shape). */
	actions?: ReactNode;
	/**
	 * A details panel at the place's end, the full height beside the header and the pane (a place with
	 * no sidebar: the Components place's, `places-content/05`).
	 */
	aside?: ReactNode;
	children: ReactNode;
	/** The place's address, for tests and styles (`content/pages`). */
	place: string;
	/**
	 * `ruled` (Content, `places-content/01`): a 256 sidebar ruled off from the pane, the header in a
	 * 53 px band. `card` (Media, `places-assets/01`): a 300 column and the place's own card beside it,
	 * 8 apart and 8 from the edges, the header 40 high with no rule. `header` (Forms, `forms-builder/01`):
	 * the header (40 high, its controls at its end) across the whole place, the 256 sidebar and the
	 * pane under it, 10 apart and 8 from the edges.
	 */
	shape?: "ruled" | "card" | "header";
	/** What sits at the foot of the sidebar, below its rows (Media's file count and storage). */
	sidebarFoot?: ReactNode;
}) {
	const back = useRef<HTMLButtonElement>(null);
	const latest = useRef(onBack);
	latest.current = onBack;

	// Focus starts on the back button when the place opens (not as its own address changes).
	useEffect(() => {
		back.current?.focus({ preventScroll: true });
	}, []);

	// Escape with no field focused goes back, after a menu or a field had its say (the bubbling phase:
	// a menu that closes on Escape stops it there).
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
			if (keptBy(event.target)) return;
			if (document.querySelector("[data-wc-narrow]")) return;
			event.preventDefault();
			latest.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	const backLabel = backTo ? fill(words.place.backToPage, { page: backTo }) : words.place.backToCanvas;
	const header = (
		// The header is 40 high (SPEC 4); heading a sidebar, it sits in a 53 px band ruled off below, as
		// `places-content/01` draws it, level with the pane's first row.
		<div
			className={`flex shrink-0 items-center ${
				shape === "card" || shape === "header"
					? "px-1"
					: sidebar
						? "border-chrome-line h-[53px] border-b px-3"
						: "mt-1 px-4"
			}`}
		>
			<div className="flex h-10 min-w-0 grow items-center gap-2.5" data-wc-place-header="">
				<span className="group relative inline-flex shrink-0">
					<button
						ref={back}
						type="button"
						onClick={onBack}
						aria-label={backLabel}
						aria-keyshortcuts="Escape"
						className={`border-chrome-hover text-chrome-text hover:bg-chrome-hover hover:text-chrome-strong inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md border ${
							backTo ? "px-2.5 text-[12px] font-medium" : "w-10"
						} ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-place-back=""
					>
						<ArrowLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
						{backTo ? <span className="max-w-40 truncate">{backLabel}</span> : null}
					</button>
					<Tip label={backLabel} keys="Esc" side="bottom" />
				</span>
				<h1 className="text-chrome-strong m-0 min-w-0 truncate text-[16px] font-normal">{title}</h1>
				{actions ? <div className="ms-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
			</div>
		</div>
	);

	if (shape === "header") {
		return (
			<section
				aria-label={title}
				data-wc-place-frame={place}
				className="bg-chrome text-chrome-text absolute inset-0 z-10 flex min-h-0 min-w-0 flex-col gap-2.5 p-2"
			>
				{header}
				<div className="flex min-h-0 min-w-0 grow gap-2.5">
					{sidebar ? (
						<div className="flex w-64 shrink-0 flex-col" data-wc-place-sidebar="">
							<nav aria-label={sidebarLabel ?? title} className="min-h-0 grow overflow-y-auto">
								{sidebar}
							</nav>
							{sidebarFoot}
						</div>
					) : null}
					<div className="flex min-h-0 min-w-0 grow flex-col" data-wc-place-pane="">
						{children}
					</div>
				</div>
			</section>
		);
	}

	return (
		<section
			aria-label={title}
			data-wc-place-frame={place}
			className={`bg-chrome text-chrome-text absolute inset-0 z-10 flex min-h-0 min-w-0 ${shape === "card" ? "gap-2 p-2" : ""}`}
		>
			{sidebar ? (
				<>
					<div
						className={`flex shrink-0 flex-col ${shape === "card" ? "w-[300px]" : "border-chrome-line w-64 border-e"}`}
						data-wc-place-sidebar=""
					>
						{header}
						<nav aria-label={sidebarLabel ?? title} className="min-h-0 grow overflow-y-auto">
							{sidebar}
						</nav>
						{sidebarFoot}
					</div>
					<div className="flex min-h-0 min-w-0 grow flex-col" data-wc-place-pane="">
						{children}
					</div>
				</>
			) : (
				<>
					<div className="flex min-h-0 min-w-0 grow flex-col" data-wc-place-pane="">
						{header}
						{children}
					</div>
					{aside}
				</>
			)}
		</section>
	);
}

/** A part of a place that a later part of the building area brings: says so, and links to the admin. */
export function PlaceLater({ words, admin }: { words: Words; admin: string }) {
	return (
		<div className="grid grow place-items-center p-8" data-wc-place-later="">
			<div className="flex max-w-md flex-col items-center gap-2 text-center">
				<h2 className="text-chrome-strong m-0 text-[14px] font-semibold">{words.place.laterTitle}</h2>
				<p className="text-chrome-muted m-0 text-[12px]">{words.place.laterText}</p>
				<a
					href={admin}
					target="_blank"
					rel="noopener noreferrer"
					className={`text-chrome-accent rounded-sm text-[12px] font-medium underline-offset-2 hover:underline ${FOCUS_RING}`}
				>
					{words.place.openAdmin}
				</a>
			</div>
		</div>
	);
}

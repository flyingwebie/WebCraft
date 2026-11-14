import { ChevronsLeftRightIcon, ChevronsUpDownIcon } from "lucide-react";
import type { KeyboardEvent, PointerEvent } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE } from "../controls.tsx";
import { FRAME_MIN, type FrameLayout, type GutterSide } from "./gutters.ts";

/** How far an arrow key moves a gutter, in the page's pixels; with Shift, further. */
const KEY_STEP = 10;
const KEY_STEP_LARGE = 100;

/**
 * One of the canvas's grab gutters (SPEC 4 and 7, `docking/06`): 12 px of chrome beside or below the
 * frame with a grab pill, brighter under the pointer and while dragged. A separator for the keyboard:
 * the arrow keys change the width (or the height below), Enter goes back to full width (or height),
 * as a double-click does.
 */
export function Gutter({
	side,
	layout,
	widest,
	highest,
	dragging,
	words,
	onDragStart,
	onDragMove,
	onDragEnd,
	onFull,
	onStep,
	onPointerInside,
	onFocusInside,
}: {
	side: GutterSide;
	layout: FrameLayout;
	/** The widest page and the highest, for the separator's range. */
	widest: number;
	highest: number;
	dragging: boolean;
	words: Words;
	onDragStart(side: GutterSide, x: number, y: number): void;
	onDragMove(x: number, y: number): void;
	onDragEnd(): void;
	/** Back to full width (a side gutter) or full height (the one below). */
	onFull(side: GutterSide): void;
	/** The keyboard moved it: by this many page pixels, away from the frame's middle when positive. */
	onStep(side: GutterSide, by: number | "min" | "max"): void;
	onPointerInside(inside: boolean): void;
	onFocusInside(inside: boolean): void;
}) {
	const below = side === "below";
	const label = below ? words.size.gutterBelow : side === "start" ? words.size.gutterStart : words.size.gutterEnd;
	const value = below ? layout.pageHeight : layout.pageWidth;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		// Towards the outside of the frame is bigger: right of the end gutter, left of the start one, down below.
		const outwards: Record<string, number> = below
			? { ArrowDown: 1, ArrowUp: -1 }
			: (side === "end") !== rtl
				? { ArrowRight: 1, ArrowLeft: -1 }
				: { ArrowLeft: 1, ArrowRight: -1 };
		const direction = outwards[event.key];
		if (direction !== undefined) onStep(side, direction * step);
		else if (event.key === "Home") onStep(side, "min");
		else if (event.key === "End") onStep(side, "max");
		else if (event.key === "Enter") onFull(side);
		else return;
		event.preventDefault();
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a separator that moves is focusable, which <hr> is not.
		<div
			role="separator"
			tabIndex={0}
			aria-label={label}
			aria-orientation={below ? "horizontal" : "vertical"}
			aria-valuenow={value}
			aria-valuemin={FRAME_MIN}
			aria-valuemax={below ? highest : widest}
			aria-valuetext={fill(
				below ? words.size.heightNow : words.size.widthNow,
				below ? { height: String(value) } : { width: String(value) },
			)}
			data-wc-gutter={side}
			data-dragging={dragging ? "" : undefined}
			onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				onDragStart(side, event.clientX, event.clientY);
			}}
			onPointerMove={(event) => {
				if (dragging) onDragMove(event.clientX, event.clientY);
			}}
			onPointerUp={(event) => {
				if (!dragging) return;
				event.currentTarget.releasePointerCapture(event.pointerId);
				onDragEnd();
			}}
			onLostPointerCapture={() => {
				if (dragging) onDragEnd();
			}}
			onDoubleClick={() => onFull(side)}
			onKeyDown={onKeyDown}
			onPointerEnter={() => onPointerInside(true)}
			onPointerLeave={() => onPointerInside(false)}
			onFocus={() => onFocusInside(true)}
			onBlur={() => onFocusInside(false)}
			className={`group/gutter focus-visible:ring-chrome-focus absolute flex touch-none items-center justify-center outline-none select-none focus-visible:ring-2 focus-visible:ring-inset ${
				below
					? "start-3 end-3 bottom-0 h-3 cursor-ns-resize flex-row"
					: `top-0 bottom-3 w-3 cursor-ew-resize flex-col gap-1 ${side === "start" ? "start-0" : "end-0"}`
			} ${dragging ? "bg-chrome-hover" : "hover:bg-chrome-hover"} ${CHROME_EASE}`}
		>
			{dragging && !below ? <ChevronsLeftRightIcon aria-hidden="true" className="text-chrome-strong size-3" /> : null}
			{dragging && below ? <ChevronsUpDownIcon aria-hidden="true" className="text-chrome-strong size-3" /> : null}
			<span
				aria-hidden="true"
				className={`rounded-[2px] ${below ? "h-1 w-[30px]" : "h-[30px] w-1"} ${
					dragging ? "bg-chrome-strong" : "bg-chrome-faint group-hover/gutter:bg-chrome-strong"
				} ${CHROME_EASE}`}
				data-wc-pill=""
			/>
		</div>
	);
}

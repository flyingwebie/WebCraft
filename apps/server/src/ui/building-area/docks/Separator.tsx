import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

import { FOCUS_RING } from "../controls.tsx";

/**
 * While a separator is dragged the page's frame takes no pointer events, so a pointer that crosses
 * into it keeps moving the separator (the frame is another document).
 */
export function framesIgnorePointer(ignore: boolean): void {
	for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe[data-wc-frame]")) {
		frame.style.pointerEvents = ignore ? "none" : "";
	}
}

/** How far an arrow key moves a separator, in pixels (Shift: further). */
const STEP = 10;
const BIG_STEP = 50;

/**
 * A separator the pointer or the keyboard moves (SPEC 4 and 10, `docking/05`): between two panels of
 * a dock (8 wide, the gap itself), or between a dock and the canvas (the dock's 8 px padding there, so
 * it never covers the canvas's gutter). At rest a 1 px line; under the pointer its area tints and an
 * accent line fades in over 250 ms and out over 350 ms; while dragged the line stays. A focusable
 * `separator`: the arrow keys move it, Shift further. A double-click does what `onDoubleClick` says.
 */
export function Separator({
	orientation,
	label,
	value,
	onMove,
	onStart,
	onEnd,
	onDoubleClick,
	className = "",
	line = true,
	data,
}: {
	/** `horizontal`: a line across, moved up and down (heights); `vertical`: a line down, moved sideways (widths). */
	orientation: "horizontal" | "vertical";
	label: string;
	/** What the separator sets, for assistive technology: now, at least and at most, in pixels. */
	value?: { now: number; min: number; max: number };
	/** The separator moved `delta` pixels from where the move started (right or down positive, as drawn). */
	onMove(delta: number, from: "pointer" | "key"): void;
	/** A pointer move ended. */
	/** A pointer press started a move: what it moves from is read now. */
	onStart?(): void;
	onEnd?(): void;
	onDoubleClick?(): void;
	className?: string;
	/** Whether the resting 1 px line shows (between panels it does; at a dock's edge the dock's border is the line). */
	line?: boolean;
	data?: Record<`data-${string}`, string>;
}) {
	const [dragging, setDragging] = useState(false);
	const start = useRef<{ x: number; y: number; id: number } | null>(null);
	const across = orientation === "horizontal";

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
		onStart?.();
		framesIgnorePointer(true);
		setDragging(true);
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const from = start.current;
		if (!from || from.id !== event.pointerId) return;
		onMove(across ? event.clientY - from.y : event.clientX - from.x, "pointer");
	};
	const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!start.current || start.current.id !== event.pointerId) return;
		start.current = null;
		framesIgnorePointer(false);
		setDragging(false);
		onEnd?.();
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: a separator that moves is focusable, which <hr> is not.
		<div
			role="separator"
			tabIndex={0}
			aria-orientation={orientation}
			aria-label={label}
			aria-valuenow={value ? Math.round(value.now) : undefined}
			aria-valuemin={value ? Math.round(value.min) : undefined}
			aria-valuemax={value ? Math.round(value.max) : undefined}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={finish}
			onPointerCancel={finish}
			onLostPointerCapture={finish}
			onDoubleClick={onDoubleClick}
			onKeyDown={(event) => {
				// As drawn, like a pointer: left and up negative, whatever the writing direction.
				const step = event.shiftKey ? BIG_STEP : STEP;
				const keys: Record<string, number> = across
					? { ArrowUp: -step, ArrowDown: step }
					: { ArrowLeft: -step, ArrowRight: step };
				const by = keys[event.key];
				if (by !== undefined) {
					event.preventDefault();
					onMove(by, "key");
				} else if (event.key === "Enter" && onDoubleClick) {
					event.preventDefault();
					onDoubleClick();
				}
			}}
			className={`group relative z-10 flex shrink-0 touch-none items-center justify-center ${
				across ? "h-2 w-full cursor-row-resize" : "h-full w-2 cursor-col-resize"
			} ${FOCUS_RING} ${className}`}
			data-wc-separator={orientation}
			data-dragging={dragging ? "" : undefined}
			{...data}
		>
			{/* The hit area's tint under the pointer. */}
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 bg-[#fb923c1a] opacity-0 transition-opacity duration-[350ms] ease-in-out group-hover:opacity-100 group-hover:duration-[250ms] motion-reduce:transition-none"
			/>
			{line ? (
				<span
					aria-hidden="true"
					className={`bg-chrome-line pointer-events-none ${across ? "h-px w-full" : "h-full w-px"}`}
				/>
			) : null}
			{/* The accent line: in over 250 ms, out over 350 ms; held while dragged or focused. */}
			<span
				aria-hidden="true"
				className={`bg-chrome-focus pointer-events-none absolute transition-opacity duration-[350ms] ease-in-out group-hover:opacity-100 group-hover:duration-[250ms] group-focus-visible:opacity-100 motion-reduce:transition-none ${
					across
						? "inset-x-0 top-1/2 h-0.5 -translate-y-1/2"
						: "inset-y-0 start-1/2 w-0.5 -translate-x-1/2 rtl:translate-x-1/2"
				} ${dragging ? "opacity-100" : "opacity-0"}`}
				data-wc-separator-accent=""
			/>
		</div>
	);
}

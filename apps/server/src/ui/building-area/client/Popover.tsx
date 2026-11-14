import { XIcon } from "lucide-react";
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { CHROME_EASE, FOCUS_RING, type Icon } from "../controls.tsx";

/** A popover's width (SPEC 13.1: dark, radius 14, 380 wide). */
export const POPOVER_WIDTH = 380;
/** The space between a popover and its element, and the least it keeps from the canvas's edges. */
const GAP = 12;
const MARGIN = 8;

/** The canvas's box on the shell's window: what a popover stays inside. */
function canvasBox(): DOMRect {
	return (
		document.querySelector("[data-wc-canvas]")?.getBoundingClientRect() ??
		new DOMRect(0, 0, window.innerWidth, window.innerHeight)
	);
}

/**
 * Where a popover goes for its element's box: beside it (a photo: on the side with room, `client/03`)
 * or under it (a link or a button, `client/04`), above it when there is no room under; always inside
 * the canvas.
 */
export function popoverPlace(
	box: DOMRect,
	size: { width: number; height: number },
	where: "side" | "below",
	canvas: DOMRect,
): { left: number; top: number } {
	const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, Math.max(low, high)));
	const left = clamp(box.left, canvas.left + MARGIN, canvas.right - size.width - MARGIN);
	const under = box.bottom + GAP;
	const below = {
		left,
		top:
			under + size.height <= canvas.bottom - MARGIN || box.top - GAP - size.height < canvas.top + MARGIN
				? clamp(under, canvas.top + MARGIN, canvas.bottom - size.height - MARGIN)
				: box.top - GAP - size.height,
	};
	if (where === "below") return below;
	const top = clamp(box.top, canvas.top + MARGIN, canvas.bottom - size.height - MARGIN);
	if (box.left - GAP - size.width >= canvas.left + MARGIN) return { left: box.left - GAP - size.width, top };
	if (box.right + GAP + size.width <= canvas.right - MARGIN) return { left: box.right + GAP, top };
	return below;
}

/**
 * The frame of client editing's popovers (SPEC 13.1 and 13.3; `client/03`, `client/04`): a dark card
 * that belongs to one thing on the page, its icon and name at the top with Close. It is a dialog: focus
 * goes into it as it opens (to the control `focus` names, else the first marked `data-wc-autofocus`),
 * Escape closes it and gives focus back to its element, and a press outside it closes it.
 */
export function Popover({
	kind,
	icon: IconShown,
	title,
	closeLabel,
	box,
	where,
	focus,
	seq,
	hidden,
	onClose,
	children,
}: {
	kind: string;
	icon: Icon;
	title: string;
	closeLabel: string;
	/** Its element's box on the shell's window. */
	box: DOMRect;
	where: "side" | "below";
	/** The control focus goes to as it opens (`data-wc-focus-key`), else the first `data-wc-autofocus`. */
	focus: string | null;
	/** Changes each time it opens (again): focus goes into it then. */
	seq: number;
	/** Waiting while the Media picker it opened is up. */
	hidden: boolean;
	onClose(returnFocus: boolean): void;
	children: ReactNode;
}) {
	const card = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const [size, setSize] = useState({ width: POPOVER_WIDTH, height: 0 });
	const closeRef = useRef(onClose);
	closeRef.current = onClose;

	// Its size, measured as drawn, decides where it goes.
	useLayoutEffect(() => {
		const element = card.current;
		if (!element) return;
		const measure = () => setSize({ width: element.offsetWidth, height: element.offsetHeight });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// Focus goes into it as it opens, and again when it opens on another element.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `seq` is the opening.
	useEffect(() => {
		const element = card.current;
		if (!element || hidden) return;
		const wanted =
			(focus ? element.querySelector<HTMLElement>(`[data-wc-focus-key="${focus}"]`) : null) ??
			element.querySelector<HTMLElement>("[data-wc-autofocus]");
		(wanted ?? element).focus();
	}, [seq, hidden]);

	// A press outside it closes it (the page in the frame tells the marks, which close it there).
	useEffect(() => {
		if (hidden) return;
		const outside = (event: PointerEvent) => {
			const target = event.target as Element | null;
			if (!target || card.current?.contains(target)) return;
			// Another dialog (the Media picker) or the frame's own page: not outside for this.
			if (target.closest("[role='dialog'], dialog, iframe[data-wc-frame]")) return;
			closeRef.current(false);
		};
		document.addEventListener("pointerdown", outside, true);
		return () => document.removeEventListener("pointerdown", outside, true);
	}, [hidden]);

	const place = popoverPlace(box, size, where, canvasBox());
	return (
		<div
			ref={card}
			role="dialog"
			aria-labelledby={titleId}
			tabIndex={-1}
			hidden={hidden}
			data-wc-popover={kind}
			className="bg-chrome-menu border-chrome-hover text-chrome-text fixed z-30 flex w-[380px] flex-col gap-[14px] rounded-[14px] border p-4 text-[13px] shadow-[0_20px_48px_rgba(0,0,0,0.4)] outline-none"
			style={{ left: place.left, top: place.top }}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				onClose(true);
			}}
			onBlur={(event) => {
				// Focus gone elsewhere in the shell (not a window, not another dialog): it closes.
				const next = event.relatedTarget as Element | null;
				if (!next || card.current?.contains(next) || next.closest("[role='dialog'], dialog")) return;
				onClose(false);
			}}
		>
			<div className="flex w-full items-center gap-2.5">
				<IconShown className="text-chrome-text size-[18px] shrink-0" aria-hidden="true" />
				<h2 id={titleId} className="text-chrome-strong m-0 min-w-0 flex-1 truncate text-[15px] font-semibold">
					{title}
				</h2>
				<button
					type="button"
					aria-label={closeLabel}
					title={closeLabel}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-7 shrink-0 place-items-center rounded-[7px] ${CHROME_EASE} ${FOCUS_RING}`}
					onClick={() => onClose(true)}
				>
					<XIcon className="size-4" aria-hidden="true" />
				</button>
			</div>
			{children}
		</div>
	);
}

/** A button of the popovers (`CButton`: 40 high, radius 9, its icon and a word). */
export function PopoverButton({
	icon: IconShown,
	children,
	variant = "outline",
	className = "",
	...rest
}: {
	icon?: Icon;
	children: ReactNode;
	variant?: "outline" | "quiet";
} & ButtonHTMLAttributes<HTMLButtonElement> &
	Record<`data-${string}`, string | undefined>) {
	const look =
		variant === "outline"
			? "border border-[#3f3f46] text-chrome-text hover:bg-chrome-hover"
			: "bg-chrome-hover text-chrome-strong hover:bg-[#34343b]";
	return (
		<button
			type="button"
			className={`inline-flex h-10 items-center justify-center gap-2 rounded-[9px] px-3 text-[13px] font-semibold whitespace-nowrap disabled:opacity-50 aria-disabled:opacity-50 ${look} ${CHROME_EASE} ${FOCUS_RING} ${className}`}
			{...rest}
		>
			{IconShown ? <IconShown className="size-4 shrink-0" aria-hidden="true" /> : null}
			{children}
		</button>
	);
}

/** A labelled field of the popovers (`CField`): its label, the control, one line of help. */
export function PopoverField({
	label,
	htmlFor,
	labelId,
	end,
	hint,
	hintId,
	children,
}: {
	label: string;
	htmlFor?: string;
	labelId?: string;
	/** Beside the label, at its end (a small action). */
	end?: ReactNode;
	hint?: ReactNode;
	hintId?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex w-full flex-col gap-1.5">
			<div className="flex min-h-5 w-full items-center gap-2">
				<label id={labelId} htmlFor={htmlFor} className="text-chrome-strong flex-1 text-[13px] font-medium">
					{label}
				</label>
				{end}
			</div>
			{children}
			{hint ? (
				<p id={hintId} className="text-chrome-muted m-0 text-[12px]">
					{hint}
				</p>
			) : null}
		</div>
	);
}

/** The text controls of the popovers (`CInput`): 40 high, radius 8, on the raised fill. */
export const INPUT =
	"bg-chrome-raised text-chrome-strong placeholder:text-chrome-faint w-full rounded-lg border border-[#3f3f46] px-3 text-[14px] leading-5 outline-none focus-visible:border-chrome-focus focus-visible:ring-1 focus-visible:ring-chrome-focus";

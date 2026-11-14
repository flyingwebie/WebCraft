import type { ComponentType, ReactNode, Ref } from "react";

/**
 * The chrome's icon buttons (SPEC 4 and 10): a real name on every one, and a tooltip that shows at
 * once on hover and on keyboard focus, naming the action and its keys. The tooltip repeats the name
 * for the eye only; screen readers get the name and `aria-keyshortcuts`.
 */

/** A focus ring the chrome's controls share: orange on the dark chrome, as the frames draw it. */
export const FOCUS_RING =
	"outline-none focus-visible:ring-2 focus-visible:ring-chrome-focus focus-visible:ring-offset-1 focus-visible:ring-offset-chrome";

/** Colour and opacity changes on the chrome: 150 ms, none with reduced motion (SPEC 10). */
export const CHROME_EASE =
	"transition-[background-color,color,opacity] duration-150 ease-in-out motion-reduce:transition-none";

export type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;

/** Where a tooltip opens: beside the rail, or above the bottom bar. */
export type TipSide = "end" | "top" | "bottom";
export type TipAlign = "start" | "center" | "end";

/** A tooltip's text, with the keys after it in the code face. */
export function Tip({
	label,
	keys,
	side,
	align = "center",
}: {
	label: string;
	keys?: string;
	side: TipSide;
	/** Above or below: centred on its control, or kept inside the window at the two ends of a bar or a header. */
	align?: TipAlign;
}) {
	const above = {
		start: "bottom-[calc(100%+8px)] start-0",
		center: "bottom-[calc(100%+8px)] start-1/2 -translate-x-1/2 rtl:translate-x-1/2",
		end: "bottom-[calc(100%+8px)] end-0",
	}[align];
	const below = {
		start: "top-[calc(100%+8px)] start-0",
		center: "start-1/2 top-[calc(100%+8px)] -translate-x-1/2 rtl:translate-x-1/2",
		end: "top-[calc(100%+8px)] end-0",
	}[align];
	return (
		<span
			aria-hidden="true"
			data-wc-tip=""
			className={`border-chrome-hover bg-chrome-tip text-chrome-strong pointer-events-none absolute z-40 hidden h-[26px] items-center gap-2 rounded-md border px-2 text-[11px] font-medium whitespace-nowrap shadow-[0_6px_16px_rgba(0,0,0,0.5)] group-hover:flex group-focus-visible:flex ${
				side === "end" ? "start-[calc(100%+12px)] top-1/2 -translate-y-1/2" : side === "bottom" ? below : above
			}`}
		>
			{label}
			{keys ? <span className="text-chrome-muted font-mono">{keys}</span> : null}
		</span>
	);
}

type CommonProps = {
	icon: Icon;
	/** The control's name, also its tooltip. */
	label: string;
	/** The keys that do the same, as they show (`⌘Z`), and for `aria-keyshortcuts` (`Meta+Z`). */
	keys?: { shown: string; aria: string };
	side: TipSide;
	align?: TipAlign;
	/** Drawn as on: the open place, a switch that is on. */
	on?: boolean;
	/** The size of the button: the rail's 28 × 28, the bottom bar's 30 × 28. */
	size?: "rail" | "bar";
	/** Shown, but not for now: dimmed, and saying so in its tooltip. */
	unavailable?: string;
	className?: string;
	children?: ReactNode;
};

function look({ on, size = "rail", unavailable, className }: CommonProps): string {
	return [
		"group relative inline-grid shrink-0 place-items-center rounded-md",
		size === "rail" ? "size-7" : "h-7 w-[30px]",
		on ? "bg-chrome-hover text-chrome-strong" : "text-chrome-text",
		unavailable ? "cursor-default [&>svg]:opacity-35" : "hover:bg-chrome-hover hover:text-chrome-strong",
		"disabled:cursor-default disabled:[&>svg]:opacity-30 disabled:hover:bg-transparent",
		CHROME_EASE,
		FOCUS_RING,
		className ?? "",
	].join(" ");
}

/** An icon button of the chrome. `pressed` makes it a switch (`aria-pressed`). */
export function IconButton(
	props: CommonProps & {
		onClick?(): void;
		pressed?: boolean;
		/** It opens a menu: whether that menu is open, and the menu's id. */
		popup?: { open: boolean; id: string };
		disabled?: boolean;
		ref?: Ref<HTMLButtonElement>;
		/** Extra attributes for tests and for the region it belongs to. */
		data?: Record<`data-${string}`, string>;
	},
) {
	const {
		icon: Glyph,
		label,
		keys,
		side,
		align,
		unavailable,
		pressed,
		popup,
		disabled,
		onClick,
		ref,
		data,
		children,
	} = props;
	const tip = unavailable ? `${label} · ${unavailable}` : label;
	return (
		<button
			ref={ref}
			type="button"
			aria-label={unavailable ? tip : label}
			aria-keyshortcuts={keys?.aria || undefined}
			aria-pressed={pressed}
			aria-haspopup={popup ? "menu" : undefined}
			aria-expanded={popup ? popup.open : undefined}
			aria-controls={popup?.open ? popup.id : undefined}
			aria-disabled={unavailable ? true : undefined}
			disabled={disabled}
			onClick={unavailable || disabled ? undefined : onClick}
			className={look(props)}
			{...data}
		>
			<Glyph aria-hidden="true" className="size-4" />
			{children}
			<Tip label={tip} keys={unavailable ? undefined : keys?.shown} side={side} align={align} />
		</button>
	);
}

/** An icon link of the chrome (Settings in a new tab, View on Staging). */
export function IconLink(
	props: CommonProps & { href: string; newTab?: boolean; data?: Record<`data-${string}`, string> },
) {
	const { icon: Glyph, label, side, align, href, newTab, data } = props;
	return (
		<a
			href={href}
			aria-label={label}
			className={look(props)}
			{...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
			{...data}
		>
			<Glyph aria-hidden="true" className="size-4" />
			<Tip label={label} side={side} align={align} />
		</a>
	);
}

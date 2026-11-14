import { MonitorIcon, RotateCcwIcon, SmartphoneIcon, TabletIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon, Tip } from "../controls.tsx";
import {
	type Breakpoint,
	breakpointAt,
	clampWidth,
	type FrameLayout,
	type FrameSize,
	type Pane,
	PRESETS,
	type Preset,
	presetOf,
} from "./gutters.ts";

const PRESET_ICONS: Record<Preset, Icon> = { desktop: MonitorIcon, tablet: TabletIcon, phone: SmartphoneIcon };

/** How long the pointer stays over a gutter before the readout shows, and how long it stays after it leaves. */
export const READOUT_SHOW_MS = 300;
export const READOUT_HIDE_MS = 1500;

/**
 * Whether the size readout shows (SPEC 7 and 10): always while the frame is narrower than the pane or
 * zoomed; otherwise 300 ms after the pointer reaches a gutter (at once on keyboard focus or a drag),
 * and until 1.5 s after it leaves.
 */
export function useReadoutShown(options: { always: boolean; active: boolean; immediate: boolean }): boolean {
	const { always, active, immediate } = options;
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (active && immediate) {
			setShown(true);
			return;
		}
		const timer = window.setTimeout(() => setShown(active), active ? READOUT_SHOW_MS : READOUT_HIDE_MS);
		return () => window.clearTimeout(timer);
	}, [active, immediate]);
	return always || shown;
}

/**
 * The size readout over the canvas (SPEC 7, `builder/03`, `docking/06`): the Desktop, Tablet and Phone
 * presets, the page's width as a field, its height, the zoom (amber, with a way back to full width,
 * when the page is zoomed out to fit) and the breakpoint the width is in.
 */
export function SizeReadout({
	size,
	layout,
	pane,
	breakpoints,
	words,
	onSize,
	onPointerInside,
	onFocusInside,
}: {
	size: FrameSize;
	layout: FrameLayout;
	pane: Pane;
	breakpoints: readonly Breakpoint[];
	words: Words;
	/** A control set the size: the frame moves to it with a 200 ms ease. */
	onSize(size: FrameSize): void;
	onPointerInside(inside: boolean): void;
	onFocusInside(inside: boolean): void;
}) {
	const shown = words.size;
	const preset = presetOf(size, layout);
	const breakpoint = breakpointAt(breakpoints, layout.pageWidth);
	const zoom = Math.round(layout.scale * 100);
	const [typed, setTyped] = useState<string | null>(null);
	const field = useRef<HTMLInputElement>(null);

	const commit = () => {
		if (typed === null) return;
		const width = Number.parseInt(typed, 10);
		setTyped(null);
		if (Number.isFinite(width)) onSize({ ...size, width: clampWidth(width, pane) });
	};

	return (
		<fieldset
			aria-label={shown.readout}
			data-wc-readout=""
			onPointerEnter={() => onPointerInside(true)}
			onPointerLeave={() => onPointerInside(false)}
			onFocus={() => onFocusInside(true)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onFocusInside(false);
			}}
			className="border-chrome-hover bg-chrome-menu/95 absolute start-1/2 top-2.5 z-30 m-0 flex h-[34px] min-w-0 -translate-x-1/2 items-center gap-2 rounded-lg border px-1.5 text-[12px] shadow-[0_8px_24px_rgba(0,0,0,0.45)] rtl:translate-x-1/2"
		>
			<fieldset aria-label={shown.presets} className="m-0 flex min-w-0 items-center gap-0.5 border-0 p-0">
				{(Object.keys(PRESETS) as Preset[]).map((each) => {
					const Glyph = PRESET_ICONS[each];
					const on = preset === each;
					return (
						<button
							key={each}
							type="button"
							aria-label={shown[each]}
							aria-pressed={on}
							onClick={() => onSize({ ...size, width: PRESETS[each] })}
							className={`group relative grid h-[22px] w-6 place-items-center rounded-[5px] ${
								on ? "bg-chrome-hover text-chrome-strong" : "text-chrome-muted hover:text-chrome-strong"
							} ${CHROME_EASE} ${FOCUS_RING}`}
							data-wc-preset={each}
						>
							<Glyph aria-hidden="true" className="size-3.5" />
							<Tip label={shown[each]} side="bottom" />
						</button>
					);
				})}
			</fieldset>
			<span aria-hidden="true" className="bg-chrome-hover h-[18px] w-px" />
			<input
				ref={field}
				type="text"
				inputMode="numeric"
				aria-label={shown.width}
				value={typed ?? String(layout.pageWidth)}
				onChange={(event) => setTyped(event.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						commit();
					} else if (event.key === "Escape" && typed !== null) {
						event.preventDefault();
						event.stopPropagation();
						setTyped(null);
					} else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault();
						const step = (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
						setTyped(null);
						onSize({ ...size, width: clampWidth(layout.pageWidth + step, pane) });
					}
				}}
				className="border-chrome-hover bg-chrome-well text-chrome-strong focus:border-chrome-focus focus:ring-chrome-focus h-[22px] w-[52px] rounded-[5px] border px-1.5 font-mono text-[12px] outline-none focus:ring-1"
				data-wc-width=""
			/>
			<span className="text-chrome-muted font-mono whitespace-nowrap" data-wc-height="">
				{`px ${fill(shown.height, { height: String(layout.pageHeight) })}`}
			</span>
			<span aria-hidden="true" className="bg-chrome-hover h-[18px] w-px" />
			<span
				className={`font-mono whitespace-nowrap ${layout.zoomed ? "text-chrome-warn" : "text-chrome-muted"}`}
				data-wc-zoom=""
			>
				<span className="sr-only">{`${shown.zoom}: `}</span>
				{`${zoom} %`}
			</span>
			{layout.zoomed ? (
				<>
					<span className="sr-only" data-wc-zoomed-out="">
						{fill(shown.zoomedOut, { zoom: String(zoom) })}
					</span>
					<button
						type="button"
						aria-label={shown.fullWidth}
						onClick={() => onSize({ width: null, height: size.height })}
						className={`group text-chrome-warn hover:bg-chrome-hover relative grid size-[22px] place-items-center rounded-[5px] ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-reset-zoom=""
					>
						<RotateCcwIcon aria-hidden="true" className="size-3.5" />
						<Tip label={shown.fullWidth} side="bottom" />
					</button>
				</>
			) : null}
			{breakpoint ? (
				<span
					className="bg-chrome-raised text-chrome-muted flex h-[22px] items-center rounded-[5px] px-1.5 text-[11px] font-medium"
					data-wc-breakpoint={breakpoint.name}
				>
					<span className="sr-only">{fill(shown.breakpoint, { name: breakpoint.name })}</span>
					<span aria-hidden="true">{breakpoint.name}</span>
				</span>
			) : null}
		</fieldset>
	);
}

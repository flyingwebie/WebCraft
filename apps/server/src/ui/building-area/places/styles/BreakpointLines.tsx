import { useEffect, useRef, useState } from "react";

import { useShownBreakpoints } from "./canvas.ts";

/** Where the frame is in the canvas, and how wide its page is (wider than the frame when zoomed out). */
type FrameBox = { left: number; top: number; width: number; height: number; pageWidth: number };

/**
 * The Breakpoints switched on in Styles › Breakpoints ("Show on canvas", `places-assets/07`), drawn
 * over the canvas: two dashed lines where the frame's edges would be at each Breakpoint's width (the
 * frame narrows from both sides), with its name and width at the top. Drawn for the eye only and never
 * in the pointer's way: the size readout names the Breakpoint a width is in for everyone. Placed by
 * measured boxes, so physically (`left`), in either direction.
 */
export function BreakpointLines() {
	const shown = useShownBreakpoints();
	const self = useRef<HTMLDivElement>(null);
	const [box, setBox] = useState<FrameBox | null>(null);

	useEffect(() => {
		const host = self.current?.parentElement;
		if (!host || shown.length === 0) return;
		const measure = () => {
			const frameBox = host.querySelector<HTMLElement>("[data-wc-frame-box]");
			if (!frameBox) {
				setBox(null);
				return;
			}
			const outer = host.getBoundingClientRect();
			const inner = frameBox.getBoundingClientRect();
			let pageWidth = inner.width;
			try {
				pageWidth = frameBox.querySelector("iframe")?.contentWindow?.innerWidth || inner.width;
			} catch {
				// The frame's page can't be read: its width is the frame's.
			}
			const next = {
				left: inner.left - outer.left,
				top: inner.top - outer.top,
				width: inner.width,
				height: inner.height,
				pageWidth,
			};
			setBox((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
		};
		measure();
		const sizes = new ResizeObserver(measure);
		sizes.observe(host);
		let observed: Element | null = null;
		const follow = () => {
			const frameBox = host.querySelector("[data-wc-frame-box]");
			if (frameBox !== observed) {
				if (observed) sizes.unobserve(observed);
				if (frameBox) sizes.observe(frameBox);
				observed = frameBox;
			}
			measure();
		};
		follow();
		// The frame is made again for another document, and eases to a new width with a transition.
		const changes = new MutationObserver(follow);
		changes.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
		host.addEventListener("transitionend", measure, true);
		window.addEventListener("resize", measure);
		return () => {
			sizes.disconnect();
			changes.disconnect();
			host.removeEventListener("transitionend", measure, true);
			window.removeEventListener("resize", measure);
		};
	}, [shown.length]);

	if (shown.length === 0) return <div ref={self} hidden />;
	const scale = box && box.pageWidth > 0 ? box.width / box.pageWidth : 1;
	return (
		<div
			ref={self}
			aria-hidden="true"
			className="pointer-events-none absolute inset-0 z-20"
			data-wc-breakpoint-lines=""
		>
			{box
				? [...shown]
						.sort((a, b) => a.width - b.width)
						.map((breakpoint) => {
							const half = (breakpoint.width * scale) / 2;
							// A width wider than the page shown has no edge on the canvas.
							if (half * 2 > box.width + 1) return null;
							const centre = box.left + box.width / 2;
							return (
								<div key={breakpoint.id} data-wc-breakpoint-line={breakpoint.name}>
									<span
										className="border-condition absolute border-s border-dashed"
										style={{ left: `${centre - half}px`, top: `${box.top}px`, height: `${box.height}px` }}
									/>
									<span
										className="border-condition absolute border-s border-dashed"
										style={{ left: `${centre + half}px`, top: `${box.top}px`, height: `${box.height}px` }}
									/>
									<span
										className="bg-chrome-menu text-chrome-text border-chrome-hover absolute flex h-[18px] items-center gap-1 rounded-[5px] border px-1.5 font-mono text-[10px] whitespace-nowrap"
										style={{ left: `${centre + half + 4}px`, top: `${box.top + 4}px` }}
									>
										<span className="bg-condition size-[7px] rounded-full" />
										{`${breakpoint.name} · ${breakpoint.width}`}
									</span>
								</div>
							);
						})
				: null}
		</div>
	);
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { editRequests, type ShellConfig } from "./api.ts";
import { Frame } from "./canvas/Frame.tsx";
import { type RegionCycle, regionCycle } from "./keyboard.ts";

/**
 * The building area's shell (ADR 0037, SPEC 2 and 4): the rail on the left (48 wide; the logo tile
 * goes back to the admin), the canvas with the page in its frame, and the bottom bar (48 high). The
 * chrome is always dark; the page inside the frame follows the device.
 */
/** Puts focus in the page shown in the frame. */
function focusFrame(): void {
	const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
	if (!frame) return;
	frame.focus();
	frame.contentWindow?.focus();
}

export function Shell({ config }: { config: ShellConfig }) {
	const { words } = config;
	const request = useMemo(() => editRequests(config.token), [config.token]);
	const cycle = useRef<RegionCycle | null>(null);
	const [message, setMessage] = useState({ text: "", urgent: false, count: 0 });

	const announce = useCallback((text: string, urgent = false) => {
		// Alternating a trailing space makes the same words twice in a row heard twice.
		setMessage((last) => ({ text: `${text}${last.count % 2 ? " " : ""}`, urgent, count: last.count + 1 }));
	}, []);

	useEffect(() => {
		const keys = regionCycle({ document, focusFrame });
		cycle.current = keys;
		const onKey = (event: KeyboardEvent) => {
			keys.key(event);
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			cycle.current = null;
		};
	}, []);

	return (
		<div className="grid h-dvh w-full grid-cols-[48px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_48px] overflow-hidden bg-[#121214] font-sans text-[12px] text-zinc-200">
			{/* The page itself is the main content: following the link puts focus in the frame. */}
			<a
				href="#wc-canvas"
				onClick={(event) => {
					event.preventDefault();
					focusFrame();
				}}
				className="sr-only rounded-md bg-white px-3 py-2 text-[13px] font-medium text-[#121214] focus:not-sr-only focus:fixed focus:start-14 focus:top-2 focus:z-50 focus:ring-2 focus:ring-[#818cf8] focus:ring-offset-2 focus:ring-offset-[#121214]"
			>
				{words.skipToContent}
			</a>
			<nav
				aria-label={words.rail}
				data-building-region="rail"
				className="col-start-1 row-start-1 flex flex-col items-center border-e border-white/5 outline-none focus-visible:ring-2 focus-visible:ring-[#818cf8] focus-visible:ring-inset"
			>
				<div className="flex h-11 w-12 items-center justify-center">
					<a
						href={config.returnTo}
						aria-label={words.backToAdmin}
						aria-describedby="wc-tip-back"
						className="group relative grid size-7 place-items-center rounded-md bg-white text-[13px] font-bold text-[#121214] outline-none focus-visible:ring-2 focus-visible:ring-[#818cf8] focus-visible:ring-offset-2 focus-visible:ring-offset-[#121214]"
						data-wc-logo=""
					>
						<span aria-hidden="true">W</span>
						<span
							id="wc-tip-back"
							role="tooltip"
							className="pointer-events-none absolute start-9 top-1/2 z-40 hidden -translate-y-1/2 rounded-md bg-[#1e1e22] px-2 py-1 text-[12px] font-medium whitespace-nowrap text-zinc-100 shadow-lg group-hover:block group-focus-visible:block"
						>
							{words.backToAdmin}
						</span>
					</a>
				</div>
			</nav>
			<main
				id="wc-canvas"
				aria-label={words.canvas}
				data-building-region="canvas"
				className="relative col-start-2 row-start-1 min-h-0"
			>
				<Frame page={config.page} words={words} request={request} cycle={() => cycle.current} announce={announce} />
			</main>
			<section
				aria-label={words.bar}
				data-building-region="bar"
				className="col-span-2 col-start-1 row-start-2 flex h-12 items-center border-t border-white/5 bg-[#121214] px-3 outline-none focus:ring-2 focus:ring-[#818cf8] focus:ring-inset focus-visible:ring-2 focus-visible:ring-[#818cf8] focus-visible:ring-inset"
			/>
			<div className="sr-only" data-wc-messages="">
				<p role="status" aria-live="polite" aria-atomic="true">
					{message.urgent ? "" : message.text}
				</p>
				<p role="alert" aria-live="assertive" aria-atomic="true">
					{message.urgent ? message.text : ""}
				</p>
			</div>
		</div>
	);
}

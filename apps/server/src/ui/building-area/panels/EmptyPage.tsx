import { ComponentIcon, LayoutDashboardIcon, SquareDashedBottomIcon } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";

import { shortcutText } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";
import type { FrameHandle } from "../canvas/Frame.tsx";

const BUTTON =
	"inline-flex h-10 items-center gap-2 rounded-full px-[18px] text-[14px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[#4f46e5] focus-visible:ring-offset-2 transition-[background-color,color] duration-150 motion-reduce:transition-none";

/** How much room the empty Page's outlet is given in the page, in CSS pixels, so the card covers nothing else. */
const ROOM = 340;

/**
 * An empty Page says how to start (SPEC 6, `builder/04`): "This Page is empty", Add a Component (the
 * Command menu's Insert, listing the Components), New section (D2: a new Component, placed and edited in
 * place), or ⌘I. It sits where the Page's content goes: the element holding the Site template's outlet
 * is given room in the page (a minimum height, through the CSSOM, taken back when the card goes), and the
 * card is drawn by the shell over that room, so the Site template's own parts around it (a header, a
 * Form in an aside) stay in reach. It is on a card of its own so it reads on any page, light or dark.
 */
export function EmptyPage({
	words,
	frame,
	outlet,
	onAddComponent,
	onNewSection,
}: {
	words: Words;
	frame: RefObject<FrameHandle | null>;
	/** The reference (`site#<id>`) of the Site template's element that holds the outlet. */
	outlet: string | null;
	onAddComponent(): void;
	onNewSection(): void;
}) {
	const said = words.emptyPage;
	const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
	useEffect(() => {
		const handle = frame.current;
		let element: HTMLElement | null = null;
		const place = () => {
			const page = handle?.page();
			const found = outlet
				? page?.querySelector<HTMLElement>(`[data-wc-code="${CSS.escape(outlet)}"]`)
				: (page?.querySelector<HTMLElement>("main") ?? null);
			if (found !== element) {
				element?.style.removeProperty("min-height");
				element = found ?? null;
				element?.style.setProperty("min-height", `${ROOM}px`);
			}
			const drawn = element ? handle?.overlay()?.boxOf(element) : null;
			setBox(drawn ? { left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height } : null);
		};
		place();
		const stop = handle?.overlay()?.onDraw(place);
		return () => {
			stop?.();
			element?.style.removeProperty("min-height");
		};
	}, [frame, outlet]);
	if (!box) return null;
	return (
		<div
			className="pointer-events-none fixed z-10 grid place-items-center overflow-hidden"
			style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
			data-wc-empty-page=""
		>
			<section
				aria-labelledby="wc-empty-page-title"
				className="pointer-events-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-[#e7e0d6] bg-[#fffdf9] px-8 py-6 text-center font-sans shadow-[0_12px_40px_rgba(0,0,0,0.12)]"
			>
				<span aria-hidden="true" className="grid size-14 place-items-center rounded-[14px] bg-[#f1e7da]">
					<LayoutDashboardIcon className="size-[26px] text-[#b45309]" />
				</span>
				<h2 id="wc-empty-page-title" className="m-0 text-[20px] font-semibold text-[#2a1a12]">
					{said.title}
				</h2>
				<p className="m-0 text-[14px] text-[#5b4a3f]">{said.text}</p>
				<div className="flex flex-wrap justify-center gap-2.5 pt-1">
					<button
						type="button"
						onClick={onAddComponent}
						className={`${BUTTON} bg-[#9a3412] text-white hover:bg-[#7c2d12]`}
						data-wc-empty-page-action="component"
					>
						<ComponentIcon aria-hidden="true" className="size-4" />
						{said.addComponent}
					</button>
					<button
						type="button"
						onClick={onNewSection}
						className={`${BUTTON} border-2 border-[#2a1a12] text-[#2a1a12] hover:bg-[#f1e7da]`}
						data-wc-empty-page-action="section"
					>
						<SquareDashedBottomIcon aria-hidden="true" className="size-4" />
						{said.newSection}
					</button>
				</div>
				<p className="m-0 text-[12px] text-[#6b5a4c]">{fill(said.orPress, { keys: shortcutText("menu.insert") })}</p>
			</section>
		</div>
	);
}

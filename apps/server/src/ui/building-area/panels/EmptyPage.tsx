import { ComponentIcon, LayoutDashboardIcon, SquareDashedBottomIcon } from "lucide-react";

import { shortcutText } from "../../builder/shortcuts.ts";
import { fill, type Words } from "../api.ts";

const BUTTON =
	"inline-flex h-10 items-center gap-2 rounded-full px-[18px] text-[14px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-[#4f46e5] focus-visible:ring-offset-2 transition-[background-color,color] duration-150 motion-reduce:transition-none";

/**
 * An empty Page says how to start (SPEC 6, `builder/04`): "This Page is empty", Add a Component (the
 * Command menu's Insert, listing the Components), New section (D2: a new Component, placed and edited in
 * place), or ⌘I. Drawn by the shell over the middle of the canvas, on a card of its own so it reads on
 * any page, light or dark; only its card takes the pointer.
 */
export function EmptyPage({
	words,
	onAddComponent,
	onNewSection,
}: {
	words: Words;
	onAddComponent(): void;
	onNewSection(): void;
}) {
	const said = words.emptyPage;
	return (
		<div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-6" data-wc-empty-page="">
			<section
				aria-labelledby="wc-empty-page-title"
				className="pointer-events-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-[#e7e0d6] bg-[#fffdf9] px-10 py-8 text-center font-sans shadow-[0_12px_40px_rgba(0,0,0,0.12)]"
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

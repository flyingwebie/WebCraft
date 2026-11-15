import { ArrowLeftIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, type Icon } from "../controls.tsx";

/**
 * Client editing's side panel (SPEC 13.1, `client-flows/03`): 360 wide on the right, one at a time,
 * pushing the page rather than covering it; closed by default, so the page has the whole width. Its
 * header names it and the page; the close button and Escape put it away, and focus goes back to the
 * bar's button that opened it. What each panel holds comes with its own part (Page details, Sections).
 */
export function SidePanel({
	id,
	words,
	title,
	page,
	onClose,
	children,
	kind,
	icon: Glyph,
	back,
	foot,
}: {
	id: string;
	words: Words;
	/** The panel's name ("Page details"). */
	title: string;
	/** The open page's title, under the panel's name. */
	page: string;
	onClose(): void;
	children: ReactNode;
	/** Which panel, for tests and styles. */
	kind: string;
	/** The panel's icon before its name (Sections, `client/06`). */
	icon?: Icon;
	/** A way back before its name, to the view the panel came from (the Sections picker, `client/07`). */
	back?: { label: string; onBack(): void } | null;
	/** What stays at its foot under what scrolls ("Add section"). */
	foot?: ReactNode;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	// Focus goes into the panel as it opens: its heading, so the panel is read from the top.
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, []);
	return (
		<aside
			id={id}
			aria-labelledby={`${id}-title`}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				onClose();
			}}
			className="border-chrome-line bg-chrome col-start-2 row-start-1 flex min-h-0 w-[360px] flex-col border-s"
			data-building-region="right"
			data-wc-side-panel={kind}
		>
			<header className="flex shrink-0 items-start gap-2 px-4 pt-3.5 pb-3">
				{back ? (
					<button
						type="button"
						aria-label={back.label}
						onClick={back.onBack}
						className={`bg-chrome-raised text-chrome-text hover:bg-chrome-hover hover:text-chrome-strong grid size-8 shrink-0 place-items-center rounded-lg ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-side-panel-back=""
					>
						<ArrowLeftIcon aria-hidden="true" className="size-4" />
					</button>
				) : Glyph ? (
					<Glyph aria-hidden="true" className="text-chrome-text mt-0.5 size-[18px] shrink-0" />
				) : null}
				<div className="flex min-w-0 grow flex-col">
					<h2
						ref={heading}
						id={`${id}-title`}
						tabIndex={-1}
						className="text-chrome-strong m-0 text-[15px] font-semibold outline-none"
					>
						{title}
					</h2>
					<p className="text-chrome-muted m-0 truncate text-[12px]">{page}</p>
				</div>
				<button
					type="button"
					aria-label={fill(words.client.closePanel, { panel: title })}
					onClick={onClose}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-8 shrink-0 place-items-center rounded-lg ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-side-panel-close=""
				>
					<XIcon aria-hidden="true" className="size-4" />
				</button>
			</header>
			<div className="min-h-0 grow overflow-y-auto px-4 pb-4 text-[14px]">{children}</div>
			{foot ? <div className="border-chrome-line shrink-0 border-t px-4 py-3">{foot}</div> : null}
		</aside>
	);
}

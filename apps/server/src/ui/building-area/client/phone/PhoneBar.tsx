import { EllipsisIcon, PencilIcon, Undo2Icon } from "lucide-react";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { editorHistory } from "../../../builder/editor-history.ts";
import { ariaKeys, shortcutText } from "../../../builder/shortcuts.ts";
import { fill, type Words } from "../../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../../controls.tsx";
import type { PageEditing } from "../../editing/editing.ts";
import type { ClientMode } from "../marks.ts";

/** What the shell's one Undo history offers now. */
export function useHistoryState() {
	const history = editorHistory();
	const [state, setState] = useState(() => history.state());
	useEffect(() => history.subscribe(() => setState(history.state())), [history]);
	return state;
}

/** A button of the phone's bar (`PhoneBtn`): 32 high, an icon and a word (44 for a finger, `phone.css`). */
const BUTTON = `flex h-8 min-w-8 shrink-0 items-center justify-center gap-1 rounded-[7px] px-2 text-[12px] font-medium ${CHROME_EASE} ${FOCUS_RING}`;

/**
 * The phone's one bar (SPEC 13.9, `client-flows/06`): at the bottom, 60 high, instead of the rail and
 * the 56 bar. Undo, the page's name (the list of Pages and Entries), then Edit (pressed while editing;
 * a press switches to Preview and back), More (a sheet with the rest) and Publish. While the text
 * toolbar sits on the keyboard over it, it is out of sight and out of reach.
 */
export function PhoneBar({
	words,
	switcher,
	mode,
	onMode,
	moreOpen,
	onMore,
	publish,
	onUndo,
	place,
	editing,
}: {
	words: Words;
	/** The page's name, which opens the list of Pages and Entries (`PageSwitcher`). */
	switcher: ReactNode;
	mode: ClientMode;
	onMode(mode: ClientMode): void;
	moreOpen: boolean;
	onMore(): void;
	/** Publish in the phone's size (96 × 32). */
	publish: ReactNode;
	onUndo(): void;
	/** Whether a place is open over the canvas: the page's own controls wait until it is left. */
	place: boolean;
	/** The text being edited: while its toolbar is up, it sits where the bar is. */
	editing: PageEditing;
}) {
	const hidden = useSyncExternalStore(editing.subscribe, () => {
		const now = editing.snapshot();
		return now.toolbar && now.region !== null;
	});
	const said = words.client;
	const history = useHistoryState();
	const undoLabel = history.undo ? fill(words.undoStep, { step: history.undo }) : words.undo;
	const canUndo = history.undo !== null && !history.busy;
	return (
		<section
			aria-label={words.bar}
			data-building-region="bar"
			inert={hidden || undefined}
			className={`border-chrome-line bg-chrome focus-visible:ring-chrome-focus col-span-full col-start-1 row-start-2 flex h-[60px] min-w-0 items-center gap-1.5 border-t px-2 outline-none focus-visible:ring-2 focus-visible:ring-inset ${
				hidden ? "invisible" : ""
			}`}
			data-wc-client-bar="phone"
		>
			<button
				type="button"
				aria-label={undoLabel}
				aria-keyshortcuts={ariaKeys("editor.undo") || undefined}
				aria-disabled={!canUndo || undefined}
				onClick={canUndo ? onUndo : undefined}
				className={`${BUTTON} group text-chrome-text hover:bg-chrome-hover relative aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:[&>svg]:opacity-40`}
				data-wc-bar="undo"
			>
				<Undo2Icon aria-hidden="true" className="size-3.5" />
				<Tip label={undoLabel} keys={shortcutText("editor.undo")} side="top" align="start" />
			</button>
			<div className="flex min-w-0 shrink items-center" data-wc-phone-page="">
				{switcher}
			</div>
			<span className="grow" />
			{place ? null : (
				<button
					type="button"
					aria-pressed={mode === "edit"}
					onClick={() => onMode(mode === "edit" ? "preview" : "edit")}
					className={`${BUTTON} ${mode === "edit" ? "text-chrome-strong bg-[#3f3f46]" : "text-chrome-text hover:bg-chrome-hover"}`}
					data-wc-phone-bar="edit"
				>
					<PencilIcon aria-hidden="true" className="size-3.5" />
					<span>{said.edit}</span>
				</button>
			)}
			<button
				type="button"
				aria-haspopup="dialog"
				aria-expanded={moreOpen}
				onClick={onMore}
				className={`${BUTTON} ${moreOpen ? "text-chrome-strong bg-[#3f3f46]" : "text-chrome-text hover:bg-chrome-hover"}`}
				data-wc-phone-bar="more"
			>
				<EllipsisIcon aria-hidden="true" className="size-3.5" />
				<span>{said.phone.more}</span>
			</button>
			{publish}
		</section>
	);
}

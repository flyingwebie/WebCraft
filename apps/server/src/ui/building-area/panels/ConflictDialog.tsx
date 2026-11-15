import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";

import type { Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";

const BUTTON = `inline-flex h-8 shrink-0 items-center justify-center rounded-[7px] px-2.5 text-[12px] font-semibold ${CHROME_EASE} ${FOCUS_RING}`;

/**
 * Asked when a code pane saves over a version someone else saved meanwhile (BA-11; Code mode's
 * "Reload theirs or Overwrite with mine"): Reload drops what was typed and shows theirs, Overwrite
 * saves what was typed over it, Cancel keeps typing. A modal `<dialog>` (everything under it inert),
 * focus on Reload, the safe choice; Escape cancels.
 */
export function ConflictDialog({
	words,
	text,
	onChoose,
}: {
	words: Words;
	/** What changed, in words. */
	text: string;
	onChoose(choice: "reload" | "overwrite" | "cancel"): void;
}) {
	const shown = words.code.conflict;
	const dialog = useRef<HTMLDialogElement>(null);
	const reload = useRef<HTMLButtonElement>(null);
	const title = useId();
	const body = useId();
	useEffect(() => {
		const opened = dialog.current;
		if (opened && !opened.open) opened.showModal();
		reload.current?.focus();
		return () => opened?.close();
	}, []);
	return (
		<dialog
			ref={dialog}
			role="alertdialog"
			aria-labelledby={title}
			aria-describedby={body}
			onCancel={(event) => {
				event.preventDefault();
				onChoose("cancel");
			}}
			className="bg-chrome-menu text-chrome-text border-chrome-hover m-auto w-[440px] max-w-[calc(100vw-32px)] rounded-[10px] border p-4 shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/50"
			data-wc-conflict=""
		>
			<div className="flex flex-col gap-3">
				<h2 id={title} className="text-chrome-strong m-0 flex items-center gap-2 text-[14px] font-semibold">
					<TriangleAlertIcon aria-hidden="true" className="text-chrome-warn size-[18px] shrink-0" />
					{shown.title}
				</h2>
				<p id={body} className="text-chrome-muted m-0 text-[13px]">
					{text}
				</p>
				<div className="flex items-center justify-end gap-2">
					<button
						type="button"
						onClick={() => onChoose("cancel")}
						className={`${BUTTON} text-chrome-text hover:bg-chrome-hover`}
					>
						{shown.cancel}
					</button>
					<button
						ref={reload}
						type="button"
						onClick={() => onChoose("reload")}
						className={`${BUTTON} border-chrome-hover text-chrome-text hover:bg-chrome-hover focus:ring-chrome-focus focus:ring-offset-chrome border focus:ring-2 focus:ring-offset-1`}
						data-wc-conflict-reload=""
					>
						{shown.reload}
					</button>
					<button
						type="button"
						onClick={() => onChoose("overwrite")}
						className={`${BUTTON} border border-[#b91c1c] bg-[#450a0a] text-[#fecaca] hover:bg-[#7f1d1d]`}
						data-wc-conflict-overwrite=""
					>
						{shown.overwrite}
					</button>
				</div>
			</div>
		</dialog>
	);
}

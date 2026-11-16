import { LockIcon, SparklesIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";

import { shortcutText } from "../../editor/shortcuts.ts";
import { fill, type ShellConfig } from "../api.ts";
import { FOCUS_RING } from "../controls.tsx";

/** One line of the legend: a small sample of the mark, and what it means (`LegendRow`). */
function LegendRow({ kind, children }: { kind: "edit" | "changed" | "lock"; children: ReactNode }) {
	return (
		<li className="flex items-center gap-3" data-wc-legend={kind}>
			<span aria-hidden="true" className="grid h-6 w-9 shrink-0 place-items-center">
				{kind === "lock" ? (
					<LockIcon className="text-chrome-muted size-4" />
				) : (
					<span className="relative block h-5 w-[34px] rounded-[5px] border-[1.5px] border-dashed border-[#a5b4fc]">
						{kind === "changed" ? (
							<span className="absolute -start-[5px] -top-[5px] block size-2.5 rounded-full border-2 border-[#18181b] bg-[#f59e0b]" />
						) : null}
					</span>
				)}
			</span>
			<span className="text-chrome-text grow text-[13px] leading-[18px]">{children}</span>
		</li>
	);
}

/** A key or chord, as the board draws it: a small dark pill in the code face. */
function Key({ children }: { children: ReactNode }) {
	return (
		<kbd className="text-chrome-strong inline-flex h-6 shrink-0 items-center rounded-md border border-[#3f3f46] bg-[#27272a] px-2 font-mono text-[12px] font-medium">
			{children}
		</kbd>
	);
}

/**
 * The first-visit card (SPEC 13.2 and 13.9, `client/01`): what the marks mean, and that nothing goes
 * live until Publish. It shows once per person (their editor preferences' `hintSeen`), and again from
 * Help, which adds the keys and "Ask your agency" (who looks after the Site, from Install branding).
 * A dialog over the canvas's corner that doesn't take the page away: the page stays usable around it.
 */
export function HelpCard({
	config,
	page,
	help,
	onClose,
}: {
	config: ShellConfig;
	/** The open page's title, for "You're editing a Draft of {page}". */
	page: string | null;
	/** Opened from Help: the keys and "Ask your agency" too, and focus goes into it. */
	help: boolean;
	onClose(): void;
}) {
	const { words } = config;
	const hint = words.client.hint;
	const said = words.client.helpCard;
	const titleId = useId();
	const action = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (help) action.current?.focus();
	}, [help]);

	return (
		<div
			role="dialog"
			aria-modal="false"
			aria-labelledby={titleId}
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}}
			className="bg-chrome-menu absolute end-5 bottom-5 z-30 flex max-h-[calc(100%-40px)] w-[404px] max-w-[calc(100%-40px)] flex-col gap-3 overflow-y-auto rounded-2xl border border-[#3f3f46] p-[18px] shadow-[0_20px_48px_rgba(0,0,0,0.4)]"
			data-wc-help-card={help ? "help" : "first"}
		>
			<div className="flex items-center gap-2.5">
				<span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-lg bg-[#4f46e5]">
					<SparklesIcon className="size-[15px] text-white" />
				</span>
				<h2 id={titleId} className="text-chrome-strong m-0 grow text-[15px] font-semibold">
					{page ? fill(hint.title, { page }) : hint.titleNoPage}
				</h2>
			</div>
			{help ? <h3 className="text-chrome-muted m-0 text-[12px] font-semibold">{said.marks}</h3> : null}
			<ul className="m-0 flex list-none flex-col gap-2.5 p-0">
				<LegendRow kind="edit">{hint.edit}</LegendRow>
				<LegendRow kind="changed">{hint.changed}</LegendRow>
				<LegendRow kind="lock">{hint.locked}</LegendRow>
			</ul>
			<p className="text-chrome-muted m-0 text-[13px]">{hint.note}</p>
			{help ? (
				<>
					<h3 className="text-chrome-muted m-0 mt-1 text-[12px] font-semibold">{said.keys}</h3>
					<dl className="m-0 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2" data-wc-help-keys="">
						{(
							[
								["Tab / Shift+Tab", said.keyTab],
								["Enter", said.keyEnter],
								["Esc", said.keyEscape],
								[shortcutText("editor.undo"), said.keyUndo],
								[shortcutText("editor.redo"), said.keyRedo],
							] as const
						).map(([keys, meaning]) => (
							<div key={keys} className="contents">
								<dt>
									<Key>{keys}</Key>
								</dt>
								<dd className="text-chrome-muted m-0 text-[13px]">{meaning}</dd>
							</div>
						))}
					</dl>
					<h3 className="text-chrome-muted m-0 mt-1 text-[12px] font-semibold">{said.ask}</h3>
					<div className="flex flex-col gap-1" data-wc-help-agency="">
						<p className="text-chrome-text m-0 text-[13px]">{fill(said.askText, { name: config.agency.name })}</p>
						{config.agency.note ? (
							<p className="text-chrome-muted m-0 text-[13px] whitespace-pre-line">{config.agency.note}</p>
						) : null}
					</div>
				</>
			) : null}
			<div className="flex justify-end">
				<button
					ref={action}
					type="button"
					onClick={onClose}
					className={`h-9 rounded-[9px] bg-white px-4 text-[13px] font-semibold text-[#18181b] ${FOCUS_RING}`}
					data-wc-help-close=""
				>
					{help ? said.close : hint.gotIt}
				</button>
			</div>
		</div>
	);
}

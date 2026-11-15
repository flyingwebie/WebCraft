import { ShieldIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useSyncExternalStore } from "react";

import type { ScriptFailure } from "../agent/contract.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { pageScripts } from "./scripts.ts";

/**
 * The notice over the canvas when one of the Site's own scripts failed on the page in the frame (BA-32;
 * ADR 0022), as the editing bar's was: which script failed and what it said, how many others failed
 * too, and **Open in Safe mode** (the page again with none of the Site's own scripts), unless the page
 * is in Safe mode already. Staff read the script's message and line; a Member reads client editing's
 * words, which name the script without its code, and what to do. Dismiss puts it away until the page
 * loads again. It sits before the frame in the Tab order: the page stays the last stop.
 */
export function ScriptNotice({ words, client }: { words: Words; client: boolean }) {
	const state = useSyncExternalStore(pageScripts.subscribe, pageScripts.get);
	const first = state.failures[0];
	if (!first || state.dismissed || state.safe) return null;
	const said = words.scripts;
	const what = client ? clientWhat(words, first) : staffWhat(words, first);
	const detail = client ? null : detailOf(words, first);
	const more = state.failures.length > 1 ? fill(said.more, { count: String(state.failures.length - 1) }) : null;
	return (
		<div
			role="alert"
			aria-label={said.notice}
			className="border-chrome-hover bg-chrome-menu text-chrome-text absolute top-3 z-30 flex w-[min(560px,calc(100%-48px))] items-start gap-2.5 rounded-[10px] border p-3 text-[12px] leading-[18px] shadow-[0_10px_28px_rgba(0,0,0,0.5)]"
			data-wc-script-notice={first.kind}
		>
			<TriangleAlertIcon aria-hidden="true" className="text-chrome-danger mt-px size-4 flex-none" />
			<div className="min-w-0 grow">
				<p className="m-0 break-words">
					<strong className="text-chrome-strong font-semibold">{what}</strong>
					{detail ? ` ${detail}` : ""}
					{more ? ` ${more}` : ""}
				</p>
				<p className="text-chrome-muted m-0 mt-1">{client ? said.client.help : said.safeHelp}</p>
				<div className="mt-2.5 flex items-center gap-2">
					<button
						type="button"
						onClick={() => void pageScripts.turn(true)}
						disabled={state.switching}
						aria-busy={state.switching ? true : undefined}
						className={`bg-chrome-strong inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-semibold text-[#121214] hover:bg-white disabled:opacity-60 ${CHROME_EASE} ${FOCUS_RING}`}
						data-wc-open-safe=""
					>
						<ShieldIcon aria-hidden="true" className="size-3.5" />
						{state.switching ? said.turning : said.openSafe}
					</button>
				</div>
			</div>
			<span className="group relative inline-flex flex-none">
				<button
					type="button"
					aria-label={said.dismiss}
					onClick={() => {
						pageScripts.dismiss();
						document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.focus();
					}}
					className={`text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong grid size-6 place-items-center rounded-[5px] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-dismiss-notice=""
				>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
				<Tip label={said.dismiss} side="bottom" align="end" />
			</span>
		</div>
	);
}

/** Which script failed, in Staff's words (the editing bar's). */
function staffWhat(words: Words, failure: ScriptFailure): string {
	const said = words.scripts;
	switch (failure.kind) {
		case "library":
			return fill(said.libraryFailed, { name: failure.name });
		case "component":
			return fill(said.componentFailed, { name: failure.name });
		case "page":
			return said.pageFailed;
		default:
			return said.siteFailed;
	}
}

/** Which script failed, in client editing's words. */
function clientWhat(words: Words, failure: ScriptFailure): string {
	const said = words.scripts.client;
	switch (failure.kind) {
		case "library":
			return fill(said.libraryFailed, { name: failure.name });
		case "component":
			return fill(said.componentFailed, { name: failure.name });
		case "page":
			return said.pageFailed;
		default:
			return said.siteFailed;
	}
}

/** What it said: its message and line, or that it didn't load. */
function detailOf(words: Words, failure: ScriptFailure): string {
	const said = words.scripts;
	if (failure.line === null) return said.notLoaded;
	if (failure.line > 0) return fill(said.errorAt, { message: failure.message, line: String(failure.line) });
	return failure.message;
}

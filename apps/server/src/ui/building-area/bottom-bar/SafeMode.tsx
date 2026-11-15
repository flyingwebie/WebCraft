import { ShieldIcon } from "lucide-react";
import { useId, useSyncExternalStore } from "react";

import type { Words } from "../api.ts";
import { pageScripts } from "../canvas/scripts.ts";
import { CHROME_EASE, FOCUS_RING } from "../controls.tsx";

/**
 * Safe mode on the bar (BA-32; ADR 0022): while the page in the frame runs none of the Site's own
 * scripts, the bar says so and offers **Turn off**, which shows the page again with them. Nothing is
 * drawn otherwise: Safe mode is turned on from the notice a failing script shows (`ScriptNotice.tsx`).
 * Staff's bar draws it 32 high; client editing's bar 36 high (`look="client"`).
 */
export function SafeModeControl({ words, look = "staff" }: { words: Words; look?: "staff" | "client" }) {
	const state = useSyncExternalStore(pageScripts.subscribe, pageScripts.get);
	const describedBy = useId();
	if (!state.safe) return null;
	const said = words.scripts;
	const high = look === "client" ? "h-9" : "h-8";
	return (
		<div
			className={`border-chrome-warn/40 inline-flex ${high} shrink-0 items-center gap-1.5 rounded-lg border ps-2 pe-1`}
			data-wc-safe-mode=""
		>
			<ShieldIcon aria-hidden="true" className="text-chrome-warn size-3.5 flex-none" />
			<span className="text-chrome-warn text-[12px] font-semibold whitespace-nowrap">{said.safe}</span>
			<span id={describedBy} className="sr-only">
				{look === "client" ? said.client.safeOn : said.safeOn}
			</span>
			<button
				type="button"
				aria-label={said.turnOffLabel}
				aria-describedby={describedBy}
				onClick={() => void pageScripts.turn(false)}
				disabled={state.switching}
				aria-busy={state.switching ? true : undefined}
				className={`text-chrome-strong bg-chrome-raised hover:bg-chrome-hover ${look === "client" ? "h-7" : "h-6"} rounded-md px-2 text-[12px] font-medium whitespace-nowrap disabled:opacity-60 ${CHROME_EASE} ${FOCUS_RING}`}
				data-wc-safe-off=""
			>
				{state.switching ? said.turning : said.turnOff}
			</button>
		</div>
	);
}

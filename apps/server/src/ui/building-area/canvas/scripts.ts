import type { ScriptFailure } from "../agent/contract.ts";

/**
 * The Site's own scripts in the frame, as the shell keeps them (BA-32; ADR 0022): which failed on the
 * page the frame shows (the page agent hands each over, `agent/failures.ts`), and whether that page
 * runs in **Safe mode** (none of the Site's own scripts), read from the page itself
 * (`<meta name="webcraft-safe-mode" content="on">`), so it is always what the page did.
 *
 * Kept here, in the shell's first file, beside the console (`panels/console-log.ts`): the notice
 * (`ScriptNotice.tsx`) and the bar's Safe mode control (`bottom-bar/SafeMode.tsx`) read it, the frame
 * (`Frame.tsx`) fills it and switches Safe mode (`safe/start`, `safe/stop`, then the page loads again).
 */

export type ScriptsState = {
	/** The page the frame shows (path and query): its failures, in the order they happened. */
	page: string | null;
	failures: readonly ScriptFailure[];
	/** The person put the notice away for this page. */
	dismissed: boolean;
	/** Whether the page in the frame runs in Safe mode. */
	safe: boolean;
	/** Safe mode is being switched on or off (the page loads again). */
	switching: boolean;
};

/** How many failures are kept for a page: the notice names the first and counts the rest. */
const KEPT = 50;

let state: ScriptsState = { page: null, failures: [], dismissed: false, safe: false, switching: false };
const listeners = new Set<() => void>();
let switcher: ((on: boolean) => Promise<void>) | null = null;

function set(next: Partial<ScriptsState>): void {
	state = { ...state, ...next };
	for (const listener of listeners) listener();
}

export const pageScripts = {
	get: (): ScriptsState => state,
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
	/** A page started in the frame: nothing of it has failed yet. Safe mode is what it says it is. */
	started(page: string, document: Document): void {
		set({ page, failures: [], dismissed: false, safe: isSafe(document) });
	},
	/** The page is parsed: its `<meta>` is there for certain. */
	ready(document: Document): void {
		const safe = isSafe(document);
		if (safe !== state.safe) set({ safe });
	},
	/** One of the page's own scripts failed (`AgentHost.failed`). */
	failed(failure: ScriptFailure): void {
		if (state.failures.length >= KEPT) return;
		set({ failures: [...state.failures, failure] });
	},
	/** The notice put away until the page loads again. */
	dismiss(): void {
		set({ dismissed: true });
	},
	/** Who switches Safe mode: the frame (it asks the Site, then loads the page again). Answers how to stop. */
	connect(switching: (on: boolean) => Promise<void>): () => void {
		switcher = switching;
		return () => {
			if (switcher === switching) switcher = null;
		};
	},
	/** Turns Safe mode on or off for this browser, then shows the page again. */
	async turn(on: boolean): Promise<void> {
		if (!switcher || state.switching) return;
		set({ switching: true });
		try {
			await switcher(on);
		} finally {
			set({ switching: false });
		}
	},
};

/** Whether a page in the frame says it runs in Safe mode. */
function isSafe(document: Document): boolean {
	return document.querySelector('meta[name="webcraft-safe-mode"]')?.getAttribute("content") === "on";
}

import type { ConsoleEntry } from "../agent/contract.ts";

/**
 * The page's console as the shell keeps it (BA-11): what the page agent hands over (`AgentHost.log`),
 * newest last, for the JS pane. Kept here, in the shell's first file, so lines written before the
 * code panes' own file has loaded are not lost. A new page in the frame starts with a line that says so.
 */

/** A line of the console: what the agent said, the page it came from, and its place in the list. */
export type ConsoleLine = ConsoleEntry & { id: number; page: string };

/** How many lines are kept: the oldest go first. */
const KEPT = 200;

let lines: readonly ConsoleLine[] = [];
let serial = 0;
const listeners = new Set<() => void>();

function changed(next: readonly ConsoleLine[]): void {
	lines = next.length > KEPT ? next.slice(next.length - KEPT) : next;
	for (const listener of listeners) listener();
}

export const consoleLog = {
	/** A line from the page at `page` (its path and query). */
	add(entry: ConsoleEntry, page: string): void {
		changed([...lines, { ...entry, id: ++serial, page }]);
	},
	/** Empties the console (the JS pane's Clear). */
	clear(): void {
		changed([]);
	},
	lines: (): readonly ConsoleLine[] => lines,
	subscribe(listener: () => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
};

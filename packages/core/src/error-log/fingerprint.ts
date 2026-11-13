import { createHash } from "node:crypto";

/** How many frames from the top of a stack decide the cause: deeper frames are the many ways to reach it. */
export const CAUSE_FRAMES = 3;

/**
 * A stack frame made plain, so the same place in the code reads the same on every server and build:
 * no line or column numbers, no folder above the repository's (`packages/`, `apps/`, `modules/`,
 * `node_modules/`), no `file://`, query or a bundle's hash.
 */
export function plainFrame(line: string): string {
	let frame = line.trim().replace(/^at\s+/, "");
	frame = frame.replace(/file:\/\//g, "").replace(/\?[^):\s]*/g, "");
	frame = frame.replace(/:\d+(?::\d+)?(?=\)?$)/, "");
	frame = frame.replace(/(?:[A-Za-z]:)?[^\s()]*?[/\\]((?:packages|apps|modules|node_modules)[/\\])/g, "$1");
	frame = frame.replace(/([/\\][^/\\\s()]+?)-[A-Za-z0-9_]{8,}(\.[cm]?js)/g, "$1$2");
	return frame;
}

/** A message made plain, for an error without a stack: ids, numbers and quoted values left out. */
export function plainMessage(message: string): string {
	return message
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
		.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<text>")
		.replace(/\b0x[0-9a-f]+\b|\b\d+(?:\.\d+)?\b/gi, "<n>")
		.slice(0, 300);
}

/** The top frames of an error's stack, made plain. */
export function topFrames(stack: string | undefined): string[] {
	return (stack ?? "")
		.split("\n")
		.filter((line) => line.trim().startsWith("at "))
		.slice(0, CAUSE_FRAMES)
		.map(plainFrame);
}

/**
 * What makes two failures one cause in the Error log: the error's kind and the top frames of its
 * stack, made plain (its message, made plain, when it has no stack). Messages differ by the values in
 * them (an id, an address), so they don't decide it.
 */
export function fingerprintOf(error: Error): string {
	const frames = topFrames(error.stack);
	const parts = [error.name, ...(frames.length > 0 ? frames : [plainMessage(error.message)])];
	return createHash("sha256").update(parts.join("\n")).digest("hex");
}

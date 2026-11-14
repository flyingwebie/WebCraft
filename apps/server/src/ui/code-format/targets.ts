import type { CodeLanguage } from "./format.ts";

/**
 * The code boxes on screen that the Command menu's "Format HTML", "Format CSS", "Format JS" and
 * "Format all three" reach, by language: each box that can be edited registers while it is there,
 * and the one registered last answers (the box most recently shown).
 */
const targets = new Map<CodeLanguage, (() => Promise<void>)[]>();

/** Registers a box's Format for its language; answers how to take it back. */
export function registerFormatTarget(language: CodeLanguage, run: () => Promise<void>): () => void {
	const list = targets.get(language) ?? [];
	list.push(run);
	targets.set(language, list);
	return () => {
		const now = targets.get(language) ?? [];
		const index = now.lastIndexOf(run);
		if (index >= 0) now.splice(index, 1);
	};
}

/** The box Format reaches for a language now, if one is on screen. */
export function formatTarget(language: CodeLanguage): (() => Promise<void>) | undefined {
	return targets.get(language)?.at(-1);
}

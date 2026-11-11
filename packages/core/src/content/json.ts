import { contentHash, stableJson } from "@webcraft/renderer";

export { stableJson } from "@webcraft/renderer";

/** Whether two JSON values are equal, whatever the order of their keys. */
export function sameJson(a: unknown, b: unknown): boolean {
	return stableJson(a) === stableJson(b);
}

/**
 * A Draft's version: 16 hexadecimal digits of the SHA-256 of its JSON, whatever the order of its
 * keys. A save names the version it was based on, so it never overwrites a Draft someone changed since.
 */
export function draftVersion(draft: unknown): string {
	return contentHash(stableJson(draft));
}

/**
 * How a save checks what it is based on: the version of the Draft it was made from (`draftVersion`),
 * or null when it was made while there was none. A Draft whose version is another one by then was
 * saved by someone else meanwhile: the save is refused (`DraftChangedError`). Left out, a save
 * replaces whatever is there.
 */
export type SaveBase = { basedOn?: string | null };

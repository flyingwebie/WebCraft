import { contentHash } from "@webcraft/renderer";

/** Whether two JSON values are equal, whatever the order of their keys. */
export function sameJson(a: unknown, b: unknown): boolean {
	return stableJson(a) === stableJson(b);
}

/** JSON with every object's keys in order, so equal values give equal text. */
export function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
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

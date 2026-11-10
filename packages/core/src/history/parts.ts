import { sameJson } from "../content/json.ts";
import { storedVersion } from "../content/values.ts";
import type { HistoryItem } from "./items.ts";

/**
 * An item's parts, as history tells what changed: for an Entry, the Globals and the Consent banner's
 * words, each stored value by key (`title`, `slug`, `seo`, a Field's key) in each language it is kept
 * in (ADR 0003); for a Form's emails and Structure, each section of the version (a Component's `props`
 * and `tree`, the Design system's `tokens`, …), kept once for every language. A Template is one part,
 * its `tree`; a script one, its `code`.
 */

/** One part of an item in one language (null: a part kept once for every language). */
export type PartPlace = { part: string; language: string | null };

/** The kinds whose versions keep values by key and language (`{ values }`, ADR 0003). */
export const VALUE_KINDS: readonly HistoryItem["kind"][] = ["entry", "globals", "consentBanner", "popupContent"];

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Whether a stored node is a Repeater's (`{ rows }`). */
function isRows(node: Record<string, unknown>): boolean {
	return Array.isArray(node.rows);
}

/** Whether a stored node is a Group's (`{ values }`); a leaf keeps languages as keys, never `values`. */
function isGroup(node: Record<string, unknown>): boolean {
	return record(node.values) !== null && !isRows(node);
}

/** Every language a stored value (a leaf, a Group, a Repeater) keeps a value in. */
export function languagesIn(node: unknown): Set<string> {
	const found = new Set<string>();
	const walk = (value: unknown) => {
		const own = record(value);
		if (!own) return;
		if (isRows(own)) {
			for (const row of own.rows as unknown[])
				for (const child of Object.values(record(record(row)?.values) ?? {})) walk(child);
		} else if (isGroup(own)) {
			for (const child of Object.values(record(own.values) ?? {})) walk(child);
		} else {
			for (const language of Object.keys(own)) found.add(language);
		}
	};
	walk(node);
	return found;
}

/**
 * A stored value as it is kept in one language, without falling back to another: a leaf's own value
 * (what a Body's Blocks translate, `source`, left out: it says where a translation came from, not
 * what it says), a Group's values by key, a Repeater's rows. Undefined when the leaf has none there.
 */
export function inLanguage(node: unknown, language: string): unknown {
	const own = record(node);
	if (!own) return undefined;
	if (isRows(own)) {
		return (own.rows as unknown[]).map((row) => {
			const values = record(record(row)?.values) ?? {};
			return {
				id: record(row)?.id,
				values: Object.fromEntries(Object.entries(values).map(([key, child]) => [key, inLanguage(child, language)])),
			};
		});
	}
	if (isGroup(own)) {
		const values = record(own.values) ?? {};
		return Object.fromEntries(Object.entries(values).map(([key, child]) => [key, inLanguage(child, language)]));
	}
	const value = record(own[language])?.value;
	if (Array.isArray(value)) {
		// A Body's Blocks: what each says, without where its translation came from.
		return value.map((block) => {
			const own = record(block);
			if (!own || !("source" in own)) return block;
			const { source: _, ...rest } = own;
			return rest;
		});
	}
	return value;
}

/** The sections of a Structure item's version (or of a Form's emails), each one part. */
export function sectionsOf(kind: HistoryItem["kind"], version: unknown): Map<string, unknown> {
	if (kind === "template") return new Map([["tree", version ?? null]]);
	if (kind === "script") return new Map([["code", typeof version === "string" ? version : ""]]);
	return new Map(Object.entries(record(version) ?? {}));
}

/** The keys a value kind's version keeps values under. */
function valueKeys(...versions: unknown[]): string[] {
	return [...new Set(versions.flatMap((version) => Object.keys(storedVersion(version).values)))];
}

/** The parts that differ between two versions of an item, in each language they differ in. */
export function changedParts(kind: HistoryItem["kind"], before: unknown, after: unknown): PartPlace[] {
	if (VALUE_KINDS.includes(kind)) {
		const was = storedVersion(before).values;
		const now = storedVersion(after).values;
		const changed: PartPlace[] = [];
		for (const key of valueKeys(before, after)) {
			if (sameJson(was[key] ?? null, now[key] ?? null)) continue;
			const languages = new Set([...languagesIn(was[key]), ...languagesIn(now[key])]);
			for (const language of languages) {
				if (!sameJson(inLanguage(was[key], language) ?? null, inLanguage(now[key], language) ?? null)) {
					changed.push({ part: key, language });
				}
			}
		}
		return changed;
	}
	const was = sectionsOf(kind, before);
	const now = sectionsOf(kind, after);
	return [...new Set([...was.keys(), ...now.keys()])]
		.filter((key) => !sameJson(was.get(key) ?? null, now.get(key) ?? null))
		.map((part) => ({ part, language: null }));
}

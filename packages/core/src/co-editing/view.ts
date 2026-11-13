import { layoutView, type PageLayout } from "../content/page-layouts.ts";
import type { HistoryItem } from "../history/items.ts";
import { VALUE_KINDS } from "../history/parts.ts";
import type { Json } from "./document.ts";

/**
 * What a Draft's shared document holds once a change to it is saved: the Draft as the save stored it
 * (`documentView`), whatever the kind of item. An editor's socket takes any change, so the document
 * must never keep what the save cleaned away or left out: rich text arrives at the other editors, at
 * the ones who open it later and at the other web processes as the Draft's row holds it.
 *
 * One thing stays as it was typed, in values kept by key and language: whitespace at the ends of a
 * text. The save trims it, and taking it out of the document would delete the space someone typed a
 * moment ago, between two words.
 */
export function savedView(kind: HistoryItem["kind"], typed: Json, stored: unknown): Json {
	const view = documentView(kind, stored);
	return VALUE_KINDS.includes(kind) ? keepingTypedSpace(typed, view) : view;
}

/** `stored`, with each text that is `typed`'s trimmed kept as typed. */
function keepingTypedSpace(typed: Json | undefined, stored: Json): Json {
	if (typeof stored === "string") return typeof typed === "string" && typed.trim() === stored ? typed : stored;
	if (Array.isArray(stored)) {
		const list = Array.isArray(typed) ? typed : [];
		return stored.map((item, index) => keepingTypedSpace(list[index], item));
	}
	const from = record(typed);
	const own = record(stored);
	if (!own) return stored;
	return Object.fromEntries(
		Object.entries(own).map(([key, value]) => [key, keepingTypedSpace(from?.[key] as Json | undefined, value as Json)]),
	);
}

/**
 * What a Draft's shared document holds: the Draft as its table stores it, less what only the server
 * writes. Values kept by key and language (an Entry's, the Globals') keep each value without who
 * wrote it (`by`) or what it translates (`source`, also on a Body's Blocks): the server works those
 * out as it saves each change, as the person who made it, so nobody can write them in someone else's
 * name. Everything else (Structure: trees, Props, code) is held as it is stored.
 */
export function documentView(kind: HistoryItem["kind"], stored: unknown): Json {
	if (!VALUE_KINDS.includes(kind)) return (stored ?? null) as Json;
	const values = record(record(stored)?.values) ?? {};
	return {
		...(kind === "entry" && record(stored)?.layout ? { layout: layoutView(record(stored)?.layout as PageLayout) } : {}),
		values: Object.fromEntries(Object.entries(values).map(([key, node]) => [key, nodeView(node)])),
	};
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A stored value (a leaf kept by language, a Group, a Repeater) as the document holds it. */
export function nodeView(node: unknown): Json {
	const own = record(node);
	if (!own) return (node ?? null) as Json;
	if (Array.isArray(own.rows)) {
		return {
			rows: own.rows.flatMap((row) => {
				const { id, values } = record(row) ?? {};
				if (typeof id !== "string") return [];
				const fields = record(values) ?? {};
				return [
					{ id, values: Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, nodeView(child)])) },
				];
			}),
		};
	}
	if (record(own.values)) {
		const fields = record(own.values) ?? {};
		return { values: Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, nodeView(child)])) };
	}
	// A leaf: its value in each language it has one in.
	const view: Record<string, Json> = {};
	for (const [language, kept] of Object.entries(own)) {
		const value = record(kept)?.value;
		if (value === undefined) continue;
		view[language] = withoutSources(value) as Json;
	}
	return view;
}

/** A Body's Blocks without what each translates: the save works that out again. */
function withoutSources(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((block) => {
		const own = record(block);
		if (!own || !("source" in own)) return block;
		const { source: _, ...rest } = own;
		return rest;
	});
}

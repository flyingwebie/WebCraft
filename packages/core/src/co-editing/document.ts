import * as Y from "yjs";

/**
 * A Draft's shared document (ADR 0025): a Yjs document holding the Draft as JSON, which merges
 * everyone's changes. The server and the admin's editors share this file, so it imports nothing but
 * Yjs (`@webcraft/core/draft-document` in the browser).
 *
 * The Draft lives under one key of the document's root map. Objects are maps, lists are arrays and
 * text is Yjs text, so two people typing in the same value merge character by character, and two
 * people changing different values, rows or Blocks never touch each other's work.
 *
 * Every change is made the same way: `changeDocument` takes the JSON the Draft should become and
 * makes the smallest change that gets it there. The server does that for a change made through the
 * API (only the parts that change are touched), an editor does it for what its person typed.
 */

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The root map's key holding the Draft. */
const DRAFT = "draft";

/** The shared type a Draft lives in. */
function root(doc: Y.Doc): Y.Map<unknown> {
	return doc.getMap("document");
}

/** A Draft as JSON, as the document holds it now (null while it holds none). */
export function readDocument(doc: Y.Doc): Json {
	return toJson(root(doc).get(DRAFT));
}

/**
 * Changes the document so it holds `next`, making the smallest change: map keys that differ, list
 * items by their `id` (or their place, for lists without ids), text by the characters that differ.
 * Done in one Yjs transaction with `origin`, which update handlers see.
 */
export function changeDocument(doc: Y.Doc, next: Json, origin: unknown = null): void {
	doc.transact(() => {
		const map = root(doc);
		const current = map.get(DRAFT);
		const changed = syncValue(current, next);
		if (changed !== current) map.set(DRAFT, changed);
	}, origin);
}

/** A copy of a document, to try a change on without touching it. */
export function copyDocument(doc: Y.Doc): Y.Doc {
	const copy = new Y.Doc({ gc: false });
	Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
	return copy;
}

/** A new document made from a Draft, as the first one for an item is. */
export function documentFrom(draft: Json): Y.Doc {
	const doc = new Y.Doc({ gc: false });
	changeDocument(doc, draft);
	return doc;
}

function toJson(value: unknown): Json {
	if (value instanceof Y.Map || value instanceof Y.Array || value instanceof Y.Text) return value.toJSON() as Json;
	return value === undefined ? null : (value as Json);
}

/** Whether two JSON values are equal, whatever the order of object keys. */
export function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
	}
	if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(b)) {
		const keys = Object.keys(a);
		if (keys.length !== Object.keys(b).length) return false;
		return keys.every(
			(key) =>
				Object.hasOwn(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
		);
	}
	return false;
}

function isObject(value: unknown): value is { [key: string]: Json } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A shared value made from JSON, not yet in a document. */
function fresh(value: Json): unknown {
	if (typeof value === "string") return new Y.Text(value);
	if (Array.isArray(value)) {
		const array = new Y.Array<unknown>();
		array.push(value.map(fresh));
		return array;
	}
	if (isObject(value)) {
		const map = new Y.Map<unknown>();
		for (const [key, child] of Object.entries(value)) map.set(key, fresh(child));
		return map;
	}
	return value;
}

/**
 * Brings `current` (a shared value in a document) to `next`, changing it in place where it can: the
 * same shared value then, else a new one to put in its place.
 */
function syncValue(current: unknown, next: Json): unknown {
	if (typeof next === "string" && current instanceof Y.Text) {
		syncText(current, next);
		return current;
	}
	if (Array.isArray(next) && current instanceof Y.Array) {
		syncArray(current, next);
		return current;
	}
	if (isObject(next) && current instanceof Y.Map) {
		syncMap(current, next);
		return current;
	}
	if (!(current instanceof Y.AbstractType) && current === next) return current;
	return fresh(next);
}

function syncMap(map: Y.Map<unknown>, next: { [key: string]: Json }): void {
	for (const key of [...map.keys()]) if (!Object.hasOwn(next, key)) map.delete(key);
	for (const [key, value] of Object.entries(next)) {
		const current = map.get(key);
		if (!map.has(key)) {
			map.set(key, fresh(value));
			continue;
		}
		const changed = syncValue(current, value);
		if (changed !== current) map.set(key, changed);
	}
}

/** The id a list item is known by (rows, Blocks and tree nodes have one), or null. */
function idOf(value: unknown): string | null {
	if (value instanceof Y.Map) {
		const id = value.get("id");
		if (id instanceof Y.Text) return id.toString();
		return typeof id === "string" ? id : null;
	}
	if (isObject(value)) return typeof value.id === "string" ? value.id : null;
	return null;
}

function syncArray(array: Y.Array<unknown>, next: Json[]): void {
	const current = array.toArray();
	const keyed =
		next.length > 0 &&
		next.every((item) => idOf(item) !== null) &&
		new Set(next.map(idOf)).size === next.length &&
		current.every((item) => idOf(item) !== null);
	if (keyed) syncKeyedArray(array, next);
	else syncPlainArray(array, next);
}

/** A list whose items have ids: items keep their place in the document while their id stays. */
function syncKeyedArray(array: Y.Array<unknown>, next: Json[]): void {
	const wanted = new Set(next.map(idOf));
	// Items no longer there go first, from the end so the places of the rest hold.
	const current = array.toArray();
	for (let index = current.length - 1; index >= 0; index--) {
		if (!wanted.has(idOf(current[index]))) array.delete(index, 1);
	}
	next.forEach((value, index) => {
		const items = array.toArray();
		const here = items[index];
		if (here !== undefined && idOf(here) === idOf(value)) {
			const changed = syncValue(here, value);
			if (changed !== here) {
				array.delete(index, 1);
				array.insert(index, [changed]);
			}
			return;
		}
		// Moved here from further on: a move is taken out and put in again.
		const from = items.findIndex((item, at) => at > index && idOf(item) === idOf(value));
		if (from >= 0) array.delete(from, 1);
		array.insert(index, [fresh(value)]);
	});
}

/** A list without ids: what is the same at the start and the end stays, items in between change in place when they can. */
function syncPlainArray(array: Y.Array<unknown>, next: Json[]): void {
	const current = array.toArray();
	const same = (item: unknown, value: Json) => sameValue(toJson(item), value);
	let start = 0;
	while (start < current.length && start < next.length && same(current[start], next[start] as Json)) start++;
	let end = 0;
	while (
		end < current.length - start &&
		end < next.length - start &&
		same(current[current.length - 1 - end], next[next.length - 1 - end] as Json)
	) {
		end++;
	}
	const removed = current.length - start - end;
	const added = next.slice(start, next.length - end);
	if (removed === added.length) {
		// The same number of items: each changes in place, so a change inside one stays small.
		added.forEach((value, offset) => {
			const here = current[start + offset];
			const changed = syncValue(here, value);
			if (changed !== here) {
				array.delete(start + offset, 1);
				array.insert(start + offset, [changed]);
			}
		});
		return;
	}
	if (removed > 0) array.delete(start, removed);
	if (added.length > 0) array.insert(start, added.map(fresh));
}

/** Changes text by the characters that differ: what is the same at the start and the end stays. */
function syncText(text: Y.Text, next: string): void {
	const current = text.toString();
	if (current === next) return;
	let start = 0;
	const shortest = Math.min(current.length, next.length);
	while (start < shortest && current.charCodeAt(start) === next.charCodeAt(start)) start++;
	// Never split a character made of two UTF-16 units.
	if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
	let end = 0;
	while (
		end < shortest - start &&
		current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)
	) {
		end++;
	}
	if (end > 0 && isLowSurrogate(current.charCodeAt(current.length - end))) end--;
	const removed = current.length - start - end;
	if (removed > 0) text.delete(start, removed);
	const inserted = next.slice(start, next.length - end);
	if (inserted.length > 0) text.insert(start, inserted);
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * What a Draft becomes when a change made elsewhere (`before` to `after`) is brought into what the
 * document holds now (`current`): every value the change touched takes its new value, everything
 * else keeps what the document holds, so a change through the API never undoes what someone typed
 * in another value meanwhile. Objects merge key by key; anything else the change touched is
 * replaced as a whole (the document then changes it by the smallest steps it can).
 */
export function mergeChange(before: Json, after: Json, current: Json): Json {
	if (sameValue(before, after)) return current;
	if (isObject(before) && isObject(after) && isObject(current)) {
		const merged: { [key: string]: Json } = { ...current };
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			const was = Object.hasOwn(before, key) ? (before[key] as Json) : undefined;
			const now = Object.hasOwn(after, key) ? (after[key] as Json) : undefined;
			if (was !== undefined && now !== undefined && sameValue(was, now)) continue;
			if (now === undefined) {
				delete merged[key];
				continue;
			}
			const here = Object.hasOwn(current, key) ? (current[key] as Json) : undefined;
			merged[key] = was === undefined || here === undefined ? now : mergeChange(was, now, here);
		}
		return merged;
	}
	return after;
}

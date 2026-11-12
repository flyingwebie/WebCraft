import { type Json, sameValue } from "./document.ts";

/** A step is obsolete when applying its inverse would replace a later edit. */
export class HistoryObsolete extends Error {
	readonly code = "HISTORY_OBSOLETE";
	constructor() {
		super("HISTORY_OBSOLETE");
	}
}
const object = (value: unknown): value is Record<string, Json> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const key = (value: Json): string | null => (object(value) && typeof value.id === "string" ? value.id : null);

/**
 * Rebase one person's finished change onto today's Draft. Unlike restoring a snapshot this only
 * touches values the step changed. Overlapping edits are refused, never silently overwritten.
 * Stable list identities retain peer edits and additions; text edits at disjoint spans commute.
 * The caller still uses the ordinary version/permission/validation boundary to save the result.
 */
export function reverseChange(from: Json, to: Json, current: Json): Json {
	// A reparent is a move of a stable identity, not a deletion plus a new snapshot. Carry the
	// live subtree to its previous parent so another person's edits inside it survive.
	const index = (root: Json) => {
		const items = new Map<string, { value: Json; parent: string }>();
		const visit = (value: Json, path: string) => {
			if (Array.isArray(value)) {
				for (const child of value) {
					const id = key(child);
					if (id !== null) items.set(id, { value: child, parent: path });
					visit(child, `${path}/${id ?? "[]"}`);
				}
			} else if (object(value)) {
				for (const [name, child] of Object.entries(value)) visit(child, `${path}/${name}`);
			}
		};
		visit(root, "");
		return items;
	};
	const oldItems = index(from);
	const newItems = index(to);
	const liveItems = index(current);
	const moved = new Map<string, { from: Json; to: Json; current: Json }>();
	for (const [id, old] of oldItems) {
		const next = newItems.get(id);
		if (!next || old.parent === next.parent) continue;
		const live = liveItems.get(id);
		if (!live || live.parent !== old.parent) throw new HistoryObsolete();
		moved.set(id, { from: old.value, to: next.value, current: live.value });
	}
	return reverse(from, to, current, moved);
}

function reverse(
	from: Json,
	to: Json,
	current: Json,
	moved: Map<string, { from: Json; to: Json; current: Json }>,
): Json {
	if (sameValue(from, to)) return current;
	if (sameValue(from, current) && (!moved.size || typeof from !== "object")) return to;
	if (typeof from === "string" && typeof to === "string" && typeof current === "string") {
		const own = span(from, to);
		const peer = span(from, current);
		// Changes on either side of our span commute. Insertion at the same position is ambiguous.
		if (peer.end <= own.start && peer.start < own.start) {
			const shift = peer.text.length - (peer.end - peer.start);
			return current.slice(0, own.start + shift) + own.text + current.slice(own.end + shift);
		}
		if (peer.start >= own.end && peer.end > own.end) {
			return current.slice(0, own.start) + own.text + current.slice(own.end);
		}
		throw new HistoryObsolete();
	}
	if (object(from) && object(to) && object(current)) {
		const next = { ...current };
		for (const name of new Set([...Object.keys(from), ...Object.keys(to)])) {
			if (sameValue(from[name], to[name])) continue;
			if (!(name in from)) {
				if (name in current) throw new HistoryObsolete();
				next[name] = to[name] as Json;
			} else if (!(name in to)) {
				if (!sameValue(from[name], current[name])) throw new HistoryObsolete();
				delete next[name];
			} else {
				if (!(name in current)) throw new HistoryObsolete();
				next[name] = reverse(from[name] as Json, to[name] as Json, current[name] as Json, moved);
			}
		}
		return next;
	}
	if (Array.isArray(from) && Array.isArray(to) && Array.isArray(current)) {
		if ([...from, ...to, ...current].every((v) => key(v) !== null)) {
			const next = [...current];
			const oldKeys = from.map(key);
			const newKeys = to.map(key);
			for (const value of from) {
				const id = key(value);
				const at = next.findIndex((v) => key(v) === id);
				const wanted = to.find((v) => key(v) === id);
				if (!wanted) {
					if (at < 0 || (!moved.has(id as string) && !sameValue(next[at], value))) throw new HistoryObsolete();
					next.splice(at, 1);
				} else if (!sameValue(value, wanted)) {
					if (at < 0) throw new HistoryObsolete();
					next[at] = reverse(value, wanted, next[at] as Json, moved);
				}
			}
			// Only move a retained item when its relative position among retained items changed.
			const retained = oldKeys.filter((id) => newKeys.includes(id));
			const wantedOrder = newKeys.filter((id) => oldKeys.includes(id));
			const liveOrder = next.map(key).filter((id) => retained.includes(id));
			if (!sameValue(retained, wantedOrder) && !sameValue(retained, liveOrder)) throw new HistoryObsolete();
			for (let i = 0; i < to.length; i++) {
				const value = to[i] as Json;
				const id = key(value);
				const at = next.findIndex((v) => key(v) === id);
				if (!oldKeys.includes(id) && at >= 0) throw new HistoryObsolete();
				if (oldKeys.includes(id) && sameValue(retained, wantedOrder)) continue;
				if (oldKeys.includes(id) && at < 0) throw new HistoryObsolete();
				const transfer = moved.get(id as string);
				const item =
					at < 0
						? transfer
							? reverse(transfer.from, transfer.to, transfer.current, moved)
							: value
						: (next.splice(at, 1)[0] as Json);
				const previous = i ? key(to[i - 1] as Json) : null;
				const insert = previous === null ? 0 : next.findIndex((v) => key(v) === previous) + 1;
				next.splice(insert, 0, item);
			}
			return next;
		}
		if (from.length === to.length && current.length === from.length) {
			return from.map((value, i) => reverse(value, to[i] as Json, current[i] as Json, moved));
		}
	}
	throw new HistoryObsolete();
}

function span(from: string, to: string) {
	let start = 0;
	while (start < from.length && start < to.length && from[start] === to[start]) start++;
	let tail = 0;
	while (
		tail < from.length - start &&
		tail < to.length - start &&
		from[from.length - tail - 1] === to[to.length - tail - 1]
	)
		tail++;
	return { start, end: from.length - tail, text: to.slice(start, to.length - tail) };
}

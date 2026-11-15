import { useEffect, useRef } from "react";

import { pathOfFilter } from "../builder/tree.ts";
import { keyIn, type Structure, type StructureSnapshot } from "./editing/selection.ts";

/**
 * Opening a Template or Component with a Filter selected (BA-34; the admin's Filters screen, an
 * address with `wc-filter`): once the page's sources are open, the element placing that Filter (its
 * form before any of its controls placed on their own, as the visual builder chose) is selected, as a
 * click on it would. The selection then takes the Filter's place in the address.
 */

/** The reference of the element placing `filterId` among the page's open sources, if one does. */
export function filterRef(snapshot: StructureSnapshot, filterId: string): string | null {
	for (const source of snapshot.sources.values()) {
		const path = pathOfFilter(source.tree, filterId);
		if (!path) continue;
		const key = keyIn(source.tree, { kind: "node", path });
		if (key) return `${source.ref}#${key}`;
	}
	return null;
}

/**
 * Selects the element placing `filterId` (the address's `wc-filter`) as soon as the page shows it, once
 * per address: Staff only (`structure` null otherwise).
 */
export function useFilterSelection(structure: Structure | null, filterId: string | null, page: string | null): void {
	const done = useRef<string | null>(null);
	useEffect(() => {
		if (!structure || !filterId || !page) return;
		const key = `${page}|${filterId}`;
		const look = () => {
			if (done.current === key) return;
			const ref = filterRef(structure.snapshot(), filterId);
			if (!ref) return;
			done.current = key;
			// Not while the Structure is still telling its listeners about the change that opened the source.
			queueMicrotask(() => structure.select(ref));
		};
		look();
		return structure.subscribe(look);
	}, [structure, filterId, page]);
}

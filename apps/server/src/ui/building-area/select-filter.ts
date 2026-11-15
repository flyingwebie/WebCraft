import { useEffect, useRef } from "react";

import { nodeAt, pathOfFilter, pathOfId } from "../editor/tree.ts";
import { keyIn, type Structure, type StructureSnapshot } from "./editing/selection.ts";

/**
 * Opening a Template or Component with a Filter selected (BA-34; the admin's Filters screen, an
 * address with `wc-filter`): once the page's sources are open, the element placing that Filter (its
 * whole form before any of its controls placed on their own, as the visual builder chose) is
 * selected, as a click on it would. The selection then takes the Filter's place in the address. An
 * element named by its id (`wc-element`, the admin's Checks, BA-28) is selected the same way.
 */

/**
 * Where `filterId` is placed among the page's open sources: the reference of the element placing its
 * whole form (`form`), in whichever source, else of one of its controls placed on its own (`apart`,
 * such as a search box in the Site template's header).
 */
export function filterRefs(
	snapshot: StructureSnapshot,
	filterId: string,
): { form: string | null; apart: string | null } {
	let apart: string | null = null;
	for (const source of snapshot.sources.values()) {
		const path = pathOfFilter(source.tree, filterId);
		if (!path) continue;
		const key = keyIn(source.tree, { kind: "node", path });
		if (!key) continue;
		const node = nodeAt(source.tree, path);
		if (node?.type === "filter" && node.control === undefined) return { form: `${source.ref}#${key}`, apart };
		apart ??= `${source.ref}#${key}`;
	}
	return { form: null, apart };
}

/** How long a control placed on its own waits for a source still opening to hold the whole Filter. */
const APART_WAIT_MS = 1200;

/**
 * Selects the element placing `filterId` (the address's `wc-filter`) as soon as the page shows it, once
 * per address: Staff only (`structure` null otherwise).
 */
export function useFilterSelection(structure: Structure | null, filterId: string | null, page: string | null): void {
	const done = useRef<string | null>(null);
	useEffect(() => {
		if (!structure || !filterId || !page) return;
		const key = `${page}|${filterId}`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const choose = (ref: string) => {
			clearTimeout(timer);
			done.current = key;
			// Not while the Structure is still telling its listeners about the change that opened the source.
			queueMicrotask(() => structure.select(ref));
		};
		const look = () => {
			if (done.current === key) return;
			const { form, apart } = filterRefs(structure.snapshot(), filterId);
			if (form) choose(form);
			else if (apart) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					if (done.current !== key) choose(apart);
				}, APART_WAIT_MS);
			}
		};
		look();
		const stop = structure.subscribe(look);
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [structure, filterId, page]);
}

/**
 * Where the element `elementId` is among the page's open sources: the reference of the first source
 * holding it, the Site template's (`site`) only when no other does, since the document's own markup
 * comes first (the admin's Checks name an element of the Template or Component a finding is about).
 */
export function elementRef(
	snapshot: StructureSnapshot,
	elementId: string,
	siteFirst: boolean,
): { own: string | null; site: string | null } {
	let own: string | null = null;
	let site: string | null = null;
	for (const source of snapshot.sources.values()) {
		if (!pathOfId(source.tree, elementId)) continue;
		const ref = `${source.ref}#${elementId}`;
		if (source.ref === "site") site ??= ref;
		else own ??= ref;
	}
	return siteFirst ? { own: site, site: own } : { own, site };
}

/**
 * Selects the element the address names by its id (`wc-element`, BA-28) as soon as the page shows it,
 * once per address: in the document's own Template or Component first, the Site template's after a
 * moment when only it has one (Staff only: `structure` null otherwise).
 */
export function useElementSelection(
	structure: Structure | null,
	elementId: string | null,
	page: string | null,
	siteFirst: boolean,
): void {
	const done = useRef<string | null>(null);
	useEffect(() => {
		if (!structure || !elementId || !page) return;
		const key = `${page}|${elementId}`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const choose = (ref: string) => {
			clearTimeout(timer);
			done.current = key;
			queueMicrotask(() => structure.select(ref));
		};
		const look = () => {
			if (done.current === key) return;
			const { own, site } = elementRef(structure.snapshot(), elementId, siteFirst);
			if (own) choose(own);
			else if (site) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					if (done.current !== key) choose(site);
				}, APART_WAIT_MS);
			}
		};
		look();
		const stop = structure.subscribe(look);
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [structure, elementId, page, siteFirst]);
}

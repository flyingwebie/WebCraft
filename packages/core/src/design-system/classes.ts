/**
 * Classes (ADR 0009): named sets of styles elements reference by id. So far WebCraft only makes
 * generated Classes, from inline styles in Template markup: the same declarations always give the
 * same Class (`style-` and a hash of them), so saving markup twice never makes two. The Design
 * system's own Classes, renaming, the stylesheet and publishing build on this.
 */
import { classes } from "@webcraft/db/schema";

import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";

/** A Class of a Site. */
export type SiteClass = { id: string; name: string; styles: string; generated: boolean };

/** The Classes of the scope's Site. */
export async function listClasses(scope: Pick<SiteScope | VisitorScope, "select">): Promise<SiteClass[]> {
	const rows = await scope.select(classes);
	return rows.map((row) => ({ id: row.id, name: row.name, styles: row.styles, generated: row.generated }));
}

/**
 * The Site's Classes while Template markup is read and printed: names to ids and back, and the
 * generated Class for an inline style, made when the Site has none yet (`created` lists those, for
 * `saveCreatedClasses`).
 */
export type ClassCatalogue = {
	named(name: string): string | undefined;
	nameOf(classId: string): string | undefined;
	/** The ids of every Class, including ones made here. */
	ids: ReadonlySet<string>;
	forStyle(declarations: string): { id: string; name: string };
	created: readonly SiteClass[];
};

export function classCatalogue(existing: readonly SiteClass[]): ClassCatalogue {
	const all = [...existing];
	const created: SiteClass[] = [];
	const ids = new Set(all.map((siteClass) => siteClass.id));
	return {
		named: (name) => all.find((siteClass) => siteClass.name === name)?.id,
		nameOf: (classId) => all.find((siteClass) => siteClass.id === classId)?.name,
		ids,
		created,
		forStyle(declarations) {
			const same = all.find((siteClass) => siteClass.generated && siteClass.styles === declarations);
			if (same) return { id: same.id, name: same.name };
			const stem = `style-${hash(declarations)}`;
			let name = stem;
			for (let attempt = 2; all.some((siteClass) => siteClass.name === name); attempt++) name = `${stem}-${attempt}`;
			const made: SiteClass = { id: crypto.randomUUID(), name, styles: declarations, generated: true };
			all.push(made);
			created.push(made);
			ids.add(made.id);
			return { id: made.id, name };
		},
	};
}

/** Stores the Classes a catalogue made. */
export async function saveCreatedClasses(scope: SiteScope, catalogue: ClassCatalogue): Promise<void> {
	const now = scope.now();
	for (const made of catalogue.created) {
		await scope.insert(classes, { ...made, createdAt: now, updatedAt: now });
	}
}

/** 8 hexadecimal digits from the text (FNV-1a): short, stable names for generated Classes. */
function hash(text: string): string {
	let value = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		value ^= text.charCodeAt(index);
		value = Math.imul(value, 0x01000193) >>> 0;
	}
	return value.toString(16).padStart(8, "0");
}

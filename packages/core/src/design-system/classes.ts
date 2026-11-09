/**
 * Classes (ADR 0009) as Template markup and element trees use them: by name in markup, by id in
 * trees. The names come from the Draft of the Site's Design system: its Classes and the token
 * utilities its tokens make. An inline style in markup becomes a generated Class: the same
 * declarations always give the same Class (`style-` and a hash of them), so saving markup twice
 * never makes two.
 */
import {
	type DesignClass,
	type DesignSystem,
	type DesignSystemNames,
	designSystemNames,
	printCss,
	readCss,
} from "@webcraft/renderer";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { lockDesignSystem, writeDraft } from "./design-systems.ts";

/**
 * The Site's Classes while Template markup is read and printed: names to ids and back, and the
 * generated Class for an inline style, made when the Site has none yet (`created` lists those, for
 * `saveCreatedClasses`).
 */
export type ClassCatalogue = {
	named(name: string): string | undefined;
	nameOf(classId: string): string | undefined;
	/** The ids of every Class and token utility, including Classes made here. */
	ids: ReadonlySet<string>;
	forStyle(declarations: string): { id: string; name: string } | { problem: string };
	created: readonly DesignClass[];
};

export function classCatalogue(designSystem: DesignSystem): ClassCatalogue {
	const names = designSystemNames(designSystem);
	const classes = [...designSystem.classes];
	const created: DesignClass[] = [];
	const byName = new Map<string, string>();
	const byId = new Map<string, string>();
	const ids = new Set(names.classIds);
	return {
		named: (name) => byName.get(name) ?? names.classNamed(name),
		nameOf: (classId) => byId.get(classId) ?? names.nameOf(classId),
		ids,
		created,
		forStyle(declarations) {
			const same = classes.find((each) => each.generated && printCss(each.styles, names.print) === declarations);
			if (same) return { id: same.id, name: same.name };
			const read = readCss(declarations, "declarations", names.css);
			if ("problems" in read) return { problem: read.problems[0]?.message ?? "This style can't become a Class." };
			const name = freeName(`style-${hash(declarations)}`, (candidate) => !isTaken(candidate, names, byName));
			const made: DesignClass = {
				id: crypto.randomUUID(),
				name,
				generated: true,
				styles: read.css,
				breakpoints: {},
				css: [],
			};
			classes.push(made);
			created.push(made);
			byName.set(name, made.id);
			byId.set(made.id, name);
			ids.add(made.id);
			return { id: made.id, name };
		},
	};
}

function isTaken(name: string, names: DesignSystemNames, made: ReadonlyMap<string, string>): boolean {
	return names.classNamed(name) !== undefined || made.has(name);
}

/** `stem`, or `stem-2`, `stem-3`, … : the first name `free` accepts. */
function freeName(stem: string, free: (name: string) => boolean): string {
	let name = stem;
	for (let attempt = 2; !free(name); attempt++) name = `${stem}-${attempt}`;
	return name;
}

/** Someone else saved a Class with the same name at the same moment: the save is tried again. */
export class ClassRaceError extends Error {
	override name = "ClassRaceError";
	constructor() {
		super("Another save made a Class with the same name at the same moment.");
	}
}

/**
 * Adds the Classes a catalogue made to the Design system's Draft, in the save's transaction. Throws
 * `ClassRaceError` when another save took one of their names meanwhile, so the save can run again
 * and find that Class.
 */
export async function saveCreatedClasses(scope: SiteScope, catalogue: ClassCatalogue): Promise<void> {
	if (catalogue.created.length === 0) return;
	const locked = await lockDesignSystem(scope);
	const taken = new Set(designSystemNames(locked.draft).classIds);
	const takenNames = new Set(locked.draft.classes.map((each) => each.name));
	const added = catalogue.created.filter((made) => !taken.has(made.id));
	if (added.some((made) => takenNames.has(made.name))) throw new ClassRaceError();
	await writeDraft(scope, locked, { ...locked.draft, classes: [...locked.draft.classes, ...added] });
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

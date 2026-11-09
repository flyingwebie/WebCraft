import type { FieldInput } from "@webcraft/core";
import {
	FIELD_KEY,
	FIELD_TYPE_TRAITS,
	type FieldType,
	isContainerType,
	MAX_FIELD_DEPTH,
} from "@webcraft/core/field-rules";

import type { FieldDefinition } from "./model.ts";

/**
 * A Field being defined on the Post Types & Fields screen: its settings, the Fields inside it (a
 * Group's or Repeater's), a stable id for the screen, and whether it is saved yet (a saved Field keeps
 * its key and type).
 */
export type FieldDraft = { uid: string; saved: boolean; field: FieldDefinition; children: FieldDraft[] };

let counter = 0;
const nextUid = () => `f${++counter}`;

/** The drafts of Fields as stored. */
export function draftsOf(fields: readonly FieldDefinition[]): FieldDraft[] {
	return fields.map((field) => ({
		uid: nextUid(),
		saved: true,
		field,
		children: "fields" in field ? draftsOf(field.fields) : [],
	}));
}

/** The Fields as the API takes them: the full list, in order, each with its settings and inner Fields. */
export function inputsOf(drafts: readonly FieldDraft[]): FieldInput[] {
	return drafts.map(({ field, children }) => {
		const { fields: _, ...settings } = field as FieldDefinition & { fields?: unknown };
		return isContainerType(field.type)
			? ({ ...settings, fields: inputsOf(children) } as FieldInput)
			: (settings as FieldInput);
	});
}

/** A Field key made from a label: `Cover image` gives `cover_image`. */
export function keyFromLabel(label: string): string {
	const words = label
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^[^a-z]+/, "")
		.replace(/_+$/, "")
		.slice(0, 64)
		.replace(/_+$/, "");
	return FIELD_KEY.test(words) ? words : "";
}

/** A key not yet taken among a list's Fields: `field`, `field_2`, … */
export function freeKey(stem: string, taken: readonly FieldDraft[]): string {
	const used = new Set(taken.map((draft) => draft.field.key.toLowerCase()));
	for (let attempt = 1; ; attempt++) {
		const key = attempt === 1 ? stem : `${stem}_${attempt}`;
		if (!used.has(key.toLowerCase())) return key;
	}
}

/** A new Field of a type, with every setting at its default. */
export function newField(type: FieldType, key: string, label: string): FieldDefinition {
	const traits = FIELD_TYPE_TRAITS[type];
	const common = {
		key,
		label,
		help: "",
		required: false,
		translatable: traits.translation === "default-on",
		default: null,
	};
	switch (type) {
		case "text":
			return { ...common, type, minLength: null, maxLength: null, pattern: null };
		case "richText":
			return { ...common, type, maxLength: null };
		case "body":
			return { ...common, type, blocksOff: [] };
		case "number":
			return { ...common, type, min: null, max: null, integer: false };
		case "boolean":
			return { ...common, type };
		case "date":
			return { ...common, type, mode: "date", min: null, max: null };
		case "select":
			return { ...common, type, options: [], multiple: false, min: null, max: null };
		case "media":
			return { ...common, type };
		case "link":
			return { ...common, type };
		case "email":
			return { ...common, type, pattern: null };
		case "relationship":
			return { ...common, type, postTypes: [], multiple: false, twoWay: true, min: null, max: null };
		case "group":
			return { ...common, type, fields: [] };
		case "repeater":
			return { ...common, type, fields: [], min: null, max: null };
	}
}

/** A new, unsaved draft of a Field. */
export function newDraft(type: FieldType, siblings: readonly FieldDraft[], label: string): FieldDraft {
	return {
		uid: nextUid(),
		saved: false,
		field: newField(type, freeKey(keyFromLabel(label) || "field", siblings), label),
		children: [],
	};
}

/** Every draft with its depth (1 at the top) and the list it is in, in order. */
export function walk(
	drafts: readonly FieldDraft[],
	depth = 1,
): { draft: FieldDraft; depth: number; siblings: readonly FieldDraft[] }[] {
	return drafts.flatMap((draft) => [{ draft, depth, siblings: drafts }, ...walk(draft.children, depth + 1)]);
}

/** The draft with this id, wherever it is. */
export function findDraft(drafts: readonly FieldDraft[], uid: string): FieldDraft | undefined {
	return walk(drafts).find((entry) => entry.draft.uid === uid)?.draft;
}

/** The drafts with the list holding `parent` (null: the top) changed. */
export function changeList(
	drafts: readonly FieldDraft[],
	parent: string | null,
	change: (list: FieldDraft[]) => FieldDraft[],
): FieldDraft[] {
	if (parent === null) return change([...drafts]);
	return drafts.map((draft) =>
		draft.uid === parent
			? { ...draft, children: change([...draft.children]) }
			: { ...draft, children: changeList(draft.children, parent, change) },
	);
}

/** The drafts with one draft replaced. */
export function replaceDraft(
	drafts: readonly FieldDraft[],
	uid: string,
	change: (draft: FieldDraft) => FieldDraft,
): FieldDraft[] {
	return drafts.map((draft) =>
		draft.uid === uid ? change(draft) : { ...draft, children: replaceDraft(draft.children, uid, change) },
	);
}

/** The drafts with one Field's settings changed. */
export function changeField(
	drafts: readonly FieldDraft[],
	uid: string,
	change: (field: FieldDefinition) => FieldDefinition,
): FieldDraft[] {
	return drafts.map((draft) =>
		draft.uid === uid
			? { ...draft, field: change(draft.field) }
			: { ...draft, children: changeField(draft.children, uid, change) },
	);
}

/** The drafts without one Field (and the Fields inside it). */
export function removeDraft(drafts: readonly FieldDraft[], uid: string): FieldDraft[] {
	return drafts
		.filter((draft) => draft.uid !== uid)
		.map((draft) => ({ ...draft, children: removeDraft(draft.children, uid) }));
}

/** The id of the Group or Repeater holding a Field; null at the top. */
export function parentOf(
	drafts: readonly FieldDraft[],
	uid: string,
	parent: string | null = null,
): string | null | undefined {
	for (const draft of drafts) {
		if (draft.uid === uid) return parent;
		const inner = parentOf(draft.children, uid, draft.uid);
		if (inner !== undefined) return inner;
	}
	return undefined;
}

/** Whether a Field at this depth may hold more Fields. */
export function canHoldFields(type: FieldType, depth: number): boolean {
	return isContainerType(type) && depth < MAX_FIELD_DEPTH;
}

/**
 * Where a problem the server answered is, among the drafts: `fields[2].fields[0].options[1].value`
 * is the setting `options[1].value` of the first Field inside the third. Null `uid` for a problem
 * about the Post Type itself (`name`, `urlPattern`, `fields`).
 */
export function locateProblem(drafts: readonly FieldDraft[], at: string): { uid: string | null; setting: string } {
	let list: readonly FieldDraft[] = drafts;
	let rest = at;
	let found: FieldDraft | null = null;
	for (;;) {
		const match = /^fields\[(\d+)\](?:\.(.*))?$/.exec(rest);
		const next = match ? list[Number(match[1])] : undefined;
		if (!match || !next) break;
		found = next;
		list = next.children;
		rest = match[2] ?? "";
	}
	return { uid: found?.uid ?? null, setting: rest };
}

import type { FieldDefinition, Json } from "@webcraft/core";
import { type Json as DocumentJson, sameValue } from "@webcraft/core/draft-document";
import type { SharedDraft } from "../../site/edit-bar/kit.ts";
import { readFieldValues, type ValueLanguages, writeField } from "../co-editing/values.ts";
import type { LayoutState } from "./controller.ts";

type Layout = LayoutState["layout"];
export function draftLayout(draft: unknown): Layout {
	return (draft as { layout?: Layout } | null)?.layout ?? { placements: [] };
}
const object = (value: unknown): value is Record<string, DocumentJson> =>
	!!value && typeof value === "object" && !Array.isArray(value);
/** A staged edit cannot bring back a deleted row. Other values follow the ordinary CRDT rules. */
function targetsRemain(before: DocumentJson, after: DocumentJson, current: DocumentJson): boolean {
	if (sameValue(before, after)) return true;
	if (Array.isArray(before) && Array.isArray(after)) {
		if (!Array.isArray(current)) return false;
		return before.every((row, index) => {
			if (!object(row) || typeof row.id !== "string") return true;
			const wanted = after.find((item) => object(item) && item.id === row.id);
			const moved = after[index] && object(after[index]) && after[index].id !== row.id;
			if (wanted && sameValue(row, wanted) && !moved) return true;
			const live = current.find((item) => object(item) && item.id === row.id);
			return live !== undefined && (!wanted || targetsRemain(row, wanted, live));
		});
	}
	if (object(before) && object(after)) {
		if (!object(current)) return false;
		return Object.keys(before).every(
			(key) =>
				!(key in after) ||
				sameValue(before[key], after[key]) ||
				targetsRemain(before[key] ?? null, after[key] ?? null, current[key] ?? null),
		);
	}
	return true;
}

/** One Props input owner. Its view is a staged copy of the existing Entry document, not another Draft. */
export function propsInput(shared: SharedDraft, id: string, languages: ValueLanguages) {
	const stage = shared.stage();
	if (!stage) return null;
	let view = stage.read();
	const authored: { field: FieldDefinition; before: DocumentJson; after: DocumentJson }[] = [];
	const placement = (draft: unknown) => draftLayout(draft).placements.find((p) => p.id === id);
	const initial = placement(view);
	return {
		values() {
			view = stage.read();
			const p = placement(view);
			return p ? readFieldValues(p.values as Record<string, DocumentJson>, p.props, languages) : {};
		},
		change(field: FieldDefinition, value: Json) {
			const p = placement(view);
			if (!p) return false;
			const values = writeField(p.values as Record<string, DocumentJson>, field, value, languages);
			// Target checks compare the whole unfinished input with its initial stored value, not
			// an intermediate keystroke that only exists in this person's staged view.
			const previous = authored.find((change) => change.field.id === field.id && change.field.key === field.key);
			if (previous) previous.after = values[field.key] ?? null;
			else
				authored.push({
					field,
					before: (p.values[field.key] as DocumentJson) ?? null,
					after: values[field.key] ?? null,
				});
			view = {
				...(view as Record<string, DocumentJson>),
				layout: {
					placements: draftLayout(view).placements.map((row) => (row.id === id ? { ...row, values } : row)),
				},
			} as DocumentJson;
			stage.change(view);
			return true;
		},
		commit() {
			const current = placement(shared.draft());
			const valid =
				current &&
				current.component === initial?.component &&
				authored.every(
					(change) =>
						sameValue(
							current.props.find((f) => f.id === change.field.id && f.key === change.field.key),
							change.field,
						) && targetsRemain(change.before, change.after, (current.values[change.field.key] as DocumentJson) ?? null),
				);
			if (!authored.length) {
				stage.cancel();
				return { empty: true as const };
			}
			if (!valid) {
				stage.cancel();
				return null;
			}
			return stage.commit();
		},
		cancel: stage.cancel,
	};
}

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
type RowPath = (string | { id: string })[];
type RowTargets = { required: Map<string, RowPath>; created: Set<string> };
const rows = (value: DocumentJson) =>
	Array.isArray(value)
		? value.filter(
				(row): row is Record<string, DocumentJson> & { id: string } => object(row) && typeof row.id === "string",
			)
		: [];

/** Track each input's own row changes, without attributing later peer changes to that input. */
function changedRows(
	before: DocumentJson,
	after: DocumentJson,
	targets: RowTargets,
	path: RowPath = [],
	created = false,
): void {
	if (sameValue(before, after)) return;
	if (Array.isArray(after)) {
		const previous = new Map(rows(before).map((row) => [row.id, row]));
		const next = rows(after);
		const nextIds = new Set(next.map((row) => row.id));
		// Added/removed neighbours do not move surviving rows relative to one another.
		const oldOrder = [...previous.keys()].filter((id) => nextIds.has(id));
		const newOrder = next.map((row) => row.id).filter((id) => previous.has(id));
		for (const row of next) {
			const at = [...path, { id: row.id }];
			const key = JSON.stringify(at);
			const old = previous.get(row.id);
			if (!old) targets.created.add(key);
			const ownRow = created || targets.created.has(key);
			const moved = oldOrder.indexOf(row.id) !== newOrder.indexOf(row.id);
			if (old && !ownRow && (!sameValue(old, row) || moved)) targets.required.set(key, at);
			changedRows(old ?? null, row, targets, at, ownRow);
		}
	} else if (object(after)) {
		for (const [key, value] of Object.entries(after))
			changedRows(object(before) ? (before[key] ?? null) : null, value, targets, [...path, key], created);
	}
}

/** A staged edit cannot bring back a row it changed after a peer deleted that row. */
function targetsRemain(targets: RowTargets, current: DocumentJson): boolean {
	return [...targets.required.values()].every((path) => {
		let value: DocumentJson | undefined = current;
		for (const part of path) {
			value =
				typeof part === "string"
					? object(value)
						? value[part]
						: undefined
					: rows(value ?? null).find((row) => row.id === part.id);
			if (value === undefined) return false;
		}
		return true;
	});
}

/** One Props input owner. Its view is a staged copy of the existing Entry document, not another Draft. */
export function propsInput(shared: SharedDraft, id: string, languages: ValueLanguages) {
	const stage = shared.stage();
	if (!stage) return null;
	let view = stage.read();
	const authored: { field: FieldDefinition; targets: RowTargets }[] = [];
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
			let change = authored.find((change) => change.field.id === field.id && change.field.key === field.key);
			if (!change) {
				change = { field, targets: { required: new Map(), created: new Set() } };
				authored.push(change);
			}
			changedRows((p.values[field.key] as DocumentJson) ?? null, values[field.key] ?? null, change.targets);
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
						) && targetsRemain(change.targets, (current.values[change.field.key] as DocumentJson) ?? null),
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

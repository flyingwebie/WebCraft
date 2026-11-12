import { EntryInvalidError } from "./errors.ts";
import type { FieldDefinition } from "./field-types.ts";
import { defaultValues, type StoredValues } from "./field-values.ts";
import { sameJson } from "./json.ts";

/** A source contract travels with its values, including dormant historical types. */
export type PlacementValues = { props: FieldDefinition[]; values: StoredValues };
export type StoredPlacementValues = PlacementValues & { retained?: PlacementValues[] };
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const matches = (a: FieldDefinition, b: FieldDefinition) => (a.id ? a.id === b.id : !b.id && a.key === b.key);

/** Reconcile only declared identities, copying leaf storage intact (language, writer and translation source). */
export function reconcilePlacementValues(
	source: StoredPlacementValues,
	props: FieldDefinition[],
	drop = false,
	context?: Parameters<typeof defaultValues>[1],
): StoredPlacementValues & { lost: boolean } {
	const sources = [source, ...(source.retained ?? [])];
	let lost = false;
	function project(candidates: PlacementValues[], fields: FieldDefinition[]): StoredValues {
		const result: StoredValues = context ? defaultValues(fields, context) : {};
		for (const field of fields) {
			const choices = candidates.flatMap((candidate) =>
				candidate.props.flatMap((previous) =>
					matches(previous, field) && previous.type === field.type && candidate.values[previous.key] !== undefined
						? [{ field: previous, value: candidate.values[previous.key] }]
						: [],
				),
			);
			const first = choices[0];
			if (!first) continue;
			if (field.type === "group") {
				result[field.key] = {
					values: project(
						choices.map((choice) => ({
							props: "fields" in choice.field ? choice.field.fields : [],
							values: record(record(choice.value).values),
						})),
						field.fields,
					),
				};
			} else if (field.type === "repeater") {
				const rows = record(first.value).rows;
				result[field.key] = {
					rows: (Array.isArray(rows) ? rows : []).map((row) => {
						const id = record(row).id;
						return {
							id,
							values: project(
								choices.map((choice) => {
									const others = record(choice.value).rows;
									const match = Array.isArray(others) ? others.find((other) => record(other).id === id) : undefined;
									return {
										props: "fields" in choice.field ? choice.field.fields : [],
										values: record(record(match).values),
									};
								}),
								field.fields,
							),
						};
					}),
				};
			} else result[field.key] = structuredClone(first.value);
		}
		for (const previous of candidates[0]?.props ?? []) {
			const next = fields.find((field) => matches(previous, field));
			if (!next || next.type !== previous.type) lost = true;
		}
		return result;
	}
	const values = project(sources, props);
	const retained = drop
		? []
		: sameJson(source.props, props)
			? (source.retained ?? [])
			: [{ props: source.props, values: source.values }, ...(source.retained ?? [])];
	if (retained.length > 256)
		throw new EntryInvalidError([{ at: "layout", message: "At most 256 retained Prop contracts per Placement." }]);
	return { props, values, ...(retained.length ? { retained } : {}), lost };
}

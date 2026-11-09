import {
	FILTER_CONTROL_ID,
	FILTER_CONTROL_TYPES,
	FILTER_DATE_PRESETS,
	FILTER_EMPTY_OPTIONS,
	FILTER_KEY,
	FILTER_LAYOUTS,
	FILTER_LIMITS,
	FILTER_MODES,
	FILTER_OPTION_ORDERS,
	FILTER_PHONE_LAYOUTS,
	type FilterControl,
	type FilterControlType,
	type FilterDatePreset,
	type FilterLayout,
	type FilterOptionSource,
	type FilterPhoneLayout,
	type FilterSlider,
	type FilterText,
	type FilterVersion,
	newFilterVersion,
	RESERVED_FILTER_KEYS,
	randomElementId,
	type SortOption,
} from "@webcraft/renderer";

import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { fieldAt, type LoopQuery, SORTABLE_BUILT_INS, sortable } from "../content/loop-queries.ts";
import type { PostType } from "../content/post-types.ts";
import { readText } from "../forms/definition.ts";

/**
 * Reading a Filter's Draft as Staff send it (GLOSSARY.md › Filter): each part given (`mode`, `label`,
 * `applyLabel`, `controls`) replaces that part, and the result is checked as a whole against the
 * query Loop it narrows (its Post Types' Fields) and answered in canonical form (every setting filled
 * in, unset words as null). Words are a string, or `{ text, translations }` by language tag.
 */

/** A Filter's Draft change: the parts given replace those of the Draft. */
export type FilterVersionInput = {
	mode?: unknown;
	layout?: unknown;
	phone?: unknown;
	label?: unknown;
	applyLabel?: unknown;
	controls?: unknown;
};

/** What a Filter's controls are checked against: the Post Types its Loop lists, and the Site's. */
export type FilterContext = { query: LoopQuery; postTypes: readonly PostType[] };

type Report = (at: string, message: string) => void;

/** A stored version, read back. Versions are checked before they are stored, so this only fills gaps. */
export function storedFilterVersion(stored: unknown): FilterVersion {
	const fresh = newFilterVersion();
	const raw = (stored ?? {}) as Partial<FilterVersion>;
	return {
		mode: raw.mode === "submit" ? "submit" : fresh.mode,
		layout: (FILTER_LAYOUTS as readonly unknown[]).includes(raw.layout) ? (raw.layout as FilterLayout) : fresh.layout,
		phone: (FILTER_PHONE_LAYOUTS as readonly unknown[]).includes(raw.phone)
			? (raw.phone as FilterPhoneLayout)
			: fresh.phone,
		label: raw.label ?? null,
		applyLabel: raw.applyLabel ?? null,
		// A range stored before ranges had a slider and presets has neither.
		controls: Array.isArray(raw.controls)
			? raw.controls.map((control) =>
					control.type === "range"
						? { ...control, slider: control.slider ?? null, presets: control.presets ?? [] }
						: control,
				)
			: [],
	};
}

/**
 * Reads a Draft change over `current`, checking every control against the Loop's Post Types. Problems
 * are reported where they are (`controls[2].source.field`); the version answered is only meaningful
 * when there are none.
 */
export function readFilterVersion(
	input: FilterVersionInput,
	current: FilterVersion,
	context: FilterContext,
	problems: ContentProblem[],
): FilterVersion {
	const report: Report = (at, message) => problems.push({ at, message });
	let mode = current.mode;
	if (input.mode !== undefined) {
		if ((FILTER_MODES as readonly unknown[]).includes(input.mode)) mode = input.mode as FilterVersion["mode"];
		else report("mode", "A Filter updates as controls change (live) or when Apply is pressed (submit).");
	}
	let layout = current.layout;
	if (input.layout !== undefined) {
		if ((FILTER_LAYOUTS as readonly unknown[]).includes(input.layout)) layout = input.layout as FilterLayout;
		else report("layout", "A Filter is laid out as a sidebar, a top bar (topbar) or a drawer.");
	}
	let phone = current.phone;
	if (input.phone !== undefined) {
		if ((FILTER_PHONE_LAYOUTS as readonly unknown[]).includes(input.phone)) phone = input.phone as FilterPhoneLayout;
		else report("phone", "On phones a Filter becomes a drawer, or keeps its layout (same).");
	}
	const words = (value: unknown, at: string, fallback: FilterText | null) =>
		value === undefined ? fallback : readWords(value, at, report);
	return {
		mode,
		layout,
		phone,
		label: words(input.label, "label", current.label),
		applyLabel: words(input.applyLabel, "applyLabel", current.applyLabel),
		controls: input.controls === undefined ? current.controls : readControls(input.controls, context, report),
	};
}

/**
 * What a Filter's controls can use from its Loop's Post Types, as the Filter builder offers them: the
 * select and Relationship Fields options can come from (Post Types are always offered), the true/false
 * Fields toggles keep, the number and date Fields ranges cover, and what a sort menu can sort by (the
 * built-in values first, their labels left to the admin), each by its path, read by the same rules a
 * save keeps.
 */
export type FilterSources = {
	options: { field: string; label: string; type: "select" | "relationship" }[];
	toggles: { field: string; label: string }[];
	ranges: { field: string; label: string; kind: "number" | "date" }[];
	sorts: { by: string; label: string | null }[];
};

export function filterSources(context: FilterContext): FilterSources {
	const listed = context.postTypes.filter((postType) => context.query.postTypes.includes(postType.key));
	const paths = new Map<string, string>();
	const walk = (fields: readonly FieldDefinition[], prefix: string) => {
		for (const field of fields) {
			const path = `${prefix}${field.key}`;
			if (!paths.has(path)) paths.set(path, field.label);
			if (field.type === "group" || field.type === "repeater") walk(field.fields, `${path}.`);
		}
	};
	for (const postType of listed) walk(postType.fields, "");
	const quiet: Report = () => {};
	const sources: FilterSources = { options: [], toggles: [], ranges: [], sorts: [] };
	for (const by of SORTABLE_BUILT_INS) sources.sorts.push({ by, label: null });
	for (const [path, label] of paths) {
		if (readSource({ kind: "field", field: path }, "", listed, quiet)) {
			const type = fieldAt(listed, path, true)?.found[0]?.field.type;
			sources.options.push({ field: path, label, type: type === "relationship" ? "relationship" : "select" });
		}
		if (readField(path, "", listed, quiet, ["boolean"], "")) sources.toggles.push({ field: path, label });
		const range = readField(path, "", listed, quiet, ["number", "date"], "");
		if (range && !(range.definition.type === "date" && range.definition.mode === "time")) {
			sources.ranges.push({ field: path, label, kind: range.definition.type === "date" ? "date" : "number" });
		}
		if (sortable(listed, path)) sources.sorts.push({ by: path, label });
	}
	return sources;
}

/** Checks a whole version again (on publish, against the Loop's published query), reporting what no longer fits. */
export function checkFilterVersion(version: FilterVersion, context: FilterContext, problems: ContentProblem[]): void {
	readFilterVersion({ controls: version.controls }, version, context, problems);
}

/** Optional words: null when empty. */
function readWords(value: unknown, at: string, report: Report): FilterText | null {
	return readText(value, at, report, { required: false, max: FILTER_LIMITS.labelLength });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings each kind of control takes, besides `id` and `type`. */
const SETTINGS: Readonly<Record<FilterControlType, readonly string[]>> = {
	search: ["label", "placeholder"],
	checkboxes: ["key", "label", "source", "counts", "empty", "order", "match", "showFirst"],
	choice: ["key", "label", "source", "counts", "empty", "order", "display", "allLabel"],
	toggle: ["key", "label", "field"],
	// A range's `kind` is read from its Field: given back as stored, it changes nothing.
	range: ["key", "label", "field", "minLabel", "maxLabel", "kind", "slider", "presets"],
	sort: ["key", "label", "defaultLabel", "options"],
	chips: ["label", "resetLabel"],
	count: ["one", "other", "none"],
};

/** Kinds a Filter has one of at most. */
const ONCE: ReadonlySet<FilterControlType> = new Set(["search", "sort", "chips", "count"]);

function readControls(input: unknown, context: FilterContext, report: Report): FilterControl[] {
	if (!Array.isArray(input)) {
		report("controls", "A Filter's controls are a list.");
		return [];
	}
	if (input.length > FILTER_LIMITS.controls) {
		report("controls", `A Filter has at most ${FILTER_LIMITS.controls} controls.`);
		return [];
	}
	const listed = context.postTypes.filter((postType) => context.query.postTypes.includes(postType.key));
	const controls: FilterControl[] = [];
	const ids = new Set<string>();
	const keys = new Set<string>();
	input.forEach((raw: unknown, index) => {
		const at = `controls[${index}]`;
		if (!isRecord(raw)) {
			report(at, "A control is an object with its type and settings.");
			return;
		}
		const type = raw.type as FilterControlType;
		if (!FILTER_CONTROL_TYPES.includes(type)) {
			report(`${at}.type`, `A control is one of ${FILTER_CONTROL_TYPES.join(", ")}.`);
			return;
		}
		for (const name of Object.keys(raw)) {
			if (name !== "id" && name !== "type" && !SETTINGS[type].includes(name)) {
				report(`${at}.${name}`, `A ${type} control has no ${name}.`);
			}
		}
		if (ONCE.has(type) && controls.some((control) => control.type === type)) {
			report(`${at}.type`, `A Filter has one ${type} control at most.`);
			return;
		}
		let id = typeof raw.id === "string" ? raw.id : undefined;
		if (raw.id !== undefined && raw.id !== null && (id === undefined || !FILTER_CONTROL_ID.test(id))) {
			report(`${at}.id`, "A control's id is 1 to 32 letters, digits, dashes and underscores.");
			return;
		}
		if (id !== undefined && ids.has(id)) {
			report(`${at}.id`, `Another control has the id ${id}.`);
			return;
		}
		id ??= newControlId(ids);
		ids.add(id);
		const control = readControl({ ...raw, id, type }, at, listed, report);
		if (!control) return;
		if ("key" in control) {
			if (keys.has(control.key)) {
				report(`${at}.key`, `Another control has the key ${control.key}: each keeps its choice under its own.`);
				return;
			}
			keys.add(control.key);
		}
		controls.push(control);
	});
	const search = controls.some((control) => control.type === "search");
	controls.forEach((control, index) => {
		if (control.type !== "sort" || search) return;
		control.options.forEach((option, place) => {
			if (option.by === "relevance") {
				report(
					`controls[${index}].options[${place}].by`,
					"Sorting by relevance needs a search box in the Filter: the best matches come first.",
				);
			}
		});
	});
	return controls;
}

function newControlId(taken: ReadonlySet<string>): string {
	let id = randomElementId().slice(0, 12);
	while (taken.has(id)) id = randomElementId().slice(0, 12);
	return id;
}

function readControl(
	raw: Record<string, unknown> & { id: string; type: FilterControlType },
	at: string,
	listed: readonly PostType[],
	report: Report,
): FilterControl | undefined {
	const { id } = raw;
	const words = (name: string) => readWords(raw[name], `${at}.${name}`, report);
	const required = (name: string) =>
		readText(raw[name], `${at}.${name}`, report, { required: true, max: FILTER_LIMITS.labelLength });
	switch (raw.type) {
		case "search":
			return { id, type: "search", label: words("label"), placeholder: words("placeholder") };
		case "chips":
			return { id, type: "chips", label: words("label"), resetLabel: words("resetLabel") };
		case "count":
			return { id, type: "count", one: words("one"), other: words("other"), none: words("none") };
	}
	const key = readKey(raw.key, `${at}.key`, report);
	switch (raw.type) {
		case "checkboxes":
		case "choice": {
			const label = required("label");
			const source = readSource(raw.source, `${at}.source`, listed, report);
			const counts = readFlag(raw.counts, `${at}.counts`, true, report);
			const empty = readOneOf(raw.empty, `${at}.empty`, FILTER_EMPTY_OPTIONS, "disable", report);
			const order = readOneOf(raw.order, `${at}.order`, FILTER_OPTION_ORDERS, "source", report);
			if (key === undefined || !label || !source) return undefined;
			const settings = { id, key, label, source, counts, empty, order };
			if (raw.type === "checkboxes") {
				const match = readOneOf(raw.match, `${at}.match`, ["any", "all"] as const, "any", report);
				let showFirst = 10;
				if (raw.showFirst !== undefined && raw.showFirst !== null) {
					const given = raw.showFirst;
					if (typeof given !== "number" || !Number.isInteger(given) || given < 1 || given > FILTER_LIMITS.showFirst) {
						report(`${at}.showFirst`, `A control shows 1 to ${FILTER_LIMITS.showFirst} options before "Show more".`);
					} else showFirst = given;
				}
				return { ...settings, type: "checkboxes", match, showFirst };
			}
			const display = readOneOf(raw.display, `${at}.display`, ["radio", "select"] as const, "radio", report);
			return { ...settings, type: "choice", display, allLabel: words("allLabel") };
		}
		case "toggle": {
			const label = required("label");
			const field = readField(raw.field, `${at}.field`, listed, report, ["boolean"], "a true/false Field");
			if (key === undefined || !label || !field) return undefined;
			return { id, type: "toggle", key, label, field: field.path };
		}
		case "range": {
			const label = required("label");
			const field = readField(raw.field, `${at}.field`, listed, report, ["number", "date"], "a number or date Field");
			if (field?.definition.type === "date" && field.definition.mode === "time") {
				report(`${at}.field`, "A range of dates needs a date Field with a day in it.");
				return undefined;
			}
			const kind = field?.definition.type === "date" ? "date" : "number";
			const slider = readSlider(raw.slider, `${at}.slider`, field ? kind : undefined, report);
			const presets = readPresets(raw.presets, `${at}.presets`, field ? kind : undefined, report);
			if (key === undefined || !label || !field) return undefined;
			return {
				id,
				type: "range",
				key,
				label,
				field: field.path,
				kind,
				minLabel: words("minLabel"),
				maxLabel: words("maxLabel"),
				slider,
				presets,
			};
		}
		case "sort": {
			const options = readSorts(raw.options, `${at}.options`, listed, report);
			if (key === undefined || !options) return undefined;
			return {
				id,
				type: "sort",
				key,
				label: words("label"),
				defaultLabel: words("defaultLabel"),
				options,
			};
		}
	}
}

/** A range's slider: numbers only, its ends in order and a step above 0 (null: none). */
function readSlider(
	value: unknown,
	at: string,
	kind: "number" | "date" | undefined,
	report: Report,
): FilterSlider | null {
	if (value === undefined || value === null) return null;
	if (kind === "date") {
		report(at, "A slider is for a range of numbers: a range of days can offer presets instead.");
		return null;
	}
	const { min, max, step } = isRecord(value) ? value : {};
	const finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number);
	if (!finite(min) || !finite(max) || !finite(step) || min >= max || step <= 0 || step > max - min) {
		report(at, "A slider goes from its min to a greater max, in steps above 0 (such as 0, 30 and 0.5).");
		return null;
	}
	return { min, max, step };
}

/** A range's date presets: days only, each one of `FILTER_DATE_PRESETS`, once. */
function readPresets(
	value: unknown,
	at: string,
	kind: "number" | "date" | undefined,
	report: Report,
): FilterDatePreset[] {
	if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return [];
	if (kind === "number") {
		report(at, "Presets are periods of days: a range of numbers can have a slider instead.");
		return [];
	}
	if (!Array.isArray(value)) {
		report(at, `Presets are a list of ${FILTER_DATE_PRESETS.join(", ")}.`);
		return [];
	}
	const presets: FilterDatePreset[] = [];
	value.forEach((preset: unknown, index) => {
		if (!(FILTER_DATE_PRESETS as readonly unknown[]).includes(preset)) {
			report(`${at}[${index}]`, `A preset is one of ${FILTER_DATE_PRESETS.join(", ")}.`);
		} else if (presets.includes(preset as FilterDatePreset)) {
			report(`${at}[${index}]`, `The preset ${String(preset)} is offered once.`);
		} else presets.push(preset as FilterDatePreset);
	});
	return presets;
}

function readKey(value: unknown, at: string, report: Report): string | undefined {
	if (
		typeof value !== "string" ||
		!FILTER_KEY.test(value) ||
		value.length > FILTER_LIMITS.keyLength ||
		RESERVED_FILTER_KEYS.has(value)
	) {
		report(
			at,
			`A control's URL key is lower-case words joined by dashes (at most ${FILTER_LIMITS.keyLength}), such as category; q and page are taken.`,
		);
		return undefined;
	}
	return value;
}

function readFlag(value: unknown, at: string, fallback: boolean, report: Report): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	report(at, "This is true or false.");
	return fallback;
}

function readOneOf<Value extends string>(
	value: unknown,
	at: string,
	allowed: readonly Value[],
	fallback: Value,
	report: Report,
): Value {
	if (value === undefined || value === null) return fallback;
	if ((allowed as readonly unknown[]).includes(value)) return value as Value;
	report(at, `This is one of ${allowed.join(", ")}.`);
	return fallback;
}

/** A Field of the Loop's Post Types by its path, of one of `types`, the same type in each that has it. */
function readField(
	value: unknown,
	at: string,
	listed: readonly PostType[],
	report: Report,
	types: readonly FieldDefinition["type"][],
	what: string,
): { path: string; definition: FieldDefinition } | undefined {
	if (typeof value !== "string" || value === "") {
		report(at, `Choose ${what} of the Loop's Post Types.`);
		return undefined;
	}
	const found = fieldAt(listed, value);
	const [only] = found?.found ?? [];
	if (!found || !only || found.found.length > 1 || !types.includes(only.field.type)) {
		report(at, `The Loop's Post Types have no ${what} at ${value}.`);
		return undefined;
	}
	return { path: value, definition: only.field };
}

/** Where options come from: a select or Relationship Field of the Loop's Post Types, or the Post Types themselves. */
function readSource(
	value: unknown,
	at: string,
	listed: readonly PostType[],
	report: Report,
): FilterOptionSource | undefined {
	if (!isRecord(value)) {
		report(at, 'A control\'s options come from a Field ({ "kind": "field", "field": "category" }) or the Post Types.');
		return undefined;
	}
	if (value.kind === "postType") return { kind: "postType" };
	if (value.kind !== "field") {
		report(`${at}.kind`, "Options come from a Field (field) or the Loop's Post Types (postType).");
		return undefined;
	}
	const field = value.field;
	if (typeof field !== "string" || field === "") {
		report(`${at}.field`, "Choose a select or Relationship Field of the Loop's Post Types.");
		return undefined;
	}
	const select = fieldAt(listed, field);
	const relationship = fieldAt(listed, field, true);
	const definitions = (relationship ?? select)?.found ?? [];
	const [only] = definitions;
	if (
		!only ||
		definitions.length > 1 ||
		!(only.field.type === "relationship" || (only.field.type === "select" && select?.found.length === 1))
	) {
		report(`${at}.field`, `The Loop's Post Types have no select or Relationship Field at ${field}.`);
		return undefined;
	}
	return { kind: "field", field };
}

function readSorts(value: unknown, at: string, listed: readonly PostType[], report: Report): SortOption[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > FILTER_LIMITS.sorts) {
		report(at, `A sort menu offers 1 to ${FILTER_LIMITS.sorts} sorts.`);
		return undefined;
	}
	const options: SortOption[] = [];
	const values = new Set<string>();
	let complete = true;
	value.forEach((raw: unknown, index) => {
		const here = `${at}[${index}]`;
		const option = isRecord(raw) ? raw : {};
		const slug = option.value;
		if (typeof slug !== "string" || !FILTER_KEY.test(slug) || slug.length > FILTER_LIMITS.keyLength) {
			report(`${here}.value`, "A sort's URL value is lower-case words joined by dashes, such as price-asc.");
			complete = false;
			return;
		}
		if (values.has(slug)) {
			report(`${here}.value`, `Another sort has the value ${slug}.`);
			complete = false;
			return;
		}
		values.add(slug);
		const label = readText(option.label, `${here}.label`, report, { required: true, max: FILTER_LIMITS.labelLength });
		const direction = option.direction;
		if (direction !== "asc" && direction !== "desc") {
			report(`${here}.direction`, "A sort goes up (asc) or down (desc).");
			complete = false;
			return;
		}
		const by = option.by;
		if (typeof by !== "string" || (by !== "relevance" && !sortable(listed, by))) {
			report(
				`${here}.by`,
				"A sort is by relevance, the title, a date, or a text, number, date, true/false or single select Field.",
			);
			complete = false;
			return;
		}
		if (!label) {
			complete = false;
			return;
		}
		options.push({ value: slug, label, by, direction });
	});
	return complete ? options : undefined;
}

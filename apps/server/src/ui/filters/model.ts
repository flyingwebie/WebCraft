import type { ApiClient } from "@webcraft/api";
import {
	FILTER_CONTROL_ID,
	FILTER_KEY,
	FILTER_LIMITS,
	type FilterControl,
	type FilterControlType,
	type FilterText,
	type FilterVersion,
	RESERVED_FILTER_KEYS,
} from "@webcraft/renderer/filters";

/**
 * How the admin edits a Filter's Draft (GLOSSARY.md › Filter): a copy of the version, changed in the
 * browser control by control, previewed as it changes (`filters.preview`) and saved as a whole
 * (`filters.saveDraft`). The server checks it and answers each problem where it is
 * (`controls[2].source.field`), which the screen shows on the control and in a list.
 */

export type { FilterControl, FilterControlType, FilterText, FilterVersion };

/** What `filters.get` answers: the Filter, where it is placed and what its controls can use. */
export type FilterDetails = Awaited<ReturnType<ApiClient["filters"]["get"]>>;
export type FilterSources = NonNullable<FilterDetails["sources"]>;
export type FilterPlacement = FilterDetails["usage"]["usedIn"][number];

/** A problem the server answered, at its place in the version. */
export type FilterProblem = { at: string; message: string };

/** The problems of a version the server refused, or none. */
export function problemsOf(error: unknown): FilterProblem[] {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: { problems?: unknown } };
	if (code !== "FILTER_INVALID") return [];
	return Array.isArray(data?.problems) ? (data.problems as FilterProblem[]) : [];
}

/** The index of the control a problem is about (`controls[2].label` is 2), or null for the Filter as a whole. */
export function controlIndexOf(problem: FilterProblem): number | null {
	const match = /^controls\[(\d+)\]/.exec(problem.at);
	return match ? Number(match[1]) : null;
}

/** Kinds of control a Filter has one of at most. */
export const ONE_ONLY: ReadonlySet<FilterControlType> = new Set(["search", "sort", "chips", "count"]);

/** Controls with options of their own, which a top bar shows as dropdowns and a drawer holds. */
export const GROUPED: ReadonlySet<FilterControlType> = new Set(["checkboxes", "choice", "toggle", "range"]);

/** The version as `filters.saveDraft` and `filters.preview` take it. */
export function changeOf(version: FilterVersion) {
	return {
		mode: version.mode,
		layout: version.layout,
		phone: version.phone,
		label: version.label,
		applyLabel: version.applyLabel,
		controls: version.controls as unknown as Record<string, unknown>[],
	};
}

/** A URL key made from a Field's path: lower-case words joined by dashes, not one already used. */
export function keyFrom(path: string, used: ReadonlySet<string>): string {
	const words = path
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const base = (/^[a-z]/.test(words) ? words : `f-${words}`).slice(0, FILTER_LIMITS.keyLength - 3).replace(/-+$/, "");
	const fits = (key: string) => FILTER_KEY.test(key) && !RESERVED_FILTER_KEYS.has(key) && !used.has(key);
	if (fits(base)) return base;
	for (let n = 2; ; n++) if (fits(`${base}-${n}`)) return `${base}-${n}`;
}

/** An id for a new control that says what it is (`search`, `category`), unused in the Filter. */
export function idFrom(base: string, controls: readonly FilterControl[]): string {
	const used = new Set(controls.map((control) => control.id));
	const clean = base.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 28) || "control";
	if (!used.has(clean) && FILTER_CONTROL_ID.test(clean)) return clean;
	for (let n = 2; ; n++) if (!used.has(`${clean}-${n}`)) return `${clean}-${n}`;
}

/** The URL keys the controls use. */
function keysOf(controls: readonly FilterControl[]): Set<string> {
	return new Set(controls.flatMap((control) => ("key" in control ? [control.key] : [])));
}

/**
 * A new control of `type`, filled in from what its Loop's Post Types offer (the first Field that
 * fits), so it previews at once. `words` gives the labels the admin writes in the person's language.
 */
export function newControl(
	type: FilterControlType,
	controls: readonly FilterControl[],
	sources: FilterSources | null,
	words: { postTypes: string; sortTitle: string; sortLabel: string },
): FilterControl {
	const used = keysOf(controls);
	switch (type) {
		case "search":
			return { id: idFrom("search", controls), type, label: null, placeholder: null };
		case "chips":
			return { id: idFrom("chips", controls), type, label: null, resetLabel: null };
		case "count":
			return { id: idFrom("count", controls), type, one: null, other: null, none: null };
		case "sort":
			return {
				id: idFrom("sort", controls),
				type,
				key: keyFrom("sort", used),
				label: null,
				defaultLabel: null,
				options: [{ value: "title-asc", label: { text: words.sortTitle }, by: "title", direction: "asc" }],
			};
		case "checkboxes":
		case "choice": {
			const option = sources?.options.find((each) => !used.has(keyFrom(each.field, new Set())));
			const source = option ? { kind: "field" as const, field: option.field } : { kind: "postType" as const };
			const key = keyFrom(option?.field ?? "type", used);
			const common = {
				id: idFrom(key, controls),
				key,
				label: { text: option?.label ?? words.postTypes },
				source,
				counts: true,
				empty: "disable" as const,
				order: "source" as const,
			};
			return type === "checkboxes"
				? { ...common, type, match: "any", showFirst: 10 }
				: { ...common, type, display: "radio", allLabel: null };
		}
		case "toggle": {
			const field = sources?.toggles[0];
			const key = keyFrom(field?.field ?? "toggle", used);
			return { id: idFrom(key, controls), type, key, label: { text: field?.label ?? key }, field: field?.field ?? "" };
		}
		case "range": {
			const field = sources?.ranges[0];
			const key = keyFrom(field?.field ?? "range", used);
			return {
				id: idFrom(key, controls),
				type,
				key,
				label: { text: field?.label ?? key },
				field: field?.field ?? "",
				kind: field?.kind ?? "number",
				minLabel: null,
				maxLabel: null,
				slider: null,
				presets: [],
			};
		}
	}
}

/** The items of `list` with the one at `from` moved to `to`; a copy of `list`, unmoved, for an invalid move. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
	const moved = [...list];
	const [item] = moved.splice(from, 1);
	if (item !== undefined) moved.splice(to, 0, item);
	return moved;
}

/** The controls with the one at `from` moved to `to`. */
export function moveControl(controls: readonly FilterControl[], from: number, to: number): FilterControl[] {
	return moveItem(controls, from, to);
}

/** Text with its value in `language` changed: the text as written in the Default language, else a translation. */
export function withText(text: FilterText, language: string | null, value: string): FilterText {
	if (language === null) return { ...text, text: value };
	const translations = { ...(text.translations ?? {}) };
	if (value.trim() === "") delete translations[language];
	else translations[language] = value;
	return Object.keys(translations).length > 0 ? { text: text.text, translations } : { text: text.text };
}

/** Optional words from what is typed in the Default language: null when empty (WebCraft's words show). */
export function optionalText(current: FilterText | null, value: string): FilterText | null {
	if (value.trim() === "") return null;
	return { ...(current ?? {}), text: value };
}

/** Which words a control has, for its settings and the Translations tab. */
export type WordPart =
	| "label"
	| "placeholder"
	| "allLabel"
	| "minLabel"
	| "maxLabel"
	| "defaultLabel"
	| "resetLabel"
	| "one"
	| "other"
	| "none";

/** Every word of a version Staff wrote (WebCraft's own words are translated already), with where it is. */
export type TranslatableText = {
	id: string;
	/** The control it belongs to, by its label or type; null for the Filter itself. */
	control: number | null;
	part: WordPart | "applyLabel" | "sortOption" | "filterLabel";
	text: FilterText;
	set(version: FilterVersion, text: FilterText): FilterVersion;
};

export function translatableTexts(version: FilterVersion): TranslatableText[] {
	const texts: TranslatableText[] = [];
	if (version.label) {
		texts.push({
			id: "filter-label",
			control: null,
			part: "filterLabel",
			text: version.label,
			set: (current, text) => ({ ...current, label: text }),
		});
	}
	if (version.applyLabel) {
		texts.push({
			id: "apply-label",
			control: null,
			part: "applyLabel",
			text: version.applyLabel,
			set: (current, text) => ({ ...current, applyLabel: text }),
		});
	}
	version.controls.forEach((control, index) => {
		const update = (change: (control: FilterControl) => FilterControl) => (current: FilterVersion) => ({
			...current,
			controls: current.controls.map((each, at) => (at === index ? change(each) : each)),
		});
		for (const part of WORD_PARTS) {
			const value = (control as Record<string, unknown>)[part] as FilterText | null | undefined;
			if (!value || typeof value !== "object") continue;
			texts.push({
				id: `${control.id}-${part}`,
				control: index,
				part,
				text: value,
				set: (current, text) => update((each) => ({ ...each, [part]: text }) as FilterControl)(current),
			});
		}
		if (control.type === "sort") {
			control.options.forEach((option, place) => {
				texts.push({
					id: `${control.id}-sort-${option.value}`,
					control: index,
					part: "sortOption",
					text: option.label,
					set: (current, text) =>
						update((each) =>
							each.type === "sort"
								? { ...each, options: each.options.map((one, at) => (at === place ? { ...one, label: text } : one)) }
								: each,
						)(current),
				});
			});
		}
	});
	return texts;
}

const WORD_PARTS: readonly WordPart[] = [
	"label",
	"placeholder",
	"allLabel",
	"minLabel",
	"maxLabel",
	"defaultLabel",
	"resetLabel",
	"one",
	"other",
	"none",
];

/** How many of a version's words have no translation in `language`. */
export function untranslated(version: FilterVersion, language: string): number {
	return translatableTexts(version).filter((text) => !text.text.translations?.[language]).length;
}

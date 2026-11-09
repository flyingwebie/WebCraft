import { escapeAttribute, escapeText, safeUrl } from "../escape.ts";
import type { FilterMode } from "./version.ts";

/**
 * How a Filter renders (GLOSSARY.md › Filter): a plain GET form to the page itself, so it works
 * without JavaScript. Each control is labelled (fieldsets and legends for groups of options), its
 * choice is shown back, and an Apply button sends it. With JavaScript, the Filter script updates the
 * Loop in place instead (`script.ts`). Core works out everything a Filter shows on a page (its words
 * in the page's language, its options and their counts, the visitor's choices, where each chip goes)
 * as a `FilterView`; this only writes it, every value escaped for where it lands.
 */

/** A Filter as one page shows it, worked out by core. */
export type FilterView = {
	/** The Filter's name, which its elements' ids start from. */
	name: string;
	/** Where the form is sent: the page's own address. */
	action: string;
	mode: FilterMode;
	/** The form's name for screen readers. */
	label: string;
	applyLabel: string;
	/** The other Filters' choices on the page, kept as hidden fields so sending this one keeps them. */
	keep: readonly (readonly [name: string, value: string])[];
	controls: readonly FilterControlView[];
	/** What screen readers hear once the Loop is updated: how many items it lists. */
	announce: string;
};

/** One option of a control: its URL value, label, how many items it would list (null: not shown), and its state. */
export type FilterOptionView = {
	value: string;
	label: string;
	count: number | null;
	checked: boolean;
	disabled: boolean;
};

export type FilterControlView =
	| { type: "search"; name: string; label: string; placeholder: string | null; value: string }
	| {
			type: "checkboxes";
			name: string;
			label: string;
			options: readonly FilterOptionView[];
			showFirst: number;
			showMore: string;
	  }
	| {
			type: "choice";
			name: string;
			label: string;
			display: "radio" | "select";
			allLabel: string;
			options: readonly FilterOptionView[];
	  }
	| { type: "toggle"; name: string; label: string; checked: boolean }
	| {
			type: "range";
			name: string;
			label: string;
			kind: "number" | "date";
			minLabel: string;
			maxLabel: string;
			min: string;
			max: string;
	  }
	| {
			type: "sort";
			name: string;
			label: string;
			defaultLabel: string;
			options: readonly { value: string; label: string; selected: boolean }[];
	  }
	| {
			type: "chips";
			label: string;
			resetLabel: string;
			resetHref: string;
			chips: readonly { label: string; removeLabel: string; href: string }[];
	  }
	| { type: "count"; text: string };

/** The class names WebCraft gives a Filter's parts, styled in the Design system's base layer. */
export const FILTER_HOOKS = {
	form: "wc-filter",
	control: "wc-filter-control",
	options: "wc-filter-options",
	optionCount: "wc-filter-option-count",
	more: "wc-filter-more",
	chips: "wc-filter-chips",
	chip: "wc-filter-chip",
	reset: "wc-filter-reset",
	count: "wc-filter-count",
	apply: "wc-filter-apply",
} as const;

/** The text box suffixes a range sends without JavaScript: `price.min` and `price.max`. */
export const RANGE_PARTS = { min: ".min", max: ".max" } as const;

/**
 * The form of a Filter as a page shows it. `occurrence` numbers the Filter's places on the page (the
 * first is 1), so every element's id is the page's only one.
 */
export function renderFilter(view: FilterView, occurrence: number): string {
	const base = `wc-filter-${view.name}${occurrence > 1 ? `-${occurrence}` : ""}`;
	const id = (...parts: (string | number)[]) => escapeAttribute([base, ...parts].join("-"));
	const parts = view.controls.map((control, index) => controlHtml(control, (...rest) => id(index + 1, ...rest)));
	const keep = view.keep.map(
		([name, value]) => `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`,
	);
	return [
		`<form class="${FILTER_HOOKS.form}" id="${id()}" method="get" action="${escapeAttribute(safeUrl(view.action))}" aria-label="${escapeAttribute(view.label)}" data-wc-filter="${escapeAttribute(view.name)}" data-wc-mode="${view.mode}" data-wc-announce="${escapeAttribute(view.announce)}">`,
		...keep,
		...parts,
		`<button class="${FILTER_HOOKS.apply}" type="submit">${escapeText(view.applyLabel)}</button>`,
		"</form>",
	].join("");
}

function controlHtml(control: FilterControlView, id: (...parts: (string | number)[]) => string): string {
	const name = "name" in control ? escapeAttribute(control.name) : "";
	switch (control.type) {
		case "search": {
			const value = control.value ? ` value="${escapeAttribute(control.value)}"` : "";
			const placeholder = control.placeholder ? ` placeholder="${escapeAttribute(control.placeholder)}"` : "";
			return `<div class="${FILTER_HOOKS.control}" data-wc-control="search"><label for="${id()}">${escapeText(control.label)}</label><input type="search" id="${id()}" name="${name}"${value}${placeholder} maxlength="200" enterkeyhint="search"></div>`;
		}
		case "checkboxes": {
			const items = control.options.map((option, index) => {
				const field = `<input type="checkbox" id="${id(index + 1)}" name="${name}" value="${escapeAttribute(option.value)}"${option.checked ? " checked" : ""}${option.disabled ? " disabled" : ""}>`;
				return `<li>${field}<label for="${id(index + 1)}">${optionLabel(option)}</label></li>`;
			});
			const first = items.slice(0, control.showFirst);
			const rest = items.slice(control.showFirst);
			// The rest of a long list is a disclosure, open when it holds a choice (no script needed).
			const open = control.options.slice(control.showFirst).some((option) => option.checked) ? " open" : "";
			const more =
				rest.length > 0
					? `<details class="${FILTER_HOOKS.more}"${open}><summary>${escapeText(control.showMore)}</summary><ul class="${FILTER_HOOKS.options}">${rest.join("")}</ul></details>`
					: "";
			return `<fieldset class="${FILTER_HOOKS.control}" data-wc-control="checkboxes"><legend>${escapeText(control.label)}</legend><ul class="${FILTER_HOOKS.options}">${first.join("")}</ul>${more}</fieldset>`;
		}
		case "choice": {
			const none = !control.options.some((option) => option.checked);
			if (control.display === "select") {
				const options = [
					`<option value=""${none ? " selected" : ""}>${escapeText(control.allLabel)}</option>`,
					...control.options.map(
						(option) =>
							`<option value="${escapeAttribute(option.value)}"${option.checked ? " selected" : ""}${option.disabled ? " disabled" : ""}>${escapeText(option.count === null ? option.label : `${option.label} (${option.count})`)}</option>`,
					),
				];
				return `<div class="${FILTER_HOOKS.control}" data-wc-control="choice"><label for="${id()}">${escapeText(control.label)}</label><select id="${id()}" name="${name}">${options.join("")}</select></div>`;
			}
			const items = [
				`<li><input type="radio" id="${id(0)}" name="${name}" value=""${none ? " checked" : ""}><label for="${id(0)}">${escapeText(control.allLabel)}</label></li>`,
				...control.options.map(
					(option, index) =>
						`<li><input type="radio" id="${id(index + 1)}" name="${name}" value="${escapeAttribute(option.value)}"${option.checked ? " checked" : ""}${option.disabled ? " disabled" : ""}><label for="${id(index + 1)}">${optionLabel(option)}</label></li>`,
				),
			];
			return `<fieldset class="${FILTER_HOOKS.control}" data-wc-control="choice"><legend>${escapeText(control.label)}</legend><ul class="${FILTER_HOOKS.options}">${items.join("")}</ul></fieldset>`;
		}
		case "toggle":
			return `<div class="${FILTER_HOOKS.control}" data-wc-control="toggle"><input type="checkbox" role="switch" id="${id()}" name="${name}" value="1"${control.checked ? " checked" : ""}><label for="${id()}">${escapeText(control.label)}</label></div>`;
		case "range": {
			const type = control.kind === "date" ? "date" : "number";
			const step = control.kind === "number" ? ' step="any" inputmode="decimal"' : "";
			const box = (part: "min" | "max", label: string, value: string) =>
				`<label for="${id(part)}">${escapeText(label)}</label><input type="${type}" id="${id(part)}" name="${name}${RANGE_PARTS[part]}"${value ? ` value="${escapeAttribute(value)}"` : ""}${step}>`;
			return `<fieldset class="${FILTER_HOOKS.control}" data-wc-control="range"><legend>${escapeText(control.label)}</legend>${box("min", control.minLabel, control.min)}${box("max", control.maxLabel, control.max)}</fieldset>`;
		}
		case "sort": {
			const none = !control.options.some((option) => option.selected);
			const options = [
				`<option value=""${none ? " selected" : ""}>${escapeText(control.defaultLabel)}</option>`,
				...control.options.map(
					(option) =>
						`<option value="${escapeAttribute(option.value)}"${option.selected ? " selected" : ""}>${escapeText(option.label)}</option>`,
				),
			];
			return `<div class="${FILTER_HOOKS.control}" data-wc-control="sort"><label for="${id()}">${escapeText(control.label)}</label><select id="${id()}" name="${name}">${options.join("")}</select></div>`;
		}
		case "chips": {
			if (control.chips.length === 0) return `<div class="${FILTER_HOOKS.chips}" data-wc-control="chips"></div>`;
			// Ids by place, so focus on a removed chip moves to the one that takes its place.
			const chips = control.chips.map(
				(chip, index) =>
					`<li><a class="${FILTER_HOOKS.chip}" id="${id(index + 1)}" href="${escapeAttribute(safeUrl(chip.href))}" aria-label="${escapeAttribute(chip.removeLabel)}" data-wc-filter-link>${escapeText(chip.label)}<span aria-hidden="true"> ×</span></a></li>`,
			);
			return `<div class="${FILTER_HOOKS.chips}" data-wc-control="chips" role="group" aria-label="${escapeAttribute(control.label)}"><ul>${chips.join("")}</ul><a class="${FILTER_HOOKS.reset}" id="${id("reset")}" href="${escapeAttribute(safeUrl(control.resetHref))}" data-wc-filter-link>${escapeText(control.resetLabel)}</a></div>`;
		}
		case "count":
			return `<p class="${FILTER_HOOKS.count}" data-wc-control="count">${escapeText(control.text)}</p>`;
	}
}

/** An option's label with how many items it would list, when shown. */
function optionLabel(option: FilterOptionView): string {
	const count = option.count === null ? "" : ` <span class="${FILTER_HOOKS.optionCount}">${option.count}</span>`;
	return `${escapeText(option.label)}${count}`;
}

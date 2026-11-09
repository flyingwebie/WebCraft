import { escapeAttribute, escapeText, safeUrl } from "../escape.ts";
import type { FilterLayout, FilterMode, FilterPhoneLayout } from "./version.ts";

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
	/** Its layout preset, and what it becomes on phones. */
	layout: FilterLayout;
	phone: FilterPhoneLayout;
	/** The form's name for screen readers, and the drawer's title and button. */
	label: string;
	applyLabel: string;
	/**
	 * The drawer's words: its Close button's name, its Reset link (to the page without this Filter's
	 * choices) and its button applying the choices ("Show 14 products"), and what follows how many
	 * choices a button's controls hold ("chosen").
	 */
	drawer: { close: string; reset: string; resetHref: string; show: string };
	chosen: string;
	/** The other Filters' choices on the page, kept as hidden fields so sending this one keeps them. */
	keep: readonly (readonly [name: string, value: string])[];
	/** This Filter's own choices, by key: a control shown on its own as a form sends the others on. */
	choices: readonly (readonly [name: string, value: string])[];
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
			/** A slider for each end (numbers only), shown once the Filter script runs. */
			slider: { min: number; max: number; step: number } | null;
			/** Periods to pick at once (days only): links to the page with the period chosen. */
			presets: readonly { label: string; href: string; from: string; to: string; current: boolean }[];
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
	/** How many choices a button's controls hold. */
	badge: "wc-filter-badge",
	/** A top bar's dropdowns: each control with options, its button and its popover. */
	pop: "wc-filter-pop",
	popButton: "wc-filter-pop-button",
	popPanel: "wc-filter-pop-panel",
	/** The drawer: the button opening it, the dialog and its parts. */
	open: "wc-filter-open",
	drawer: "wc-filter-drawer",
	drawerHead: "wc-filter-drawer-head",
	drawerTitle: "wc-filter-drawer-title",
	drawerBody: "wc-filter-drawer-body",
	drawerFoot: "wc-filter-drawer-foot",
	drawerReset: "wc-filter-drawer-reset",
	close: "wc-filter-close",
	show: "wc-filter-show",
	/** A control shown on its own elsewhere on the page. */
	part: "wc-filter-part",
	/** A range's slider, and a range of days' presets. */
	slider: "wc-filter-slider",
	presets: "wc-filter-presets",
} as const;

/**
 * Controls with options of their own (checkboxes, a choice, a toggle, a range): the ones a top bar
 * shows as dropdown buttons and a drawer holds. The search box, the sort menu, the chips and the count
 * stay on the page.
 */
const GROUPED: ReadonlySet<FilterControlView["type"]> = new Set(["checkboxes", "choice", "toggle", "range"]);

/** The text box suffixes a range sends without JavaScript: `price.min` and `price.max`. */
export const RANGE_PARTS = { min: ".min", max: ".max" } as const;

/**
 * The form of a Filter as a page shows it. `occurrence` numbers the Filter's places on the page (the
 * first is 1), so every element's id is the page's only one.
 *
 * Its layout preset decides the markup around the controls, which the Design system's base layer
 * styles: a sidebar stacks them; a top bar shows each control with options as a dropdown button
 * opening a popover; a drawer holds them in a modal dialog opened by a "Filters" button (with
 * `command="show-modal"`, so no script is needed where browsers have it), applied with its own "Show"
 * button. With the drawer for phones only, wider screens show the dialog's content in place.
 */
export function renderFilter(view: FilterView, occurrence: number, leaveOut?: ReadonlySet<number>): string {
	const base = `wc-filter-${view.name}${occurrence > 1 ? `-${occurrence}` : ""}`;
	const id = (...parts: (string | number)[]) => escapeAttribute([base, ...parts].join("-"));
	const drawer = view.layout === "drawer" || view.phone === "drawer";
	const parts: string[] = [];
	const held: string[] = [];
	let chosen = 0;
	view.controls.forEach((control, index) => {
		if (leaveOut?.has(index)) return;
		const at = (...rest: (string | number)[]) => id(index + 1, ...rest);
		let html = controlHtml(control, at);
		const grouped = GROUPED.has(control.type);
		if (grouped && view.layout === "topbar") html = dropdown(view, control, at, html);
		if (grouped && drawer) {
			if (held.length === 0) parts.push(DRAWER_PLACE);
			held.push(html);
			chosen += chosenIn(control);
		} else parts.push(html);
	});
	const shown = parts.map((part) => (part === DRAWER_PLACE ? drawerHtml(view, id, held, chosen) : part));
	return formHtml(view, id(), view.keep, shown.join(""));
}

/**
 * One control of a Filter shown on its own (`{{@filter <name> for="<loop>" control="<id>"}}`), the
 * control at `index` of the view, its ids those it has in the Filter's form. Beside the Filter's form
 * (`form`, its id), its fields belong to that form (the `form` attribute), which leaves the control
 * out. Without it, a control with fields is a form of its own, sending the page's other choices on.
 * `occurrence` numbers this control's places on the page.
 */
export function renderFilterPart(view: FilterView, index: number, occurrence: number, form: string | null): string {
	const control = view.controls[index];
	if (!control) return "";
	const base = `wc-filter-${view.name}${occurrence > 1 ? `-part${occurrence}` : ""}`;
	const at = (...rest: (string | number)[]) => escapeAttribute([base, index + 1, ...rest].join("-"));
	const fields = control.type !== "chips" && control.type !== "count";
	if (form !== null || !fields) {
		const html = controlHtml(control, at, fields && form !== null ? form : undefined);
		return `<div class="${FILTER_HOOKS.part}" id="${at("part")}" data-wc-filter="${escapeAttribute(view.name)}">${html}<!--/${FILTER_HOOKS.part}--></div>`;
	}
	// The Filter's other choices go on with this form, beside the other Filters' on the page.
	const others = view.choices.filter(([name]) => name !== control.name);
	return formHtml(view, at("part"), [...others, ...view.keep], controlHtml(control, at));
}

/** A Filter's form around its controls: hidden fields keeping other choices, then an Apply button. */
function formHtml(view: FilterView, id: string, keep: FilterView["keep"], controls: string): string {
	const hidden = keep.map(
		([name, value]) => `<input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}">`,
	);
	return [
		`<form class="${FILTER_HOOKS.form}" id="${id}" method="get" action="${escapeAttribute(safeUrl(view.action))}" aria-label="${escapeAttribute(view.label)}" data-wc-filter="${escapeAttribute(view.name)}" data-wc-mode="${view.mode}" data-wc-layout="${view.layout}" data-wc-phone="${view.phone}" data-wc-announce="${escapeAttribute(view.announce)}">`,
		...hidden,
		controls,
		`<button class="${FILTER_HOOKS.apply}" type="submit">${escapeText(view.applyLabel)}</button>`,
		"</form>",
	].join("");
}

/** Where the drawer goes among a form's parts: in place of the first control it holds. */
const DRAWER_PLACE = "\u0000drawer";

/** How many choices a control holds: its ticked options, or one for a choice, a toggle or a range that has one. */
function chosenIn(control: FilterControlView): number {
	switch (control.type) {
		case "checkboxes":
			return control.options.filter((option) => option.checked).length;
		case "choice":
			return control.options.some((option) => option.checked) ? 1 : 0;
		case "toggle":
			return control.checked ? 1 : 0;
		case "range":
			return control.min !== "" || control.max !== "" ? 1 : 0;
		default:
			return 0;
	}
}

/** A button's words, and how many choices its controls hold when there are any ("Category 2 chosen"). */
function withChosen(view: FilterView, label: string, chosen: number): string {
	const badge =
		chosen > 0
			? ` <span class="${FILTER_HOOKS.badge}">${chosen}</span><span class="wc-visually-hidden"> ${escapeText(view.chosen)}</span>`
			: "";
	return `<span>${escapeText(label)}</span>${badge}`;
}

/** A control of a top bar: a button opening it as a popover, which applies with its own button in On submit mode. */
function dropdown(
	view: FilterView,
	control: FilterControlView,
	at: (...parts: (string | number)[]) => string,
	html: string,
): string {
	const label = "label" in control ? control.label : "";
	const apply =
		view.mode === "submit"
			? `<button class="${FILTER_HOOKS.apply}" type="submit">${escapeText(view.applyLabel)}</button>`
			: "";
	return `<div class="${FILTER_HOOKS.pop}"><button type="button" class="${FILTER_HOOKS.popButton}" id="${at("button")}" popovertarget="${at("panel")}">${withChosen(view, label, chosenIn(control))}</button><div class="${FILTER_HOOKS.popPanel}" id="${at("panel")}" popover>${html}${apply}</div></div>`;
}

/** The drawer: its button, then the dialog with the controls it holds, its Reset and its "Show" button. */
function drawerHtml(
	view: FilterView,
	id: (...parts: (string | number)[]) => string,
	held: readonly string[],
	chosen: number,
): string {
	const dialog = id("drawer");
	return [
		`<button type="button" class="${FILTER_HOOKS.open}" id="${id("open")}" commandfor="${dialog}" command="show-modal" aria-haspopup="dialog">${withChosen(view, view.label, chosen)}</button>`,
		`<dialog class="${FILTER_HOOKS.drawer}" id="${dialog}" aria-labelledby="${id("drawer", "title")}">`,
		`<div class="${FILTER_HOOKS.drawerHead}"><p class="${FILTER_HOOKS.drawerTitle}" id="${id("drawer", "title")}">${escapeText(view.label)}</p><button type="button" class="${FILTER_HOOKS.close}" commandfor="${dialog}" command="close" aria-label="${escapeAttribute(view.drawer.close)}"><span aria-hidden="true">×</span></button></div>`,
		`<div class="${FILTER_HOOKS.drawerBody}">${held.join("")}</div>`,
		`<div class="${FILTER_HOOKS.drawerFoot}"><a class="${FILTER_HOOKS.drawerReset}" id="${id("drawer", "reset")}" href="${escapeAttribute(safeUrl(view.drawer.resetHref))}" data-wc-filter-link>${escapeText(view.drawer.reset)}</a><button type="submit" class="${FILTER_HOOKS.show}" id="${id("show")}">${escapeText(view.drawer.show)}</button></div>`,
		"</dialog>",
	].join("");
}

function controlHtml(control: FilterControlView, id: (...parts: (string | number)[]) => string, form?: string): string {
	const name = "name" in control ? escapeAttribute(control.name) : "";
	// A control shown apart from its Filter's form names that form, so its fields are sent with it.
	const owner = form ? ` form="${escapeAttribute(form)}"` : "";
	switch (control.type) {
		case "search": {
			const value = control.value ? ` value="${escapeAttribute(control.value)}"` : "";
			const placeholder = control.placeholder ? ` placeholder="${escapeAttribute(control.placeholder)}"` : "";
			return `<div class="${FILTER_HOOKS.control}" id="${id("control")}" data-wc-control="search"><label for="${id()}">${escapeText(control.label)}</label><input type="search" id="${id()}" name="${name}"${owner}${value}${placeholder} maxlength="200" enterkeyhint="search"></div>`;
		}
		case "checkboxes": {
			const items = control.options.map((option, index) => {
				const field = `<input type="checkbox" id="${id(index + 1)}" name="${name}"${owner} value="${escapeAttribute(option.value)}"${option.checked ? " checked" : ""}${option.disabled ? " disabled" : ""}>`;
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
			return `<fieldset class="${FILTER_HOOKS.control}" id="${id("control")}" data-wc-control="checkboxes"><legend>${escapeText(control.label)}</legend><ul class="${FILTER_HOOKS.options}">${first.join("")}</ul>${more}</fieldset>`;
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
				return `<div class="${FILTER_HOOKS.control}" id="${id("control")}" data-wc-control="choice"><label for="${id()}">${escapeText(control.label)}</label><select id="${id()}" name="${name}"${owner}>${options.join("")}</select></div>`;
			}
			const items = [
				`<li><input type="radio" id="${id(0)}" name="${name}"${owner} value=""${none ? " checked" : ""}><label for="${id(0)}">${escapeText(control.allLabel)}</label></li>`,
				...control.options.map(
					(option, index) =>
						`<li><input type="radio" id="${id(index + 1)}" name="${name}"${owner} value="${escapeAttribute(option.value)}"${option.checked ? " checked" : ""}${option.disabled ? " disabled" : ""}><label for="${id(index + 1)}">${optionLabel(option)}</label></li>`,
				),
			];
			return `<fieldset class="${FILTER_HOOKS.control}" id="${id("control")}" data-wc-control="choice"><legend>${escapeText(control.label)}</legend><ul class="${FILTER_HOOKS.options}">${items.join("")}</ul></fieldset>`;
		}
		case "toggle":
			return `<div class="${FILTER_HOOKS.control}" id="${id("control")}" data-wc-control="toggle"><input type="checkbox" role="switch" id="${id()}" name="${name}"${owner} value="1"${control.checked ? " checked" : ""}><label for="${id()}">${escapeText(control.label)}</label></div>`;
		case "range": {
			const type = control.kind === "date" ? "date" : "number";
			const step = control.kind === "number" ? ' step="any" inputmode="decimal"' : "";
			const box = (part: "min" | "max", label: string, value: string) =>
				`<label for="${id(part)}">${escapeText(label)}</label><input type="${type}" id="${id(part)}" name="${name}${RANGE_PARTS[part]}"${owner}${value ? ` value="${escapeAttribute(value)}"` : ""}${step}>`;
			return `<fieldset class="${FILTER_HOOKS.control}" id="${id("control")}" data-wc-control="range"><legend>${escapeText(control.label)}</legend>${box("min", control.minLabel, control.min)}${box("max", control.maxLabel, control.max)}${sliderHtml(control, id)}${presetsHtml(control)}</fieldset>`;
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
			return `<div class="${FILTER_HOOKS.control}" id="${id("control")}" data-wc-control="sort"><label for="${id()}">${escapeText(control.label)}</label><select id="${id()}" name="${name}"${owner}>${options.join("")}</select></div>`;
		}
		case "chips": {
			if (control.chips.length === 0)
				return `<div class="${FILTER_HOOKS.chips}" id="${id("control")}" data-wc-control="chips"></div>`;
			// Ids by place, so focus on a removed chip moves to the one that takes its place.
			const chips = control.chips.map(
				(chip, index) =>
					`<li><a class="${FILTER_HOOKS.chip}" id="${id(index + 1)}" href="${escapeAttribute(safeUrl(chip.href))}" aria-label="${escapeAttribute(chip.removeLabel)}" data-wc-filter-link>${escapeText(chip.label)}<span aria-hidden="true"> ×</span></a></li>`,
			);
			return `<div class="${FILTER_HOOKS.chips}" id="${id("control")}" data-wc-control="chips" role="group" aria-label="${escapeAttribute(control.label)}"><ul>${chips.join("")}</ul><a class="${FILTER_HOOKS.reset}" id="${id("reset")}" href="${escapeAttribute(safeUrl(control.resetHref))}" data-wc-filter-link>${escapeText(control.resetLabel)}</a></div>`;
		}
		case "count":
			return `<p class="${FILTER_HOOKS.count}" id="${id("control")}" data-wc-control="count">${escapeText(control.text)}</p>`;
	}
}

type RangeView = Extract<FilterControlView, { type: "range" }>;

/**
 * A range's slider: one for each end, without a name (the boxes are what the form sends), hidden
 * until the Filter script shows it and keeps each in step with its box, so its values always show.
 */
function sliderHtml(control: RangeView, id: (...parts: (string | number)[]) => string): string {
	const { slider } = control;
	if (!slider) return "";
	const end = (part: "min" | "max", label: string, value: string) => {
		const shown = value === "" ? (part === "min" ? slider.min : slider.max) : value;
		return `<input type="range" id="${id(part, "slider")}" min="${slider.min}" max="${slider.max}" step="${slider.step}" value="${escapeAttribute(String(shown))}" aria-label="${escapeAttribute(label)}" data-wc-for="${id(part)}">`;
	};
	return `<div class="${FILTER_HOOKS.slider}" data-wc-slider hidden>${end("min", control.minLabel, control.min)}${end("max", control.maxLabel, control.max)}</div>`;
}

/** A range of days' presets: links to the page with each period chosen, the one chosen marked. */
function presetsHtml(control: RangeView): string {
	if (control.presets.length === 0) return "";
	const items = control.presets.map(
		(preset) =>
			`<li><a href="${escapeAttribute(safeUrl(preset.href))}" data-wc-filter-link data-wc-from="${escapeAttribute(preset.from)}" data-wc-to="${escapeAttribute(preset.to)}"${preset.current ? ' aria-current="true"' : ""}>${escapeText(preset.label)}</a></li>`,
	);
	return `<ul class="${FILTER_HOOKS.presets}">${items.join("")}</ul>`;
}

/** An option's label with how many items it would list, when shown. */
function optionLabel(option: FilterOptionView): string {
	const count = option.count === null ? "" : ` <span class="${FILTER_HOOKS.optionCount}">${option.count}</span>`;
	return `${escapeText(option.label)}${count}`;
}

/**
 * The Forms place's addresses (BA-26; ADR 0037 › Addresses): `wc-place` names the Form and its tab
 * (`forms`, `forms/<id>` for its Build tab, `forms/<id>/<tab>` for the others), and `wc-view` what the
 * Build tab shows of it (the field chosen, by its place in the Form, and the step shown). Pure, so the
 * shell and the tests read them the same way.
 */

/** The tabs of a Form (SPEC 15.2), in their order: Build is BA-26's, the others BA-27's. */
export const FORM_TABS = ["build", "after-sending", "emails", "translations", "settings"] as const;

export type FormTab = (typeof FORM_TABS)[number];

/** What `wc-place` says of the Forms place: the Form open (null: the first one) and its tab. */
export type FormsAt = { formId: string | null; tab: FormTab };

/** Reads a Forms place address (`forms/<id>/emails`); null when it isn't one. */
export function formsAt(place: string): FormsAt | null {
	const [head, formId, tab, ...rest] = place.split("/");
	if (head !== "forms" || rest.length > 0) return null;
	if (!formId) return { formId: null, tab: "build" };
	const known = tab === undefined ? "build" : FORM_TABS.find((each) => each === tab);
	return known ? { formId, tab: known } : { formId, tab: "build" };
}

/** The address of a Form's tab: `forms/<id>` for Build, `forms/<id>/<tab>` for the others. */
export function formsPlace(formId: string | null, tab: FormTab = "build"): string {
	if (!formId) return "forms";
	return tab === "build" ? `forms/${formId}` : `forms/${formId}/${tab}`;
}

/** What the Build tab shows: the item chosen (its index in the Form's items) and the step shown (from 1). */
export type BuildView = { field: number | null; step: number | null };

/** Reads the Build tab's view (`field=3&step=2`); anything else in it is dropped. */
export function readBuildView(view: string | null): BuildView {
	const params = new URLSearchParams(view ?? "");
	const number = (name: string, least: number) => {
		const value = params.get(name);
		if (value === null || !/^\d{1,4}$/.test(value)) return null;
		const parsed = Number(value);
		return parsed >= least ? parsed : null;
	};
	return { field: number("field", 0), step: number("step", 1) };
}

/** Prints the Build tab's view; null when it is the default (nothing chosen, the first step). */
export function printBuildView(view: BuildView): string | null {
	const params = new URLSearchParams();
	if (view.field !== null) params.set("field", String(view.field));
	if (view.step !== null && view.step > 1) params.set("step", String(view.step));
	const printed = params.toString();
	return printed === "" ? null : printed;
}

/**
 * A Form's key as the server makes it from a name when none is given (`forms.create`): lower-case
 * words joined by dashes. Shown under the name in New Form before the Form is made.
 */
export function keyFromName(name: string): string {
	const slug = name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
		.replace(/-+$/, "");
	if (slug === "") return "";
	return /^[a-z]/.test(slug) ? slug : `form-${slug}`.replace(/-+$/, "");
}

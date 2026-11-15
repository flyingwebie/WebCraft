/**
 * A Form placed on a page (`{{@form <key>}}`; SPEC 15.3, BA-27): the renderer draws it as a `<form>`
 * posting to the Site's own `/_webcraft/forms/<id>`. On the canvas it is one thing: a click anywhere in
 * it chooses the whole Form, never one of its fields (they are built in the Forms place). For Staff,
 * Code mode's comment range just before it names the command that placed it (`<source>#@<path>`), so
 * the Inspector can put another Form in its place.
 */

/** Where the Forms of a Site post to, as the renderer writes a placed Form's `action`. */
const FORMS_PATH = "/_webcraft/forms/";

/** A placed Form, as a selector of the page. */
export const PLACED_FORM = `form[action^="${FORMS_PATH}"]`;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The placed Form an element of the page is in (or is), or null. */
export function placedFormOf(element: Element | null): HTMLFormElement | null {
	const found = element?.closest(PLACED_FORM) ?? null;
	return found && formIdOf(found) ? (found as HTMLFormElement) : null;
}

/** The id of the Form a placed Form posts to, or null when it isn't one. */
export function formIdOf(form: Element): string | null {
	const action = form.getAttribute("action") ?? "";
	if (!action.startsWith(FORMS_PATH)) return null;
	const id = action.slice(FORMS_PATH.length);
	return ID.test(id) ? id : null;
}

/**
 * The Structure reference of what placed the Form (`site#@0.0.2`): the comment range Code mode opens
 * just before it, for Staff's render. Null when there is none (a Member's render, or something the
 * page drew itself).
 */
export function placedFormRef(form: Element): string | null {
	let node: Node | null = form.previousSibling;
	while (node) {
		if (node.nodeType === Node.COMMENT_NODE) {
			const match = /^wc-code-start (\S+)$/.exec((node.nodeValue ?? "").trim());
			if (!match?.[1]) return null;
			let ref: string;
			try {
				ref = decodeURIComponent(match[1]);
			} catch {
				return null;
			}
			return ref.includes("#@") ? ref : null;
		}
		if (node.nodeType !== Node.TEXT_NODE || (node.nodeValue ?? "").trim() !== "") return null;
		node = node.previousSibling;
	}
	return null;
}

/** The names of the Site's Forms, by id, as the shell last read them: what a placed Form's chip says. */
const names = new Map<string, string>();

/** Who draws with the names, to draw again once they are read. */
const listeners = new Set<() => void>();

/** Keeps the names of the Site's Forms for the chips, and tells who draws with them. */
export function rememberFormNames(forms: readonly { id: string; name: string }[]): void {
	for (const form of forms) names.set(form.id, form.name);
	for (const listener of listeners) listener();
}

/** Calls `listener` whenever the Forms' names are read; answers how to stop. */
export function onFormNames(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** A placed Form's name, when the shell has read it. */
export function formNameOf(formId: string | null): string | null {
	return formId ? (names.get(formId) ?? null) : null;
}

/** The reference of a chosen element of the page: its own `data-wc-code`, or a placed Form's command. */
export function chosenRefOf(element: Element | null): string | null {
	if (!element) return null;
	return element.getAttribute("data-wc-code") ?? (element.matches(PLACED_FORM) ? placedFormRef(element) : null);
}

/** The placed Form a command's reference names (`site#@0.0.2`), on the page; null when none. */
export function placedFormAt(page: Document, ref: string): HTMLFormElement | null {
	if (!ref.includes("#@")) return null;
	for (const form of page.querySelectorAll<HTMLFormElement>(PLACED_FORM)) {
		if (placedFormRef(form) === ref) return form;
	}
	return null;
}

/** The read of the Site's Forms' names, once per shell. */
let reading: Promise<void> | null = null;

/**
 * Reads the names of the Site's Forms once, when a page shows a placed Form (`forms.list`, for Staff
 * and for the clients who change a Form's emails; anyone else's chip says "Form").
 */
export function readFormNames(page: Document, list: () => Promise<{ forms: { id: string; name: string }[] }>): void {
	if (reading || !page.querySelector(PLACED_FORM)) return;
	reading = list().then(
		({ forms }) => rememberFormNames(forms),
		() => {},
	);
}

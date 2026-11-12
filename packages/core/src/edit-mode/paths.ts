/** Where Edit mode answers on every Site's domain: a path the Install keeps (`/_…`). */
export const EDIT_MODE_PATH = "/_webcraft/edit/";

/**
 * Where Code mode's pages find the Site's stylesheet built from the Design system's Draft:
 * `/_webcraft/edit/css/<hash>.css`, served only to Staff in Code mode.
 */
export const CODE_MODE_STYLESHEET_PATH = `${EDIT_MODE_PATH}css/`;

/**
 * Where Code mode's pages find the Drafts of the Site script and page scripts:
 * `/_webcraft/edit/js/<hash>.js`, served only to Staff in Code mode.
 */
export const CODE_MODE_SCRIPT_PATH = `${EDIT_MODE_PATH}js/`;

/**
 * Whether `path` is a path on a Site that Edit mode may open: it starts with one `/`, and holds no
 * query, fragment, backslash or whitespace, so a link can never send the browser anywhere else.
 */
export function isEditPath(path: string): boolean {
	return path.length <= 2000 && /^\/(?![/\\])[^\s\\?#]*$/.test(path);
}

/**
 * Whether `address` is a page of a Site with its query, as Edit mode shows the same page again after
 * a mode switch: a path as `isEditPath` takes them, then at most a query; never a fragment, a
 * backslash or whitespace.
 */
export function isEditPageAddress(address: string): boolean {
	const query = address.indexOf("?");
	return (
		address.length <= 4000 &&
		isEditPath(query < 0 ? address : address.slice(0, query)) &&
		!/[\s\\#]/.test(query < 0 ? "" : address.slice(query))
	);
}

/** A Code-mode source/Placement chain and optional stored or derived selection carried between canvases. */
export function isCodeSelection(selection: string): boolean {
	return (
		selection.length <= 1000 &&
		/^(site|content)(?:\/[A-Za-z0-9_-]{1,64}){0,10}(?:#(?:[A-Za-z0-9_-]{1,64}|@\d+(?:\.\d+)*)(?:\/\d+)?)?$/.test(
			selection,
		)
	);
}

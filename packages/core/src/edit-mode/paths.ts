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

/**
 * Whether `path` is a path on a Site that Edit mode may open: it starts with one `/`, and holds no
 * query, fragment, backslash or whitespace, so a link can never send the browser anywhere else.
 */
export function isEditPath(path: string): boolean {
	return path.length <= 2000 && /^\/(?![/\\])[^\s\\?#]*$/.test(path);
}

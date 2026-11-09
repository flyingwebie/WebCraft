/** What the editing bar's script is given when it is made: the address of its own stylesheet. */
export type EditingBarConfig = { styles: string };

/**
 * The editing bar: WebCraft's own script on a page in Edit mode. It is served as a file from the
 * Site's domain (its source text, `editingBar.toString()`, with its config), so this function must
 * use nothing from outside itself.
 */
export function editingBar(config: EditingBarConfig): void {
	void config;
}

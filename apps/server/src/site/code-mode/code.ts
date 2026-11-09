/** What Code mode's script is given when it is made: the address of its own stylesheet. */
export type CodeModeConfig = { styles: string };

/**
 * Code mode's panels (ADR 0016): WebCraft's own script on a page in Code mode, loaded only there (a
 * page in Content editing never loads it). It is served as a file from the Site's domain, made of
 * this function's source text and its config (`assets.ts` beside the editing bar's), so the function
 * must use nothing from outside itself.
 */
export function codeMode(config: CodeModeConfig): void {
	void config;
}

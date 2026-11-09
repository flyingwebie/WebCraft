import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { type CodeModeConfig, codeMode } from "../code-mode/code.ts";
import { CODE_STYLES } from "../code-mode/styles.ts";
import { type EditingBarConfig, editingBar } from "./bar.ts";
import { BAR_STYLES, PAGE_STYLES } from "./styles.ts";

/** Where the editing bar's files are served on every Site's domain. */
export const EDIT_ASSETS_PATH = "/_webcraft/edit/assets/";

/** One of the editing bar's files: named by the hash of its content, so it never changes. */
export type EditAsset = { name: string; path: string; body: string; contentType: string };

export type EditBarAssets = {
	/** The editing bar's script. */
	script: EditAsset;
	/** The stylesheet the page itself loads in Edit mode. */
	pageStyles: EditAsset;
	/** The stylesheet inside the editing bar's shadow root. */
	barStyles: EditAsset;
	/** Code mode's script (ADR 0016), loaded only on pages in Code mode. */
	codeScript: EditAsset;
	/** The stylesheet inside Code mode's shadow root. */
	codeStyles: EditAsset;
	/**
	 * Co-editing's shared Drafts in the browser (ADR 0025): the module the bar loads to open the page's
	 * Drafts live (`@webcraft/core/draft-document`, built with Yjs into one file).
	 */
	drafts: EditAsset;
	/** Every file by its name. */
	byName: ReadonlyMap<string, EditAsset>;
};

let assets: Promise<EditBarAssets> | undefined;

/**
 * The editing bar's files (ADR 0023: WebCraft's own scripts are served as hashed files from the
 * Site's domain, never inline). They are made once per web process.
 */
export function editBarAssets(): Promise<EditBarAssets> {
	assets ??= makeAssets();
	return assets;
}

async function makeAssets(): Promise<EditBarAssets> {
	const barStyles = await asset("bar", "css", BAR_STYLES, "text/css; charset=utf-8");
	const pageStyles = await asset("page", "css", PAGE_STYLES, "text/css; charset=utf-8");
	const drafts = await asset("drafts", "js", await draftsModule(), "text/javascript; charset=utf-8");
	const config: EditingBarConfig = { styles: barStyles.path, drafts: drafts.path };
	const source = `(${editingBar.toString()})(${JSON.stringify(config)});\n`;
	const script = await asset("bar", "js", source, "text/javascript; charset=utf-8");
	const codeStyles = await asset("code", "css", CODE_STYLES, "text/css; charset=utf-8");
	const codeConfig: CodeModeConfig = { styles: codeStyles.path };
	const codeSource = `(${codeMode.toString()})(${JSON.stringify(codeConfig)});\n`;
	const codeScript = await asset("code", "js", codeSource, "text/javascript; charset=utf-8");
	return {
		script,
		pageStyles,
		barStyles,
		codeScript,
		codeStyles,
		drafts,
		byName: new Map([script, pageStyles, barStyles, codeScript, codeStyles, drafts].map((file) => [file.name, file])),
	};
}

/**
 * The shared-Draft client for the browser as one ES module (`@webcraft/core/draft-document/edit-mode`,
 * with Yjs), bundled by Bun from the sources the web process runs from (its image holds them). Loaded,
 * it hands the client to the editing bar in an event.
 */
async function draftsModule(): Promise<string> {
	const entry = Bun.resolveSync("@webcraft/core/draft-document/edit-mode", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
	const [output] = built.outputs;
	if (!built.success || !output) throw new Error(`The shared-Draft module couldn't be built: ${built.logs.join("; ")}`);
	return output.text();
}

async function asset(stem: string, extension: string, body: string, contentType: string): Promise<EditAsset> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	const hash = Buffer.from(digest).toString("hex").slice(0, 16);
	const name = `${stem}-${hash}.${extension}`;
	return { name, path: `${EDIT_ASSETS_PATH}${name}`, body, contentType };
}

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
	const config: EditingBarConfig = { styles: barStyles.path };
	const source = `(${editingBar.toString()})(${JSON.stringify(config)});\n`;
	const script = await asset("bar", "js", source, "text/javascript; charset=utf-8");
	return {
		script,
		pageStyles,
		barStyles,
		byName: new Map([script, pageStyles, barStyles].map((file) => [file.name, file])),
	};
}

async function asset(stem: string, extension: string, body: string, contentType: string): Promise<EditAsset> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	const hash = Buffer.from(digest).toString("hex").slice(0, 16);
	const name = `${stem}-${hash}.${extension}`;
	return { name, path: `${EDIT_ASSETS_PATH}${name}`, body, contentType };
}

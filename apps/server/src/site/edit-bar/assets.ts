import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import { propsBlockAt } from "@webcraft/renderer/builder";
import { codeKeyEdit } from "../../ui/builder/code-keys.ts";
import { componentScriptSettings } from "../../ui/builder/component-script-settings.ts";
import { editorAccessibility } from "../../ui/builder/editor-accessibility.ts";
import { EDITOR_WIDTHS, editorFit, focusInto } from "../../ui/builder/editor-fit.ts";
import { declareMissingProp } from "../../ui/builder/prop-quick-fix.ts";
import { renderedRanges } from "../../ui/builder/rendered-ranges.ts";

import { type CodeModeConfig, codeMode } from "../code-mode/code.ts";
import { CODE_STYLES } from "../code-mode/styles.ts";
import { type EditingBarConfig, editingBar } from "./bar.ts";
import { pageDetailsPanel } from "./details.ts";
import { imageTools } from "./images.ts";
import { loopTools } from "./loops.ts";
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
	/** The block editor's body part (#79): the module the bar loads on pages showing a body (`body-editor/`). */
	body: EditAsset;
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
	const body = await asset("body", "js", await bodyModule(), "text/javascript; charset=utf-8");
	const layoutStyles = await asset(
		"layout",
		"css",
		`${(await panelsStyles()).replaceAll(":root", ":host")}\n:host {font:14px system-ui,sans-serif} :focus-visible {outline:2px solid var(--primary,#2563eb);outline-offset:3px} @media(pointer:coarse),(max-width:640px){button,[role=treeitem],input,select{min-height:44px}button{min-width:44px}}`,
		"text/css; charset=utf-8",
	);
	const layout = await asset("layout", "js", await layoutModule(), "text/javascript; charset=utf-8");
	const config: EditingBarConfig = {
		layout: layout.path,
		layoutStyles: layoutStyles.path,
		styles: barStyles.path,
		drafts: drafts.path,
		body: body.path,
		codeMinWidth: EDITOR_WIDTHS.min,
	};
	// The bar and its parts, each a self-contained function, in one file: the parts are made by the bar.
	const parts = `{ images: ${imageTools.toString()}, loops: ${loopTools.toString()}, details: ${pageDetailsPanel.toString()}, accessibility: ${editorAccessibility.toString()} }`;
	const source = `(${editingBar.toString()})(${JSON.stringify(config)}, ${parts});\n`;
	const script = await asset("bar", "js", source, "text/javascript; charset=utf-8");
	const codeStyles = await asset("code", "css", `${await panelsStyles()}\n${CODE_STYLES}`, "text/css; charset=utf-8");
	const panels = await asset("panels", "js", await panelsModule(drafts.path), "text/javascript; charset=utf-8");
	const codeConfig: CodeModeConfig = { styles: codeStyles.path, panels: panels.path, widths: EDITOR_WIDTHS };
	// The window-width rules shared with the Builder, each a self-contained function.
	const fitting = `{ editorFit: ${editorFit.toString()}, focusInto: ${focusInto.toString()} }`;
	const codeSource = `(${codeMode.toString()})(${JSON.stringify(codeConfig)}, ${componentScriptSettings.toString()}, ${renderedRanges.toString()}, ${editorAccessibility.toString()}, ${codeKeyEdit.toString()}, ${fitting}, { declare: ${declareMissingProp.toString()}, blockAt: ${propsBlockAt.toString()} });\n`;
	const codeScript = await asset("code", "js", codeSource, "text/javascript; charset=utf-8");
	return {
		script,
		pageStyles,
		barStyles,
		codeScript,
		codeStyles,
		drafts,
		body,
		byName: new Map(
			[script, pageStyles, barStyles, codeScript, codeStyles, drafts, body, panels, layout, layoutStyles].map(
				(file) => [file.name, file],
			),
		),
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

/**
 * The block editor's body part as one ES module (`body-editor/edit-mode.ts`, with the editor model it
 * shares with the admin), bundled by Bun from the sources the web process runs from. Loaded, it hands
 * the part to the editing bar in an event.
 */
async function bodyModule(): Promise<string> {
	// Resolved through the server package's own name, so it is found from the built bundle too.
	const entry = Bun.resolveSync("@webcraft/server/body-editor/edit-mode", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
	const [output] = built.outputs;
	if (!built.success || !output)
		throw new Error(`The block editor's module couldn't be built: ${built.logs.join("; ")}`);
	return output.text();
}

async function asset(stem: string, extension: string, body: string, contentType: string): Promise<EditAsset> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	const hash = Buffer.from(digest).toString("hex").slice(0, 16);
	const name = `${stem}-${hash}.${extension}`;
	return { name, path: `${EDIT_ASSETS_PATH}${name}`, body, contentType };
}

async function panelsModule(draftsPath: string): Promise<string> {
	const entry = Bun.resolveSync("@webcraft/server/editor/live-panels", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "esm",
		minify: true,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		plugins: [
			{
				name: "shared-draft-module",
				setup(build) {
					build.onResolve({ filter: /^@webcraft\/core\/draft-document$/ }, () => ({
						path: draftsPath,
						external: true,
					}));
				},
			},
		],
	});
	const [output] = built.outputs;
	if (!built.success || !output) throw new Error(`The editor panels couldn't be built: ${built.logs.join("; ")}`);
	return output.text();
}

/** The same theme and utilities as the Builder, isolated inside Code mode's shadow root. */
async function panelsStyles(): Promise<string> {
	const base = dirname(fileURLToPath(import.meta.url));
	const theme = Bun.resolveSync("@webcraft/ui/globals.css", base);
	const entry = Bun.resolveSync("@webcraft/server/editor/live-panels", base);
	// The Site editor uses the system font; font files belong to the admin's asset pipeline.
	const css = (await Bun.file(theme).text()).replace('@import "@fontsource-variable/inter";', "");
	const compiled = await compile(css, { base: dirname(theme), onDependency() {} });
	const scanner = new Scanner({
		sources: [...compiled.sources, { base: dirname(dirname(entry)), pattern: "**/*.{ts,tsx}", negated: false }],
	});
	return optimize(compiled.build(scanner.scan()), { minify: true }).code;
}

async function layoutModule(): Promise<string> {
	const entry = Bun.resolveSync("@webcraft/server/editor/page-layouts", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "esm",
		minify: true,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
	});
	const output = built.outputs[0];
	if (!built.success || !output) throw new Error(`Page layout tools could not be built: ${built.logs.join("; ")}`);
	return output.text();
}

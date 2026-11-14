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
import { FORMAT_SHOWN_MS, FORMAT_SPINNER_MS, formatTextArea, isFormatKey } from "../../ui/code-format/box.ts";
import { COMMAND_MENU_MIN_WIDTH } from "../../ui/edit-mode/width.ts";

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
	/** Format's engine (Prettier, `ui/code-format/engine.ts`): loaded the first time Format is used. */
	format: EditAsset;
	/** Every file by its name. */
	byName: ReadonlyMap<string, EditAsset>;
};

/**
 * How the editing bar's script and Code mode's load a module by its address: the browser's own
 * `import()`, handed to each as its last argument.
 *
 * It is written here as text, never inside the functions those scripts are made of. `bun run dev`
 * runs this process's code through the dev server's module transform, which rewrites what only a
 * module may hold (`import()`, `import.meta`) into helpers that exist on the server alone
 * (`__vite_ssr_dynamic_import__`, …). A function's source text would carry that name into the
 * browser, where nothing answers to it; the production build leaves both as they are, so only the dev
 * server would show it. Text is never rewritten. `tests/edit-mode/served-scripts.test.ts` puts the
 * served scripts through that transform and fails on anything else it would rewrite.
 */
const LOAD_MODULE = "(address) => import(address)";

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
	// Format's engine (Prettier), a file of its own: loaded only the first time Format is used.
	const format = await asset("format", "js", await formatModule(), "text/javascript; charset=utf-8");
	const body = await asset("body", "js", await bodyModule(), "text/javascript; charset=utf-8");
	// Edit mode's own tools (the Page layout's and the Command menu) share one stylesheet, each in a
	// shadow root of its own. The Command menu's dialogs lie over the editing bar, as Code mode's do.
	const toolsStyles = await asset(
		"tools",
		"css",
		`${(await panelsStyles()).replaceAll(":root", ":host")}\n:host {font:14px system-ui,sans-serif} :focus-visible {outline:2px solid var(--primary,#2563eb);outline-offset:3px} @media(pointer:coarse),(max-width:640px){button,[role=treeitem],input,select{min-height:44px}button{min-width:44px}} :host(#webcraft-edit-commands) [data-slot=dialog-overlay]{z-index:2147483000} :host(#webcraft-edit-commands) [data-slot=dialog-content]{z-index:2147483001;max-height:80vh;overflow:auto}`,
		"text/css; charset=utf-8",
	);
	const tools = await asset("tools", "js", await toolsModule(format.path), "text/javascript; charset=utf-8");
	const history = await asset(
		"history",
		"js",
		await historyModule(drafts.path, format.path),
		"text/javascript; charset=utf-8",
	);
	const config: EditingBarConfig = {
		history: history.path,
		tools: tools.path,
		toolsStyles: toolsStyles.path,
		styles: barStyles.path,
		drafts: drafts.path,
		body: body.path,
		codeMinWidth: EDITOR_WIDTHS.min,
		menuMinWidth: COMMAND_MENU_MIN_WIDTH,
	};
	// The bar and its parts, each a self-contained function, in one file: the parts are made by the bar.
	const parts = `{ images: ${imageTools.toString()}, loops: ${loopTools.toString()}, details: ${pageDetailsPanel.toString()}, accessibility: ${editorAccessibility.toString()} }`;
	const source = `(${editingBar.toString()})(${JSON.stringify(config)}, ${parts}, ${LOAD_MODULE});\n`;
	const script = await asset("bar", "js", source, "text/javascript; charset=utf-8");
	const codeStyles = await asset("code", "css", `${await panelsStyles()}\n${CODE_STYLES}`, "text/css; charset=utf-8");
	const panels = await asset(
		"panels",
		"js",
		await panelsModule(drafts.path, format.path),
		"text/javascript; charset=utf-8",
	);
	const codeConfig: CodeModeConfig = {
		styles: codeStyles.path,
		panels: panels.path,
		format: format.path,
		widths: EDITOR_WIDTHS,
	};
	// The window-width rules shared with the Builder, each a self-contained function.
	const fitting = `{ editorFit: ${editorFit.toString()}, focusInto: ${focusInto.toString()} }`;
	const formatting = `{ formatTextArea: ${formatTextArea.toString()}, isFormatKey: ${isFormatKey.toString()}, shownMs: ${FORMAT_SHOWN_MS}, spinnerMs: ${FORMAT_SPINNER_MS} }`;
	const codeSource = `(${codeMode.toString()})(${JSON.stringify(codeConfig)}, ${componentScriptSettings.toString()}, ${renderedRanges.toString()}, ${editorAccessibility.toString()}, ${codeKeyEdit.toString()}, ${fitting}, { declare: ${declareMissingProp.toString()}, blockAt: ${propsBlockAt.toString()} }, ${formatting}, ${LOAD_MODULE});\n`;
	const codeScript = await asset("code", "js", codeSource, "text/javascript; charset=utf-8");
	return {
		script,
		pageStyles,
		barStyles,
		codeScript,
		codeStyles,
		drafts,
		body,
		format,
		byName: new Map(
			[
				script,
				pageStyles,
				barStyles,
				codeScript,
				codeStyles,
				drafts,
				body,
				panels,
				tools,
				toolsStyles,
				history,
				format,
			].map((file) => [file.name, file]),
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

/**
 * Format's engine as one ES module (`ui/code-format/engine.ts`: Prettier's standalone build with its
 * HTML, CSS and JavaScript parsers), bundled by Bun from the sources the web process runs from.
 * Code mode's script and the shared panels load it the first time Format is used (`formatEngine`).
 */
async function formatModule(): Promise<string> {
	const entry = Bun.resolveSync("@webcraft/server/editor/code-format", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
	const [output] = built.outputs;
	if (!built.success || !output) throw new Error(`Format's engine couldn't be built: ${built.logs.join("; ")}`);
	return output.text();
}

/**
 * Makes the shared panels load Format's engine from its own file when Format is first used, rather
 * than carry Prettier in their bundle (`format.ts` imports `./engine.ts` on demand).
 */
export function formatEngine(formatPath: string): Bun.BunPlugin {
	return {
		name: "format-engine-file",
		setup(build) {
			build.onResolve({ filter: /^\.\/engine\.ts$/ }, (found) =>
				/[\\/]code-format[\\/]format\.ts$/.test(found.importer) ? { path: formatPath, external: true } : undefined,
			);
		},
	};
}

/** Makes a module import the shared-Draft module the bar already loads, so each page has Yjs once. */
function sharedDrafts(draftsPath: string): Bun.BunPlugin {
	return {
		name: "shared-draft-module",
		setup(build) {
			build.onResolve({ filter: /^@webcraft\/core\/draft-document$/ }, () => ({
				path: draftsPath,
				external: true,
			}));
		},
	};
}

async function panelsModule(draftsPath: string, formatPath: string): Promise<string> {
	const entry = Bun.resolveSync("@webcraft/server/editor/live-panels", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "esm",
		minify: true,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		plugins: [sharedDrafts(draftsPath), formatEngine(formatPath)],
	});
	const [output] = built.outputs;
	if (!built.success || !output) throw new Error(`The editor panels couldn't be built: ${built.logs.join("; ")}`);
	return output.text();
}

/**
 * The Undo history in Edit mode as one ES module (`ui/edit-history/edit-mode.ts`, ADR 0036), bundled
 * by Bun from the sources the web process runs from. Loaded, it hands itself to the editing bar in an
 * event. It is a file of its own, loaded on every page in Edit mode, so the page holds one history.
 */
async function historyModule(draftsPath: string, formatPath: string): Promise<string> {
	const entry = Bun.resolveSync("@webcraft/server/editor/edit-history", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "esm",
		minify: true,
		plugins: [sharedDrafts(draftsPath), formatEngine(formatPath)],
	});
	const [output] = built.outputs;
	if (!built.success || !output)
		throw new Error(`The Undo history's module couldn't be built: ${built.logs.join("; ")}`);
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

/**
 * Edit mode's own tools as one ES module (`ui/edit-mode/tools.ts`): the Page layout's and the Command
 * menu, sharing one copy of what they are both made with. Loaded, each hands itself to the editing bar
 * in an event.
 */
async function toolsModule(formatPath: string): Promise<string> {
	const entry = Bun.resolveSync("@webcraft/server/editor/edit-tools", dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "esm",
		minify: true,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		plugins: [formatEngine(formatPath)],
	});
	const output = built.outputs[0];
	if (!built.success || !output) throw new Error(`Edit mode's tools couldn't be built: ${built.logs.join("; ")}`);
	return output.text();
}

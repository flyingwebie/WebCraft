import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, optimize } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

import { EDIT_ASSETS_PATH, editBarAssets, formatEngine } from "../edit-bar/assets.ts";

/** One of the building area's files: named by the hash of its content, so it never changes. */
export type BuildingAreaAsset = {
	name: string;
	path: string;
	body: string | Uint8Array<ArrayBuffer>;
	contentType: string;
};

export type BuildingAreaAssets = {
	/** The shell (React), an ES module. */
	shell: BuildingAreaAsset;
	/** The shell's stylesheet: the admin's theme compiled for the shell's own classes, with Inter. */
	shellStyles: BuildingAreaAsset;
	/** The page agent, a classic script: the first script of every page shown in the frame. */
	agent: BuildingAreaAsset;
	/** The little the framed page itself needs styled (outside scripts' placeholders). */
	agentStyles: BuildingAreaAsset;
	/** Inter's files, which the shell's stylesheet names. */
	fonts: readonly BuildingAreaAsset[];
	/** Every file by its name. */
	byName: ReadonlyMap<string, BuildingAreaAsset>;
};

/** The stems the building area's files are named with, so a request for one makes only these. */
const STEMS = ["shell", "agent", "inter"] as const;

/** Whether `name` is one of the building area's files, by its stem (it may still name none). */
export function isBuildingAreaAsset(name: string): boolean {
	return STEMS.some((stem) => name.startsWith(`${stem}-`));
}

let assets: Promise<BuildingAreaAssets> | undefined;

/**
 * The building area's files (ADR 0037; ADR 0023: WebCraft's own scripts are hashed files on the Site's
 * domain, never inline), served beside the editing bar's at `/_webcraft/edit/assets/<stem>-<hash>`.
 * They are made once per web process, the first time something asks for one of them.
 */
export function buildingAreaAssets(): Promise<BuildingAreaAssets> {
	assets ??= makeAssets().catch((error) => {
		// A failed build is tried again on the next request rather than kept.
		assets = undefined;
		throw error;
	});
	return assets;
}

async function makeAssets(): Promise<BuildingAreaAssets> {
	const base = dirname(fileURLToPath(import.meta.url));
	const theme = Bun.resolveSync("@webcraft/ui/globals.css", base);
	const fonts = await Promise.all(
		INTER_FILES.map(async ({ file }) => {
			const path = Bun.resolveSync(`@fontsource-variable/inter/files/${file}`, dirname(theme));
			return asset("inter", "woff2", new Uint8Array(await Bun.file(path).arrayBuffer()), "font/woff2");
		}),
	);
	// Format's engine (Prettier) is the editing bar's file of its own, loaded the first time Format is used.
	const { format } = await editBarAssets();
	const [shellCode, agentCode, styles] = await Promise.all([
		bundle("@webcraft/server/building-area/shell", "esm", [formatEngine(format.path)]),
		bundle("@webcraft/server/building-area/agent", "iife"),
		shellStylesheet(theme, fonts),
	]);
	const shell = await asset("shell", "js", shellCode, "text/javascript; charset=utf-8");
	const agent = await asset("agent", "js", agentCode, "text/javascript; charset=utf-8");
	const shellStyles = await asset("shell", "css", styles, "text/css; charset=utf-8");
	const agentStyles = await asset("agent", "css", AGENT_STYLES, "text/css; charset=utf-8");
	return {
		shell,
		shellStyles,
		agent,
		agentStyles,
		fonts,
		byName: new Map([shell, shellStyles, agent, agentStyles, ...fonts].map((file) => [file.name, file])),
	};
}

/** Inter, Latin and Latin Extended, as variable fonts (the admin's typeface, served from the Site's address). */
const INTER_FILES = [
	{
		file: "inter-latin-wght-normal.woff2",
		range:
			"U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
	},
	{
		file: "inter-latin-ext-wght-normal.woff2",
		range:
			"U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
	},
] as const;

/**
 * One of the building area's sources bundled by Bun, through the server package's own name so it is
 * found from the built bundle too: the shell as an ES module, the agent as a classic script (it must
 * run before any Site script, so it imports nothing at run time).
 */
async function bundle(entryName: string, format: "esm" | "iife", plugins: Bun.BunPlugin[] = []): Promise<string> {
	const entry = Bun.resolveSync(entryName, dirname(fileURLToPath(import.meta.url)));
	const built = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format,
		minify: true,
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		plugins,
	});
	const [output] = built.outputs;
	if (!built.success || !output) throw new Error(`${entryName} couldn't be built: ${built.logs.join("; ")}`);
	return output.text();
}

/**
 * The shell's stylesheet: the admin's theme (Tailwind and the shadcn tokens) compiled for the classes
 * the building area's own sources use, with Inter served as files from the Site's address.
 */
async function shellStylesheet(theme: string, fonts: readonly BuildingAreaAsset[]): Promise<string> {
	const base = dirname(fileURLToPath(import.meta.url));
	const shellEntry = Bun.resolveSync("@webcraft/server/building-area/shell", base);
	// The chrome's own colours (SPEC 4) come after the admin's theme, as Tailwind colours of their own.
	const chrome = await Bun.file(join(dirname(shellEntry), "theme.css")).text();
	const css = `${(await Bun.file(theme).text()).replace('@import "@fontsource-variable/inter";', "")}\n${chrome}`;
	const compiled = await compile(css, { base: dirname(theme), onDependency() {} });
	// The shell's own sources, and the admin's parts it reuses as they are (the Media library's, BA-22,
	// a Form field's settings, BA-26, with the shared components they draw with).
	const reused = [
		join(dirname(shellEntry), "..", "media"),
		join(dirname(shellEntry), "..", "forms"),
		join(dirname(theme), "..", "components"),
	];
	const scanner = new Scanner({
		sources: [dirname(shellEntry), ...reused].map((base) => ({ base, pattern: "**/*.{ts,tsx}", negated: false })),
	});
	const faces = INTER_FILES.map(
		({ range }, index) =>
			`@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url(${fonts[index]?.path}) format("woff2-variations");unicode-range:${range}}`,
	).join("");
	return `${faces}\n${optimize(compiled.build(scanner.scan()), { minify: true }).code}\n${SHELL_DOCUMENT_STYLES}`;
}

/** The shell document's own base, and the page that sends a browser outside the building area to the admin. */
const SHELL_DOCUMENT_STYLES = `body.wc-shell{margin:0;background:#121214;color:#e4e4e7;font-family:"Inter Variable",sans-serif}
.wc-signed-out{max-width:32rem;margin:15vh auto 0;padding:0 16px;font-size:14px;line-height:1.5}
.wc-signed-out h1{margin:0 0 12px;font-size:20px;font-weight:600;color:#fafafa}
.wc-signed-out p{margin:0 0 12px}
.wc-signed-out a{color:#a5b4fc;text-decoration:underline}
.wc-signed-out a:focus-visible{outline:2px solid #818cf8;outline-offset:2px;border-radius:2px}`;

/**
 * What the framed page needs from WebCraft: outside scripts' placeholders (ADR 0022), as the editing
 * bar's page stylesheet styles them, and room for an empty image or link region to be found and
 * clicked, with the words the shell gives it (`data-wc-empty-label`, BA-15). Everything else with
 * chrome is drawn by the shell, over the frame.
 */
const AGENT_STYLES = `.wc-outside-scripts {
	margin: 2rem auto; max-width: 48rem; padding: 0.75rem 1rem;
	border: 1px dashed #71717a; border-radius: 0.75rem;
	background: #f4f4f5; color: #3f3f46; font: 500 14px/1.4 ui-sans-serif, system-ui, sans-serif;
}
.wc-outside-scripts ul { margin: 0; padding: 0; list-style: none; }
.wc-outside-script { padding: 0.25rem 0; }
.wc-outside-script-name { font-weight: 700; }
.wc-outside-script-note { color: #52525b; }
@media (prefers-color-scheme: dark) {
	.wc-outside-scripts { background: #27272a; color: #e4e4e7; border-color: #a1a1aa; }
	.wc-outside-script-note { color: #d4d4d8; }
}
[data-wc-type="media"][data-wc-item]:not(img):empty {
	display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
	min-width: 12rem; min-height: 8rem; padding: 1rem; border-radius: 0.5rem;
	background: #eef2ff; color: #3730a3; font: 500 14px/1.4 ui-sans-serif, system-ui, sans-serif;
}
[data-wc-type="media"][data-wc-item]:not(img):empty::after { content: attr(data-wc-empty-label); }
a[data-wc-type="link"][data-wc-item]:empty { display: inline-block; min-width: 6rem; min-height: 1.5em; }
a[data-wc-type="link"][data-wc-item]:empty::after { content: attr(data-wc-empty-label); }
`;

async function asset(
	stem: (typeof STEMS)[number],
	extension: string,
	body: string | Uint8Array<ArrayBuffer>,
	contentType: string,
): Promise<BuildingAreaAsset> {
	const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hash = Buffer.from(digest).toString("hex").slice(0, 16);
	const name = `${stem}-${hash}.${extension}`;
	return { name, path: `${EDIT_ASSETS_PATH}${name}`, body, contentType };
}

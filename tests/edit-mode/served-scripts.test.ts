// The editing bar's script and Code mode's script are made of functions' source text (see "The editing
// bar" in docs/development.md). `bun run dev` runs the web process's own code through the dev server's
// module transform before it runs, and that transform rewrites what only a module may hold (`import()`,
// `import.meta`) into helpers that exist on the server alone (`__vite_ssr_dynamic_import__`, …). A
// function holding one of them is then served with the helper's name in its text and fails in the
// browser, under `bun run dev` only: the production build leaves them as they are. So these tests put
// the functions, as a Site serves them, through that same transform and fail on anything it rewrites.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { headOf, openCodeMode } from "../harness/code-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

/** The dev server's own transform of a module's code, from the Vite the web process runs under. */
type ModuleTransform = (code: string, map: null, url: string, original: string) => Promise<{ code: string } | null>;
const { moduleRunnerTransform } = (await import(Bun.resolveSync("vite", join(ROOT, "apps/server")))) as {
	moduleRunnerTransform: ModuleTransform;
};

/** What the dev server would rewrite in code into something only the server has: the text around each place. */
async function serverOnlyIn(code: string): Promise<string[]> {
	const transformed = (await moduleRunnerTransform(code, null, "/served.js", code))?.code ?? "";
	return [...transformed.matchAll(/.{0,40}__vite_ssr_\w+.{0,40}/g)].map(([found]) => found.trim());
}

/**
 * How a script loads a module: the browser's own `import()`, which the web process writes after the
 * functions, as text. The dev server's transform reads code, never text, so this one stays as it is.
 */
const LOADER = "(address) => import(address)";

/** The functions a script is made of: all of it but the loader it is handed last. */
function functionsOf(script: string): string {
	const end = `, ${LOADER});\n`;
	if (!script.endsWith(end)) throw new Error(`The script doesn't end with its loader, ${LOADER}`);
	return `${script.slice(0, -end.length)});\n`;
}

let install: TestInstall;
/** The scripts a page in Code mode loads from the Site, by the name before their hash: the editing bar's, then Code mode's. */
const served = new Map<string, string>();

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });

	const coding = await openCodeMode(install, staff, siteId, "/blog/fresh-bread");
	const head = headOf(await (await coding.page("/blog/fresh-bread")).text());
	for (const [, src = "", name = ""] of head.matchAll(/<script src="(\/_webcraft\/edit\/assets\/([a-z]+)-[^"]+)"/g)) {
		const response = await coding.browser.request(`${coding.origin}${src}`);
		expect(response.status).toBe(200);
		served.set(name, await response.text());
	}
});

afterAll(async () => {
	await install.close();
});

describe("the editor's scripts, served as functions' source text", () => {
	test("the check sees what the dev server rewrites, and only that", async () => {
		const loading = await serverOnlyIn("(function load(config) { return import(config.panels); })({});");
		expect(loading).toHaveLength(1);
		expect(loading[0]).not.toContain("import(");
		expect(await serverOnlyIn("(function where() { return import.meta.url; })();")).toHaveLength(1);
		// Text and comments are never rewritten.
		expect(await serverOnlyIn("(function words() { return 'import(x)'; /* import.meta */ })();")).toEqual([]);
	});

	test("a page in Code mode loads the editing bar's script and Code mode's, and no other made this way", () => {
		// A new script made of functions' source text gets its own test below.
		expect([...served.keys()]).toEqual(["bar", "code"]);
	});

	test("the editing bar's functions hold nothing the dev server rewrites", async () => {
		expect(await serverOnlyIn(functionsOf(served.get("bar") ?? ""))).toEqual([]);
	});

	test("Code mode's functions hold nothing the dev server rewrites", async () => {
		expect(await serverOnlyIn(functionsOf(served.get("code") ?? ""))).toEqual([]);
	});
});

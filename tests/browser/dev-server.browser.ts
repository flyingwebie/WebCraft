// The on-site editor under the dev server (`bun run dev`). Every other browser check runs the
// production web process; this one starts the web process as `bun run dev` does, because the dev
// server runs the web process's own code through its module transform first, and what that rewrites
// can reach the browser: the editing bar's script and Code mode's are served as functions' source
// text. A name only the server has (`__vite_ssr_…`) in them stops the bar opening the page's Drafts
// live, and Code mode mounting its Layers, Insert, Inspector, CSS panel, Command menu and Undo, on the
// dev server alone. So: the editor loads all its parts there, from scripts holding no such name.
// Looks and the keyboard are checked on the production web process (edit-mode, code-mode, code-layers).
// The building area's shell is bundled with its code split (BA-30): its places come as files of their
// own through `import()`, which must reach the browser as written there too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestBrowser } from "../harness/browser.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
/** Staff's browser on the dev server's own admin, signed in: "Edit on site" gives its links. */
let admin: TestBrowser;
let siteId: string;
let entryId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall({ devServer: true });
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const staff = (await local.createStaff({ workspaces: [workspaceId] })).account;

	await api.designSystem.createClass({ siteId, name: "hero", styles: "padding: var(--space-m);" });
	await api.designSystem.publish({ siteId });
	const { component } = await api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", required: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<section class="hero"><h1>{{ props.heading }}</h1></section>',
	});
	await api.components.publish({ siteId, componentId: component.id });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<article><Hero heading="{{ title }}" /><p>{{ subtitle }}</p></article>',
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	entryId = entry.id;
	await api.entries.publish({ siteId, entryId });
	await api.forms.create({ siteId, name: "Contact" });

	admin = install.webBrowser();
	await admin.api.session.signIn(staff);
}, 300_000);

afterAll(async () => {
	await install?.close();
});

/**
 * The page in Edit mode, as "Edit on site" opens it: the admin gives a link and the page follows it.
 * `scripts` fills with the addresses of the editor's own scripts the page loads from the Site, and
 * `drafts` with the Drafts it opens live: how many messages each one's socket received, by its path.
 */
async function editModePage(): Promise<{ page: Page; scripts: Set<string>; drafts: Map<string, number> }> {
	const page = await install.newPage("light");
	page.setDefaultTimeout(30_000);
	const scripts = new Set<string>();
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname.startsWith("/_webcraft/edit/assets/") && url.pathname.endsWith(".js")) scripts.add(url.href);
	});
	const drafts = new Map<string, number>();
	page.on("websocket", (socket) => {
		const at = new URL(socket.url()).pathname;
		if (!at.startsWith("/_webcraft/edit/drafts/")) return;
		drafts.set(at, drafts.get(at) ?? 0);
		socket.on("framereceived", () => drafts.set(at, (drafts.get(at) ?? 0) + 1));
	});
	const { url } = await admin.api.editMode.open({ siteId, path });
	await page.goto(url);
	await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
	return { page, scripts, drafts };
}

/** Waits up to 30 seconds for `done` to hold, and answers whether it did. */
async function eventually(done: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 30_000;
	while (!done() && Date.now() < deadline) await Bun.sleep(100);
	return done();
}

/**
 * The editor's scripts that carry a name only the dev server's transform gives, each with those names,
 * read again from the Site as they were served. `loaded` are the files the page must have asked for.
 */
async function serverOnlyNames(page: Page, scripts: ReadonlySet<string>, loaded: string[]): Promise<object> {
	const files = [...scripts].map((url) => new URL(url).pathname.split("/").pop() ?? "");
	for (const stem of loaded)
		expect(files).toContainEqual(expect.stringMatching(new RegExp(`^${stem}-[0-9a-f]{16}\\.js$`)));
	const found: Record<string, string[]> = {};
	for (const url of scripts) {
		const response = await page.request.get(url);
		expect(response.status()).toBe(200);
		const names = (await response.text()).match(/__vite_ssr_\w+/g);
		if (names) found[new URL(url).pathname] = [...new Set(names)];
	}
	return found;
}

describe("the on-site editor under the dev server", () => {
	test("the editing bar's script and Code mode's hold no name only the dev server gives", async () => {
		const { page, scripts } = await editModePage();
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" }).waitFor();

		// The two scripts made of functions' source text, which the page loads first.
		expect(await serverOnlyNames(page, scripts, ["bar", "code"])).toEqual({});
		await page.close();
	});

	test("the editing bar loads its modules and opens the page's Drafts live", async () => {
		const { page, scripts, drafts } = await editModePage();

		// The shared-Draft module: the bar opens the Entry's Draft with it, and the Draft arrives.
		const entryDraft = `/_webcraft/edit/drafts/entry/${entryId}`;
		await eventually(() => (drafts.get(entryDraft) ?? 0) > 0);
		expect([...drafts]).toContainEqual([entryDraft, expect.any(Number)]);
		expect(drafts.get(entryDraft)).toBeGreaterThan(0);
		// The Undo history's module and Edit mode's tools (the Command menu names its own button).
		await page.getByRole("button", { name: /^Undo/ }).waitFor();
		await page.getByRole("button", { name: /^Command menu/ }).waitFor();

		expect(await serverOnlyNames(page, scripts, ["bar", "drafts", "history", "tools"])).toEqual({});
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});

	test("Code mode mounts its panels", async () => {
		const { page, scripts } = await editModePage();
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" }).waitFor();

		// The shared panels' module: Layers with Insert, the Inspector, the CSS panel, and what the
		// panels' top line takes from it (the Command menu, Undo, "Open in builder").
		await page.getByRole("tree", { name: "Layers" }).waitFor();
		await page.getByRole("button", { name: "Heading", exact: true }).waitFor();
		await page.getByRole("heading", { name: "Settings" }).waitFor();
		await page.getByRole("tab", { name: /Site CSS/ }).waitFor();
		await page.getByRole("button", { name: "Command menu" }).waitFor();
		await page.getByRole("button", { name: /^Undo/ }).waitFor();
		await page.getByRole("button", { name: "Open in builder" }).and(page.locator(":enabled")).waitFor();

		expect(await serverOnlyNames(page, scripts, ["bar", "code", "panels", "drafts"])).toEqual({});
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});
});

describe("the building area under the dev server", () => {
	test("the shell loads, and each place's file comes when the place opens, holding no name only the dev server gives", async () => {
		const page = await install.newPage("light");
		page.setDefaultTimeout(30_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		const scripts = new Set<string>();
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (/^\/_webcraft\/edit\/assets\/shell-[^/]+\.js$/.test(url.pathname)) scripts.add(url.href);
		});
		const { url } = await admin.api.editMode.open({ siteId, open: `/page${path}` });
		await page.goto(url);
		await page.locator("iframe[data-wc-frame]").waitFor();
		await page.locator('[data-wc-place="content"]').waitFor();
		// The first file and Staff's shell with what it shares; no place yet.
		const first = [...scripts].map((each) => new URL(each).pathname.split("/").pop() ?? "");
		expect(first).toContainEqual(expect.stringMatching(/^shell-Shell-[0-9a-f]{16}\.js$/));
		expect(first.filter((name) => /Place-/.test(name))).toEqual([]);

		for (const [place, ready] of [
			["content", "[data-wc-content-lists]"],
			["forms", "[data-wc-forms-notice], [data-wcb-styled]"],
		] as const) {
			if (place === "forms") {
				await page.locator('[data-wc-place="more"]').click();
				await page.locator('[data-wc-choice="forms"]').click();
			} else {
				await page.locator(`[data-wc-place="${place}"]`).click();
			}
			await page.locator(ready).first().waitFor();
			await page.locator("[data-wc-place-back]").click();
			await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });
		}
		const files = [...scripts].map((each) => new URL(each).pathname.split("/").pop() ?? "");
		expect(files).toContainEqual(expect.stringMatching(/^shell-ContentPlace-[0-9a-f]{16}\.js$/));
		expect(files).toContainEqual(expect.stringMatching(/^shell-FormsPlace-[0-9a-f]{16}\.js$/));
		const found: Record<string, string[]> = {};
		for (const each of scripts) {
			const response = await page.request.get(each);
			expect(response.status()).toBe(200);
			const names = (await response.text()).match(/__vite_ssr_\w+/g);
			if (names) found[new URL(each).pathname] = [...new Set(names)];
		}
		expect(found).toEqual({});
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});
});

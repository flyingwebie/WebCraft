// The building area under the dev server (`bun run dev`). Every other browser check runs the
// production web process; this one starts the web process as `bun run dev` does, because the dev
// server runs the web process's own code through its module transform first, and what that rewrites
// (`import()`, `import.meta` into names only the server has, `__vite_ssr_…`) must never reach the
// browser. The shell is bundled with its code split (BA-30): its places come as files of their own
// through `import()`, which must reach the browser as written; the page agent and the shell's other
// files hold no such name either.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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

describe("the building area under the dev server", () => {
	test("the shell loads, and each place's file comes when the place opens, holding no name only the dev server gives", async () => {
		const page = await install.newPage("light");
		page.setDefaultTimeout(30_000);
		await page.setViewportSize({ width: 1440, height: 900 });
		const scripts = new Set<string>();
		page.on("request", (request) => {
			const url = new URL(request.url());
			if (/^\/_webcraft\/edit\/assets\/[^/]+\.js$/.test(url.pathname)) scripts.add(url.href);
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
		expect(files).toContainEqual(expect.stringMatching(/^agent-[0-9a-f]{16}\.js$/));
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

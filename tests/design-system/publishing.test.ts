// The Design system has a Draft and is published as one item (spec story 70): Staff change tokens,
// Classes, base styles, custom CSS and dark mode in the Draft, visitors see nothing of it until it
// is published, and publishing changes every page's stylesheet at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { layerOf, pageWithStyles, stylesheetIn } from "../harness/site-styles.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let sites = 0;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A new Site with a published blog post at /blog/fresh-bread. */
async function siteWithPost() {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, url: `https://${slug}.sites.test/blog/fresh-bread` };
}

describe("the Draft", () => {
	test("a Site starts with the default Design system, never published", async () => {
		const { siteId } = await siteWithPost();

		const { designSystem } = await staff.api.designSystem.get({ siteId });

		expect(designSystem.status).toBe("draft");
		expect(designSystem.published).toBeNull();
		expect(designSystem.publishedAt).toBeNull();
		expect(designSystem.draft.darkMode).toBe(false);
		expect(designSystem.draft.classes).toEqual([]);
		expect(designSystem.draft.tokens.colours.map((colour) => colour.name)).toEqual([
			"primary",
			"secondary",
			"accent",
			"neutral",
		]);
		expect(designSystem.draft.baseStyles.body).toContain("font-family: var(--font-body)");
		expect(designSystem.draft.customCss).toBe("");
	});

	test("changes nothing visitors see until it is published; then every page links the new stylesheet", async () => {
		const { siteId, url } = await siteWithPost();
		const before = await pageWithStyles(install, url);
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		const primary = designSystem.draft.tokens.colours.find((colour) => colour.name === "primary");
		if (!primary) throw new Error("No primary colour.");

		const saved = await staff.api.designSystem.saveDraft({
			siteId,
			tokens: {
				...designSystem.draft.tokens,
				colours: designSystem.draft.tokens.colours.map((colour) =>
					colour.id === primary.id ? { ...colour, light: { ...colour.light, base: "#c2410c" } } : colour,
				),
			},
			customCss: "main { padding-block: var(--space-l); }",
		});

		expect(saved.designSystem.status).toBe("draft");
		expect((await pageWithStyles(install, url)).css).toBe(before.css);

		const { published } = await staff.api.designSystem.publish({ siteId });
		expect(published.kind).toBe("designSystem");

		const after = await pageWithStyles(install, url);
		expect(stylesheetIn(after.html)).not.toBe(stylesheetIn(before.html));
		expect(layerOf(after.css, "tokens")).toContain("--primary-60:#c2410c;");
		expect(layerOf(after.css, "custom")).toBe("main{padding-block:var(--space-l)}");
		const read = await staff.api.designSystem.get({ siteId });
		expect(read.designSystem.status).toBe("published");
		expect(read.designSystem.published).toEqual(read.designSystem.draft);
		expect(read.designSystem.publishedAt).not.toBeNull();
	});

	test("a page loaded just before a publish still finds the stylesheet it links", async () => {
		const { siteId, url } = await siteWithPost();
		const before = await pageWithStyles(install, url);

		await staff.api.designSystem.saveDraft({ siteId, customCss: "h1 { letter-spacing: 0.01em; }" });
		await staff.api.designSystem.publish({ siteId });

		const old = await install.request(new URL(stylesheetIn(before.html), url).href);
		expect(old.status).toBe(200);
		expect(await old.text()).toBe(before.css);
	});

	test("two publishes at once never lose the stylesheet that was live between them", async () => {
		// Two Entry templates whose inline styles each add a Class: publishing one changes the stylesheet.
		const styles = ["color: rgb(1, 2, 3)", "color: rgb(4, 5, 6)"] as const;
		const prepare = async () => {
			const { siteId, url } = await siteWithPost();
			const templateIds = await Promise.all(
				styles.map(async (style, index) => {
					const { postType } = await staff.api.postTypes.create({
						siteId,
						name: `Notes ${index}`,
						urlPattern: `/notes-${index}/{slug}`,
					});
					const { template } = await staff.api.templates.saveEntryTemplateMarkup({
						siteId,
						postTypeId: postType.id,
						markup: `<p style="${style}">{{ title }}</p>`,
					});
					return template.id;
				}),
			);
			return { siteId, url, templateIds };
		};
		/** The stylesheet a Site has with only the template at `index` published. */
		const stylesheetWithOnly = async (index: number) => {
			const site = await prepare();
			await staff.api.templates.publish({ siteId: site.siteId, templateId: site.templateIds[index] ?? "" });
			return stylesheetIn(await (await install.request(site.url)).text());
		};
		const alone = [await stylesheetWithOnly(0), await stylesheetWithOnly(1)];

		for (let round = 0; round < 3; round++) {
			const site = await prepare();
			await Promise.all(
				site.templateIds.map((templateId) => staff.api.templates.publish({ siteId: site.siteId, templateId })),
			);

			// Whichever publish committed first, pages loaded before the second one linked its stylesheet.
			const statuses = await Promise.all(
				alone.map(async (path) => (await install.request(new URL(path, site.url).href)).status),
			);
			expect(statuses).toContain(200);
		}
	});

	test("publishing is recorded in the Audit log; a Draft saved since shows as changed", async () => {
		const { siteId } = await siteWithPost();
		await staff.api.designSystem.saveDraft({ siteId, darkMode: true });
		await staff.api.designSystem.publish({ siteId });
		await staff.api.designSystem.saveDraft({ siteId, customCss: "p { margin: 0; }" });

		expect((await staff.api.designSystem.get({ siteId })).designSystem.status).toBe("changed");
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		expect(entries.find((entry) => entry.action === "designSystem.publish" && entry.siteId === siteId)).toMatchObject({
			via: { kind: "admin" },
		});
	});
});

describe("who changes it", () => {
	test("only Staff: Members can neither read, change nor publish the Design system", async () => {
		const { siteId } = await siteWithPost();
		const owner = await install.createMember({ workspaceId, role: "owner" });

		for (const call of [
			() => owner.browser.api.designSystem.get({ siteId }),
			() => owner.browser.api.designSystem.saveDraft({ siteId, darkMode: true }),
			() => owner.browser.api.designSystem.publish({ siteId }),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});
});

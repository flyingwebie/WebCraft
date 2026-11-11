// `webcraft structure pull` and `push`: a Site's Structure as files for Staff's own editor and git.
// Pull writes Template markup, the Design system (CSS and DTCG tokens), Post Types, Loops, Forms and
// Filters, with a manifest of what was pulled; push sends what changed as Drafts after a preview,
// never publishing, and refuses files the Install changed since the pull unless --force.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@webcraft/api";

import { createApiToken } from "../harness/api-tokens.ts";
import { type CliUser, cliUser } from "../harness/cli.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { answerOf, connectMcp } from "../harness/mcp.ts";

let install: TestInstall;
let staff: ApiClient;
let staffBrowser: TestBrowser;
let cli: CliUser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	({ id: workspaceId } = await install.createWorkspace("Bakeries"));
	const member = await install.createStaff({ workspaces: [workspaceId], name: "Sam Staff" });
	staff = member.browser.api;
	staffBrowser = member.browser;
	cli = cliUser(install);
});

afterAll(async () => {
	await cli.close();
	await install.close();
});

/** A Site with every kind of Structure, and a folder to pull it into. */
async function bakerySite(slug: string) {
	const { id: siteId } = await install.createSite(workspaceId, { name: `Bakery ${slug}`, slug });
	const { postType } = await staff.postTypes.create({
		siteId,
		name: "Posts",
		key: "posts",
		urlPattern: "/posts/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "vegan", label: "Vegan", type: "boolean" },
		],
	});
	await staff.designSystem.createClass({
		siteId,
		name: "badge",
		styles: "color: var(--primary-70);",
		breakpoints: { "breakpoint-md": "padding: var(--space-s);" },
		css: "& b {\n\tfont-weight: 700;\n}",
	});
	const { component } = await staff.components.create({
		siteId,
		name: "PostCard",
		props: [{ key: "heading", label: "Heading", type: "text" }],
	});
	await staff.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<div class="badge"><h2>{{ props.heading }}</h2></div>',
	});
	await staff.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header>Fresh bread</header><main>{{@outlet}}</main>",
	});
	await staff.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<article><h1>{{ title }}</h1><PostCard heading="{{ title }}" /></article>',
	});
	const { loop } = await staff.loops.create({
		siteId,
		name: "latest",
		source: "query",
		query: { postTypes: ["posts"] },
	});
	const { form } = await staff.forms.create({ siteId, name: "Contact", key: "contact" });
	await staff.filters.create({
		siteId,
		name: "latest",
		loop: "latest",
		controls: [{ type: "toggle", key: "vegan", label: "Vegan only", field: "vegan" }],
	});
	// Each Site's test has its own API token, so its requests count against limits of their own.
	const { secret } = await createApiToken(staffBrowser, { workspaceId, name: `Laptop ${slug}` });
	const env = { WEBCRAFT_TOKEN: secret, WEBCRAFT_INSTALL: install.adminUrl("/") };
	const dir = mkdtempSync(join(tmpdir(), "webcraft-structure-"));
	const file = (path: string) => join(dir, ...path.split("/"));
	return {
		siteId,
		postTypeId: postType.id,
		componentId: component.id,
		loopId: loop.id,
		formId: form.id,
		dir,
		read: (path: string) => readFileSync(file(path), "utf8"),
		write: (path: string, content: string) => writeFileSync(file(path), content),
		remove: () => rmSync(dir, { recursive: true, force: true }),
		pull: (more: string[] = []) => cli.run(["structure", "pull", "--site-id", siteId, "--dir", dir, ...more], { env }),
		push: (more: string[] = []) => cli.run(["structure", "push", "--dir", dir, ...more], { env }),
	};
}

describe("structure pull", () => {
	test("writes Template markup, the Design system, Post Types, Loops, Forms and Filters, with a manifest", async () => {
		const site = await bakerySite("pull");
		try {
			const { code, stdout } = await site.pull();

			expect(code).toBe(0);
			expect(stdout).toContain("Pulled");
			expect(site.read("templates/site.wc.html")).toMatch(
				/^<header data-wc-id="[^"]+">Fresh bread<\/header><main data-wc-id="[^"]+">\{\{@outlet\}\}<\/main>\n$/,
			);
			expect(site.read("templates/entry/posts.wc.html")).toContain('<PostCard heading="{{ title }}"');
			expect(site.read("components/PostCard.wc.html")).toContain('<h2 data-wc-id="');
			expect(site.read("components/PostCard.wc.html")).toStartWith("{{@props}}\n");
			expect(site.read("design-system/classes/badge.css")).toBe(
				".badge {\n\tcolor: var(--primary-70);\n}\n\n" +
					"@media (--md) {\n\t.badge {\n\t\tpadding: var(--space-s);\n\t}\n}\n\n" +
					"/* Its own CSS: */\n.badge {\n\t& b {\n\t\tfont-weight: 700;\n\t}\n}\n",
			);
			expect(site.read("design-system/base.css")).toContain("body {\n\t");
			expect(JSON.parse(site.read("design-system/tokens.json"))).toMatchObject({ color: { $type: "color" } });
			expect(JSON.parse(site.read("design-system/design-system.json"))).toEqual({
				darkMode: false,
				classes: ["badge"],
			});
			expect(JSON.parse(site.read("post-types/posts.json"))).toMatchObject({
				name: "Posts",
				urlPattern: "/posts/{slug}",
				fields: [{ key: "summary" }, { key: "vegan" }],
			});
			expect(JSON.parse(site.read("loops/latest.json"))).toMatchObject({
				source: "query",
				query: { postTypes: ["posts"] },
			});
			expect(JSON.parse(site.read("forms/contact.json"))).toMatchObject({
				name: "Contact",
				submitLabel: { text: "Send" },
			});
			expect(JSON.parse(site.read("filters/latest.json"))).toMatchObject({
				loop: "latest",
				controls: [{ key: "vegan" }],
			});
			const manifest = JSON.parse(site.read("webcraft.json"));
			expect(manifest).toMatchObject({ install: "https://admin.test", site: { id: site.siteId } });
			expect(manifest.files["templates/site.wc.html"]).toEqual({
				hash: expect.any(String),
				version: expect.any(String),
			});
		} finally {
			site.remove();
		}
	});

	test("refuses to overwrite files changed since the last pull, unless --force", async () => {
		const site = await bakerySite("overwrite");
		try {
			await site.pull();
			site.write("loops/latest.json", '{ "source": "query", "query": { "postTypes": ["posts"], "limit": 3 } }\n');

			const refused = await site.pull();
			expect(refused.code).toBe(5);
			expect(refused.stderr).toContain("loops/latest.json");
			expect(site.read("loops/latest.json")).toContain('"limit": 3');

			expect((await site.pull(["--force"])).code).toBe(0);
			expect(site.read("loops/latest.json")).toContain('"limit": 10');
		} finally {
			site.remove();
		}
	});
});

describe("structure push", () => {
	test("pull then push without edits changes nothing", async () => {
		const site = await bakerySite("roundtrip");
		try {
			await site.pull();
			const before = await staff.templates.getSiteTemplateMarkup({ siteId: site.siteId });
			const designBefore = await staff.designSystem.get({ siteId: site.siteId });

			const { code, stdout } = await site.push(["--yes"]);

			expect(code).toBe(0);
			expect(stdout).toBe("Nothing to push: no file changed since the last pull.\n");
			expect((await staff.templates.getSiteTemplateMarkup({ siteId: site.siteId })).version).toBe(before.version);
			expect((await staff.designSystem.get({ siteId: site.siteId })).designSystem.updatedAt).toEqual(
				designBefore.designSystem.updatedAt,
			);
		} finally {
			site.remove();
		}
	});

	test("shows what changes per file, then sends it as Drafts once confirmed, never publishing", async () => {
		const site = await bakerySite("changes");
		try {
			await site.pull();
			site.write(
				"templates/site.wc.html",
				site.read("templates/site.wc.html").replace("</main>", "</main><footer>Open daily</footer>"),
			);
			site.write(
				"design-system/classes/badge.css",
				site
					.read("design-system/classes/badge.css")
					.replace("color: var(--primary-70);", "color: var(--primary-80);\n\tfont-weight: 600;"),
			);
			site.write("design-system/classes/note.css", ".note {\n\tpadding: var(--space-m);\n}\n");
			site.write("components/OpeningHours.wc.html", "<p>Mon–Sat, 7–14</p>\n");
			site.write("components/OpeningHours.json", '{ "props": [] }\n');
			site.write("loops/latest.json", site.read("loops/latest.json").replace('"limit": 10', '"limit": 4'));

			const unconfirmed = await site.push();
			expect(unconfirmed.code).toBe(4);
			expect(unconfirmed.stdout).toContain("as Drafts (nothing is published)");
			expect(unconfirmed.stdout).toContain("~ templates/site.wc.html  +1 −1");
			expect(unconfirmed.stdout).toContain("+ components/OpeningHours.wc.html");
			expect(unconfirmed.stdout).toContain("(new: Component OpeningHours)");
			expect(unconfirmed.stdout).toContain("~ loops/latest.json");
			expect(unconfirmed.stderr).toContain("Pass --yes");
			expect((await staff.loops.get({ siteId: site.siteId, loopId: site.loopId })).loop.draft.query?.limit).toBe(10);

			const sent = await site.push(["--yes"]);
			expect(sent.code).toBe(0);
			expect(sent.stdout).toContain("Sent 4 changes as Drafts");

			const template = await staff.templates.getSiteTemplateMarkup({ siteId: site.siteId });
			expect(template.markup?.draft).toContain("<footer data-wc-id=");
			expect(template.markup?.published).toBeNull();
			// The new element's id is written back, so the next push keeps it.
			expect(site.read("templates/site.wc.html")).toBe(`${template.markup?.draft}\n`);
			const { designSystem } = await staff.designSystem.get({ siteId: site.siteId });
			expect(designSystem.published).toBeNull();
			expect(designSystem.draft.classes.map((each) => [each.name, each.styles])).toEqual([
				["badge", "color: var(--primary-80);\nfont-weight: 600;"],
				["note", "padding: var(--space-m);"],
			]);
			expect(designSystem.draft.classes[0]?.breakpoints).toEqual({ "breakpoint-md": "padding: var(--space-s);" });
			const { components } = await staff.components.list({ siteId: site.siteId });
			expect(components.map((each) => each.name).sort()).toEqual(["OpeningHours", "PostCard"]);
			expect((await staff.loops.get({ siteId: site.siteId, loopId: site.loopId })).loop.draft.query?.limit).toBe(4);

			expect((await site.push()).stdout).toBe("Nothing to push: no file changed since the last pull.\n");
		} finally {
			site.remove();
		}
	});

	test("what a push changes besides (an inline style makes a Class) comes back too, so editing it next isn't stale", async () => {
		const site = await bakerySite("sidechange");
		try {
			await site.pull();
			site.write(
				"templates/entry/posts.wc.html",
				site
					.read("templates/entry/posts.wc.html")
					.replace("</article>", '<p style="margin: 0">Baked today</p></article>'),
			);
			expect((await site.push(["--yes"])).code).toBe(0);
			const classes = JSON.parse(site.read("design-system/design-system.json")).classes as string[];
			expect(classes).toHaveLength(2);
			expect(classes[0]).toBe("badge");

			site.write(
				"design-system/classes/badge.css",
				site.read("design-system/classes/badge.css").replace("var(--primary-70)", "var(--primary-90)"),
			);
			const { code, stderr } = await site.push(["--yes"]);
			expect(stderr).toBe("");
			expect(code).toBe(0);
			const { designSystem } = await staff.designSystem.get({ siteId: site.siteId });
			expect(designSystem.draft.classes.find((each) => each.name === "badge")?.styles).toBe(
				"color: var(--primary-90);",
			);
		} finally {
			site.remove();
		}
	});

	test("says a Post Type's change applies at once, and --dry-run sends nothing", async () => {
		const site = await bakerySite("posttypes");
		try {
			await site.pull();
			site.write(
				"post-types/posts.json",
				site.read("post-types/posts.json").replace('"name": "Posts"', '"name": "Articles"'),
			);

			const dry = await site.push(["--dry-run"]);
			expect(dry.code).toBe(0);
			expect(dry.stdout).toContain("~ post-types/posts.json  +1 −1 (applies at once: Post Types have no Draft)");
			expect((await staff.postTypes.get({ siteId: site.siteId, postTypeId: site.postTypeId })).postType.name).toBe(
				"Posts",
			);

			expect((await site.push(["--yes"])).code).toBe(0);
			expect((await staff.postTypes.get({ siteId: site.siteId, postTypeId: site.postTypeId })).postType.name).toBe(
				"Articles",
			);
		} finally {
			site.remove();
		}
	});

	test("Forms and Filters take back what pull wrote, and new ones are made", async () => {
		const site = await bakerySite("forms");
		try {
			await site.pull();
			site.write("forms/contact.json", site.read("forms/contact.json").replace('"text": "Send"', '"text": "Send it"'));
			site.write("filters/latest.json", site.read("filters/latest.json").replace('"mode": "live"', '"mode": "submit"'));
			site.write("forms/order.json", '{ "name": "Order", "fields": [] }\n');

			const { code, stderr } = await site.push(["--yes"]);

			expect(stderr).toBe("");
			expect(code).toBe(0);
			expect(
				(await staff.forms.get({ siteId: site.siteId, formId: site.formId })).form.draft.submitLabel,
			).toMatchObject({
				text: "Send it",
			});
			const { filters } = await staff.filters.list({ siteId: site.siteId });
			expect(filters[0]?.draft.mode).toBe("submit");
			const { forms } = await staff.forms.list({ siteId: site.siteId });
			expect(forms.map((form) => form.key).sort()).toEqual(["contact", "order"]);
		} finally {
			site.remove();
		}
	});

	test("refuses a push whose files changed on the Install since the pull, sending nothing, unless --force", async () => {
		const site = await bakerySite("stale");
		try {
			await site.pull();
			// Someone saves the Site template in the admin meanwhile.
			await staff.templates.saveSiteTemplateMarkup({
				siteId: site.siteId,
				markup: "<header>Closed today</header><main>{{@outlet}}</main>",
			});
			site.write("templates/site.wc.html", site.read("templates/site.wc.html").replace("Fresh bread", "Fresh rye"));
			site.write("loops/latest.json", site.read("loops/latest.json").replace('"limit": 10', '"limit": 6'));

			const refused = await site.push(["--yes"]);
			expect(refused.code).toBe(5);
			expect(refused.stdout).toContain("! templates/site.wc.html");
			expect(refused.stderr).toContain("Nothing was sent: the Site template changed on the Install since your pull");
			expect((await staff.templates.getSiteTemplateMarkup({ siteId: site.siteId })).markup?.draft).toContain(
				"Closed today",
			);
			expect((await staff.loops.get({ siteId: site.siteId, loopId: site.loopId })).loop.draft.query?.limit).toBe(10);

			const forced = await site.push(["--yes", "--force"]);
			expect(forced.stderr).toBe("");
			expect(forced.code).toBe(0);
			expect((await staff.templates.getSiteTemplateMarkup({ siteId: site.siteId })).markup?.draft).toContain(
				"Fresh rye",
			);
			expect((await staff.loops.get({ siteId: site.siteId, loopId: site.loopId })).loop.draft.query?.limit).toBe(6);
		} finally {
			site.remove();
		}
	});
});

test("Component Props travel in the wc.html file through pull, edit and push", async () => {
	const site = await bakerySite("props-block-cli");
	try {
		expect((await site.pull()).code).toBe(0);
		const source = site.read("components/PostCard.wc.html");
		expect(source).toStartWith("{{@props}}\n");
		expect(() => site.read("components/PostCard.json")).toThrow();
		const before = await staff.components.getMarkup({ siteId: site.siteId, componentId: site.componentId });
		site.write(
			"components/PostCard.wc.html",
			source.replace("heading: text", 'heading: text exposed default="From file"'),
		);
		expect((await site.push(["--yes"])).code).toBe(0);
		const saved = await staff.components.getMarkup({ siteId: site.siteId, componentId: site.componentId });
		expect(saved.component.draft.props[0]).toMatchObject({
			id: before.component.draft.props[0]?.id,
			exposed: true,
			default: "From file",
		});
		expect(saved.component.published).toBeNull();
	} finally {
		site.remove();
	}
});

test("CLI and MCP keep per-Placement binding projections while editing canonical Component files", async () => {
	const site = await bakerySite("binding-cli");
	try {
		const target = { siteId: site.siteId, componentId: site.componentId };
		const { component: inner } = await staff.components.create({ siteId: site.siteId, name: "BoundInner" });
		await staff.components.saveMarkup({
			siteId: site.siteId,
			componentId: inner.id,
			markup:
				'{{@props}}\ncard: group fields=[{"key":"city","label":"City","type":"text"}]\n{{/props}}\n<p>{{ props.card.city }}</p>',
		});
		const first = await staff.components.saveMarkup({
			...target,
			markup:
				'{{@props}}\nheading: text\naddress: group fields=[{"key":"city","label":"City","type":"text"}]\n{{/props}}\n<BoundInner card="{{ props.address }}" />',
		});
		await staff.components.saveMarkup({ ...target, markup: first.markup.replace('"key":"city"', '"key":"town"') });
		expect((await site.pull()).code).toBe(0);
		const source = site.read("components/PostCard.wc.html");
		expect(source).toContain("data-wc-bindings=");
		site.write("components/PostCard.wc.html", `${source}<!--CLI edit-->`);
		expect((await site.push(["--yes"])).code).toBe(0);
		const { secret } = await createApiToken(staffBrowser, { workspaceId, name: "Bound MCP", toolsets: ["structure"] });
		const client = await connectMcp(install, secret);
		try {
			const read = answerOf<Awaited<ReturnType<typeof staff.components.getMarkup>>>(
				await client.callTool({ name: "components_get_markup", arguments: target }),
			);
			expect(read.markup.draft).toContain("data-wc-bindings=");
			expect(read.markup.draft).toContain("CLI edit");
			const saved = answerOf<Awaited<ReturnType<typeof staff.components.saveMarkup>>>(
				await client.callTool({
					name: "components_save_markup",
					arguments: { ...target, markup: `${read.markup.draft}<!--MCP edit-->`, basedOn: read.version },
				}),
			);
			expect(saved.component.draft.tree.nodes[0]).toMatchObject({
				props: [{ binding: { root: "props.address", paths: { city: "town" } } }],
			});
			expect(saved.component.published).toBeNull();
		} finally {
			await client.close();
		}
	} finally {
		site.remove();
	}
});

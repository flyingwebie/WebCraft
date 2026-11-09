// Components are styled as Templates are (ADR 0009): their elements name the Site's Classes, an
// inline style becomes a generated Class, only the Classes published elements use reach the
// stylesheet, and a Class a Component uses can't be deleted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { layerOf, pageWithStyles } from "../harness/site-styles.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let cardClassId: string;
let componentId: string;
const url = "https://bakery.sites.test/blog/fresh-bread";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { class: card } = await staff.api.designSystem.createClass({
		siteId,
		name: "card",
		styles: "padding: var(--space-m);",
	});
	cardClassId = card.id;
	await staff.api.designSystem.publish({ siteId });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Teaser",
		props: [{ key: "heading", label: "Heading", type: "text" }],
	});
	componentId = component.id;
	const saved = await staff.api.components.saveMarkup({
		siteId,
		componentId,
		markup: '<article class="card"><h2 style="color: red">{{ props.heading }}</h2></article>',
	});
	expect(saved.notices[0]?.message).toContain("became the Class style-");
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<Teaser heading="{{ title }}" />',
	});
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.components.publish({ siteId, componentId });
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

describe("Components and the Design system", () => {
	test("a Class only a Component uses, and its generated Class, reach the stylesheet with the Component", async () => {
		const { html, css } = await pageWithStyles(install, url);

		const generated = /<h2 class="(style-[0-9a-f]{8})">/.exec(html)?.[1];
		expect(html).toContain(`<article class="card"><h2 class="${generated}">Fresh bread</h2></article>`);
		expect(layerOf(css, "classes")).toBe(`.card{padding:var(--space-m)}\n.${generated}{color:red}`);
	});

	test("a Class a Component uses can't be deleted, and the refusal names the Component", async () => {
		const refused = await staff.api.designSystem.deleteClass({ siteId, classId: cardClassId }).then(
			() => undefined,
			(error: { code?: string; data?: { usedBy?: unknown[] } }) => error,
		);

		expect(refused?.code).toBe("CLASS_IN_USE");
		expect(refused?.data?.usedBy).toEqual([
			{ kind: "component", componentId, name: "Teaser", version: "draft", elements: [expect.any(String)] },
			{ kind: "component", componentId, name: "Teaser", version: "published", elements: [expect.any(String)] },
		]);
	});
});

// Since when each open Check has been there: Checks are worked out whenever they are read, and the
// first read that finds one notes when. A Check is the same while its item, language, kind and element
// are (the markup here names its elements, as saved markup does). A Check fixed and broken again starts
// over; a read that sees less (a Member's, one Entry's) never forgets what it didn't look at.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const HOUR = 60 * 60_000;

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let siteId: string;
let postTypeId: string;
let entryId: string;
let componentId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspace = await install.createWorkspace();
	siteId = (await install.createSite(workspace.id)).id;
	staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	author = (await install.createMember({ workspaceId: workspace.id, role: "author" })).browser;
	await staff.api.seoSettings.update({ siteId, socialCards: { enabled: false } });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Articles",
		key: "articles",
		urlPattern: "/articles/{slug}",
		fields: [],
	});
	postTypeId = postType.id;
	await entryTemplate('<h1>{{ title }}</h1><img data-wc-id="photo" src="https://example.com/a.jpg">');
	entryId = (await staff.api.entries.create({ siteId, postTypeId, title: "Article" })).entry.id;
	const { component } = await staff.api.components.create({ siteId, name: "Banner", props: [] });
	componentId = component.id;
	await staff.api.components.saveMarkup({ siteId, componentId, markup: '<img src="https://example.com/b.jpg">' });
});

afterAll(async () => {
	await install.close();
});

function entryTemplate(markup: string) {
	return staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup });
}

/** When the Check of this kind on this item was first seen, as `checks.list` says; undefined when there is none. */
async function since(browser: TestBrowser, itemId: string, check: string): Promise<Date | undefined> {
	const { checks } = await browser.api.checks.list({ siteId });
	return checks.find((found) => found.item.id === itemId && found.check === check)?.since;
}

test("a Check is first seen when Checks are first read after it appears, and stays so", async () => {
	const firstRead = install.clock.now();
	expect(await since(staff, entryId, "missingAlt")).toEqual(firstRead);

	await install.clock.advance(2 * HOUR);
	expect(await since(staff, entryId, "missingAlt")).toEqual(firstRead);
	// One Entry's Checks say the same.
	const { checks } = await staff.api.checks.entry({ siteId, entryId });
	expect(checks.find((found) => found.check === "missingAlt")?.since).toEqual(firstRead);

	// A new problem on the same item is new.
	await entryTemplate(
		'<h1>{{ title }}</h1><img data-wc-id="photo" src="https://example.com/a.jpg"><a data-wc-id="more" href="/">Read more</a>',
	);
	expect(await since(staff, entryId, "vagueLink")).toEqual(install.clock.now());
	expect(await since(staff, entryId, "missingAlt")).toEqual(firstRead);
});

test("a Check fixed and broken again starts over", async () => {
	await entryTemplate("<h1>{{ title }}</h1>");
	expect(await since(staff, entryId, "missingAlt")).toBeUndefined();

	await install.clock.advance(HOUR);
	await entryTemplate('<h1>{{ title }}</h1><img data-wc-id="photo" src="https://example.com/a.jpg">');
	expect(await since(staff, entryId, "missingAlt")).toEqual(install.clock.now());
});

test("a Member's read, which leaves Structure out, never forgets Structure's Checks", async () => {
	const componentSeen = await since(staff, componentId, "missingAlt");
	expect(componentSeen).toBeDefined();
	await install.clock.advance(HOUR);

	const { checks } = await author.api.checks.list({ siteId });
	expect(checks.some((found) => found.item.kind === "component")).toBe(false);
	expect(await since(staff, componentId, "missingAlt")).toEqual(componentSeen);
});

test("one Entry's read never forgets another Entry's Checks", async () => {
	const other = (await staff.api.entries.create({ siteId, postTypeId, title: "Another" })).entry.id;
	const seen = await since(staff, other, "missingAlt");
	expect(seen).toBeDefined();
	await install.clock.advance(HOUR);

	await staff.api.checks.entry({ siteId, entryId });
	expect(await since(staff, other, "missingAlt")).toEqual(seen);
});

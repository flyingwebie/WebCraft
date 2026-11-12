import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
beforeAll(async () => {
	install = await startBrowserInstall();
});
afterAll(async () => {
	await install.close();
});

async function fixture(slug: string, titles = ["Welcome to Cork"], locked = false) {
	const local = install.install;
	const staff = await local.superadmin();
	const workspaceId = (await local.createWorkspace()).id;
	const siteId = (await local.createSite(workspaceId, { slug })).id;
	const member = await local.createMember({ workspaceId, role: "editor" });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pageType = postTypes.find((type) => type.builtIn === "page");
	if (!pageType) throw new Error("Missing Page Post Type");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pageType.id, title: "About" });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Hero",
		props: [
			{ key: "heading", label: "Heading", type: "text", translatable: true },
			{ key: "count", label: "Count", type: "number", default: 3 },
		],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<section><h1>{{ props.heading }}</h1><p>{{ props.count }}</p></section>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.components.create({ siteId, name: "Unavailable" });
	await staff.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const state = await staff.api.pageLayouts.get({ siteId, entryId: entry.id });
	await staff.api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: state.version,
		layout: {
			placements: titles.map((heading, index) => ({
				id: `hero-${index}`,
				component: component.id,
				props: component.draft.props,
				values: { heading: { en: heading } },
				...(locked && index === titles.length - 1 ? { locked: true } : {}),
			})),
		},
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return { staff, siteId, entryId: entry.id, member, workspaceId, componentId: component.id };
}
async function enter(theme: Theme, site: Awaited<ReturnType<typeof fixture>>, phone = false) {
	const page = await install.newPage(theme, { touch: phone });
	if (phone) await page.setViewportSize({ width: 390, height: 844 });
	await install.signIn(page, site.member.account);
	await page.goto(install.adminUrl(`/sites/${site.siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname !== new URL(install.adminUrl("/")).hostname);
	await page.getByRole("button", { name: "Page layout", exact: true }).waitFor();
	return page;
}
async function firstIs(page: Page, text: string) {
	await page.waitForFunction(
		(text) => document.querySelector("main [data-wc-page-placement]")?.textContent?.includes(text),
		text,
	);
}
for (const theme of THEMES) {
	test(`typed and inline Page Props preserve semantics and keyboard access (${theme})`, async () => {
		const site = await fixture(`layout-${theme}`);
		const page = await enter(theme, site);
		try {
			await page.getByRole("button", { name: "Page layout", exact: true }).click();
			const tree = page.getByRole("tree");
			await tree.getByRole("treeitem", { name: /Hero · Welcome to Cork/ }).click();
			expect(await tree.getByRole("treeitem").count()).toBe(3);
			await page.getByRole("button", { name: "Props", exact: true }).click();
			const inspector = page.locator('[data-editor-region="inspector"]');
			await inspector.getByLabel("Heading", { exact: true }).fill("Hello Cork");
			await inspector.getByLabel("Heading", { exact: true }).press("Tab");
			await page.locator("h1").filter({ hasText: "Hello Cork" }).waitFor();
			await inspector.getByLabel("Count", { exact: true }).fill("7");
			await inspector.getByLabel("Count", { exact: true }).press("Tab");
			await page.locator("main p").filter({ hasText: "7" }).waitFor();
			await expectAccessibleScreen(page, `Page layout Props ${theme}`);
			await page.getByRole("button", { name: "Close", exact: true }).click();
			const inline = page.locator("main [data-wc-placement-prop]");
			await inline.fill("Inline Cork");
			const inlineSaved = page.waitForResponse(
				(response) => response.url().endsWith("/layout/save") && response.status() === 200,
			);
			await inline.press("Enter");
			await inlineSaved;
			await page.locator("h1").filter({ hasText: "Inline Cork" }).waitFor();
			await page.reload();
			await page.locator("main [data-wc-placement-prop]").filter({ hasText: "Inline Cork" }).waitFor();
			expect(
				(await site.staff.api.pageLayouts.get({ siteId: site.siteId, entryId: site.entryId })).placements[0]?.values,
			).toEqual({ heading: "Inline Cork", count: 7 });
			await page.getByRole("button", { name: "Page layout", exact: true }).click();
			await page.getByRole("button", { name: "Hide", exact: true }).click();
			await page.locator('main [data-wc-hidden-placement="true"]').waitFor();
			await page.getByRole("button", { name: "Close", exact: true }).click();
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await page.waitForFunction(() => !document.querySelector('main [contenteditable="true"]'));
			expect(await page.locator("[data-wc-placement-selected]").count()).toBe(0);
		} finally {
			await page.close();
		}
	});
	test(`shared Page tree keys, locks, typeahead, F6 and cancellation (${theme})`, async () => {
		const site = await fixture(`layout-keys-${theme}`, ["North", "South", "Locked"], true);
		const page = await enter(theme, site);
		try {
			await page.getByRole("button", { name: "Page layout", exact: true }).click();
			const tree = page.getByRole("tree");
			await tree.waitFor();
			const rows = tree.getByRole("treeitem");
			expect(await rows.count()).toBe(5);
			expect(await rows.first().getAttribute("aria-level")).toBe("1");
			expect(await rows.last().getAttribute("aria-setsize")).toBe("5");
			await rows.filter({ hasText: "Hero · South" }).click();
			await page.keyboard.press("Space");
			await tree.locator('[data-grabbed="true"]').waitFor();
			await page.keyboard.press("ArrowUp");
			await firstIs(page, "South");
			await page.keyboard.press("Escape");
			await firstIs(page, "North");
			await page.keyboard.press("Alt+ArrowUp");
			await firstIs(page, "South");
			const source = rows.filter({ hasText: "Hero · South" });
			const target = rows.filter({ hasText: "Hero · North" });
			const box = await target.boundingBox();
			if (!box) throw new Error("Missing target row");
			await source.dragTo(target, { targetPosition: { x: 15, y: box.height - 2 } });
			await firstIs(page, "North");
			await page.keyboard.press("Home");
			expect(await rows.first().getAttribute("aria-selected")).toBe("true");
			await page.keyboard.type("hero");
			expect(await rows.nth(1).getAttribute("aria-selected")).toBe("true");
			await page.keyboard.press("F6");
			await page.locator('[data-editor-region="inspector"]').getByLabel("Heading", { exact: true }).waitFor();
			await page.keyboard.press("Shift+F6");
			await tree.waitFor();
			await rows.filter({ hasText: "Hero · Locked" }).click();
			expect(await page.getByRole("button", { name: "Remove", exact: true }).isDisabled()).toBe(true);
			await page.keyboard.press("Delete");
			expect(await rows.count()).toBe(5);
			await page.getByRole("button", { name: "Props", exact: true }).click();
			await page
				.locator('[data-editor-region="inspector"]')
				.getByLabel("Heading", { exact: true })
				.fill("Still editable");
			await page.locator('[data-editor-region="inspector"]').getByLabel("Heading", { exact: true }).press("Tab");
			await page.locator("h1").filter({ hasText: "Still editable" }).waitFor();
			expect(await page.locator("[data-editor-messages]").count()).toBe(1);
			await expectNoAxeViolations(page, `Page layout keyboard ${theme}`);
			const state = await site.staff.api.pageLayouts.get({ siteId: site.siteId, entryId: site.entryId });
			expect(state.placements.map((p) => p.values.heading)).toEqual(["North", "South", "Still editable"]);
		} finally {
			await page.close();
		}
	});
	test(`phone Page layout uses a sheet, full-screen moves and the Allowed picker (${theme})`, async () => {
		const site = await fixture(`layout-phone-${theme}`, ["North", "South"]);
		const page = await enter(theme, site, true);
		try {
			await page.getByRole("button", { name: "Page layout", exact: true }).tap();
			let dialog = page.getByRole("dialog");
			await dialog.waitFor();
			expect((await dialog.boundingBox())?.height).toBeGreaterThan(800);
			await dialog.getByRole("treeitem", { name: /Hero · North/ }).tap();
			await dialog
				.getByRole("group", { name: /Hero · North/ })
				.getByRole("button", { name: "Move down", exact: true })
				.tap();
			await firstIs(page, "South");
			await dialog.getByRole("button", { name: "Props", exact: true }).tap();
			dialog = page.getByRole("dialog", { name: "Props", exact: true });
			await dialog.waitFor();
			expect((await dialog.boundingBox())?.height).toBeLessThan(844 * 0.86);
			await dialog.getByLabel("Heading", { exact: true }).fill("Phone North");
			await dialog.getByLabel("Heading", { exact: true }).press("Tab");
			await page.locator("h1").filter({ hasText: "Phone North" }).waitFor();
			await expectNoAxeViolations(page, `Page layout phone Props ${theme}`);
			await dialog.getByRole("button", { name: "Move", exact: true }).tap();
			await page.getByRole("tree").waitFor();
			await page.getByRole("button", { name: "Insert", exact: true }).tap();
			const picker = page.getByRole("dialog");
			await picker.getByRole("button", { name: "Hero", exact: true }).waitFor();
			expect(await picker.getByRole("button", { name: "Unavailable", exact: true }).count()).toBe(0);
			await picker.getByRole("button", { name: "Hero", exact: true }).tap();
			await page.waitForFunction(() => document.querySelectorAll("main [data-wc-page-placement]").length === 3);
			await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).tap();
			await page.getByRole("dialog").waitFor({ state: "hidden" });
			expect(
				await page
					.getByRole("button", { name: "Page layout", exact: true })
					.first()
					.evaluate((button) => {
						let active = document.activeElement;
						while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
						return active === button;
					}),
			).toBe(true);
		} finally {
			await page.close();
		}
	});
	test(`peer Page Props preserve pending input, selection and focus (${theme})`, async () => {
		const site = await fixture(`layout-peers-${theme}`);
		const first = await enter(theme, site);
		const second = await enter(theme, site);
		try {
			for (const page of [first, second]) {
				await page.getByRole("button", { name: "Page layout", exact: true }).click();
				await page.getByRole("button", { name: "Props", exact: true }).click();
			}
			const inspector = first.locator('[data-editor-region="inspector"]');
			const heading = inspector.getByLabel("Heading", { exact: true });
			await heading.fill("Own pending words");
			const count = second.locator('[data-editor-region="inspector"]').getByLabel("Count", { exact: true });
			await count.fill("9");
			await count.press("Tab");
			await first.waitForFunction(
				() =>
					document
						.querySelector("#webcraft-page-layout")
						?.shadowRoot?.querySelector<HTMLInputElement>('input[type="number"]')?.value === "9",
			);
			expect(await heading.inputValue()).toBe("Own pending words");
			expect(
				await heading.evaluate(
					(input) =>
						input.getRootNode() instanceof ShadowRoot && (input.getRootNode() as ShadowRoot).activeElement === input,
				),
			).toBe(true);
			await heading.press("Tab");
			await second.locator("h1").filter({ hasText: "Own pending words" }).waitFor();
			expect(
				(await site.staff.api.pageLayouts.get({ siteId: site.siteId, entryId: site.entryId })).placements[0]?.values,
			).toEqual({ heading: "Own pending words", count: 9 });
		} finally {
			await first.close();
			await second.close();
		}
	});
	test(`Staff switches and locks govern Member Page actions (${theme})`, async () => {
		const site = await fixture(`layout-settings-${theme}`);
		const account = (await install.install.createStaff({ workspaces: [site.workspaceId] })).account;
		const page = await install.newPage(theme);
		try {
			await install.signIn(page, account);
			await page.goto(install.adminUrl(`/sites/${site.siteId}/components`));
			const enabled = page.getByLabel("Members can arrange Page layouts", { exact: true });
			await enabled.waitFor();
			expect(await enabled.isChecked()).toBe(true);
			const disabled = page.waitForResponse(
				(response) => response.url().includes("pageLayouts/configure") && response.status() === 200,
			);
			await enabled.uncheck();
			await disabled;
			await page.getByLabel("Hero · Members can add", { exact: true }).waitFor({ state: "visible" });
			await page.reload();
			await enabled.waitFor();
			expect(await enabled.isChecked()).toBe(false);
			await enabled.check();
			await page.getByLabel("Hero · Members can add", { exact: true }).uncheck();
			await expectNoAxeViolations(page, `Page layout settings ${theme}`);
			await page.goto(install.adminUrl(`/sites/${site.siteId}`));
			await page.getByRole("button", { name: "Edit on site" }).click();
			await page.getByRole("button", { name: "Page layout", exact: true }).click();
			const locked = page.waitForResponse(
				(response) => response.url().endsWith("/layout/save") && response.status() === 200,
			);
			await page.getByRole("button", { name: "Lock", exact: true }).click();
			await locked;
			const member = await enter(theme, site);
			try {
				await member.getByRole("button", { name: "Page layout", exact: true }).click();
				expect(await member.getByRole("button", { name: "Lock", exact: true }).count()).toBe(0);
				expect(
					await member
						.getByRole("group", { name: /Hero ·/ })
						.getByRole("button", { name: "Duplicate", exact: true })
						.isDisabled(),
				).toBe(true);
				expect(await member.getByRole("button", { name: "Remove", exact: true }).isDisabled()).toBe(true);
				await member.getByRole("button", { name: "Props", exact: true }).click();
				await member
					.locator('[data-editor-region="inspector"]')
					.getByLabel("Heading", { exact: true })
					.fill("Kept while locked");
				await member.locator('[data-editor-region="inspector"]').getByLabel("Heading", { exact: true }).press("Tab");
				await member.locator("h1").filter({ hasText: "Kept while locked" }).waitFor();
			} finally {
				await member.close();
			}
		} finally {
			await page.close();
		}
	});
}

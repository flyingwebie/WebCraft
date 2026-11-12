// The Undo history in Edit mode (ADR 0036), in a real browser: a Member's text typed in place, Props
// and Page layout actions are steps of the one history of the tab, each taken back from the Edit bar,
// the keyboard or the text toolbar, in the order they were made, with its label and a message for
// screen readers. A person only ever takes back their own steps, the server's rules still decide, and
// the Publish menu's Revert stays what it was.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
// Each case signs its own people into its own Site: Edit mode's links share the sign-in rate limit.
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

/**
 * A Site whose pages show the Globals' Tagline above their content, with a home Page ("Home") of two
 * Hero Placements, "North" and "South", which Members may arrange, and a second Page, "About".
 */
async function bakery(slug: string, headings = ["North", "South"]) {
	const local = install.install;
	const staff = await local.superadmin();
	const workspaceId = (await local.createWorkspace()).id;
	const siteId = (await local.createSite(workspaceId, { slug })).id;
	const member = await local.createMember({ workspaceId, role: "editor", name: "Mia Member" });
	const api = staff.api;
	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await api.globals.publish({ siteId });
	const template = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>{{ site.tagline }}</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { postTypes } = await api.postTypes.list({ siteId });
	const pageType = postTypes.find((type) => type.builtIn === "page");
	if (!pageType) throw new Error("Missing Page Post Type");
	const { component } = await api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", translatable: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<section><h1>{{ props.heading }}</h1></section>",
	});
	await api.components.publish({ siteId, componentId: component.id });
	await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const page = async (title: string, headings: string[]) => {
		const { entry } = await api.entries.create({ siteId, postTypeId: pageType.id, title });
		const state = await api.pageLayouts.get({ siteId, entryId: entry.id });
		await api.pageLayouts.save({
			siteId,
			entryId: entry.id,
			basedOn: state.version,
			layout: {
				placements: headings.map((heading) => ({
					id: heading.toLowerCase(),
					component: component.id,
					props: component.draft.props,
					values: { heading: { en: heading } },
				})),
			},
		});
		await api.entries.publish({ siteId, entryId: entry.id });
		return entry.id;
	};
	const homeId = await page("Home", headings);
	await api.pages.setHomePage({ siteId, pageId: homeId });
	const aboutId = await page("About", ["East"]);
	const read = async () => {
		const layout = await api.pageLayouts.get({ siteId, entryId: homeId });
		return {
			tagline: (await api.globals.get({ siteId })).globals.draft.tagline,
			placements: layout.layout.placements.map((p) => {
				const shown = layout.placements.find((each) => each.id === p.id);
				return `${String(shown?.values.heading)}${p.hidden ? " (hidden)" : ""}`;
			}),
		};
	};
	return { api, siteId, workspaceId, homeId, aboutId, componentId: component.id, member, read };
}

/** Opens the Site in Edit mode as `account`, on its home page; `prepare` sets the page up before it loads anything. */
async function enter(
	theme: Theme,
	siteId: string,
	account: TestAccount,
	options: { phone?: boolean; prepare?(page: Page): Promise<void> } = {},
): Promise<Page> {
	const page = await install.newPage(theme, { touch: options.phone });
	page.setDefaultTimeout(10000);
	if (options.phone) await page.setViewportSize({ width: 390, height: 844 });
	await options.prepare?.(page);
	await install.signIn(page, account);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname !== new URL(install.adminUrl("/")).hostname);
	await layoutButton(page).waitFor();
	return page;
}

/** The Edit bar's own Page layout button (a selected Placement's tools have one too). */
const layoutButton = (page: Page) =>
	page.getByRole("region", { name: "Edit mode" }).getByRole("button", { name: "Page layout", exact: true });
const undoButton = (page: Page) =>
	page.getByRole("group", { name: "Undo history" }).getByRole("button", { name: "Undo" });
const redoButton = (page: Page) =>
	page.getByRole("group", { name: "Undo history" }).getByRole("button", { name: "Redo" });
const tagline = (page: Page) => page.locator('header [data-wc-item="globals"][data-wc-field="tagline"]');
const said = (page: Page, text: string) => page.locator("[data-editor-messages]").filter({ hasText: text }).waitFor();

/** Waits until the history offers `label` as its next Undo (its tooltip starts with it), or none for null. */
async function nextUndo(page: Page, label: string | null): Promise<void> {
	await page.waitForFunction((label) => {
		const bar = document.querySelector("webcraft-edit-bar")?.shadowRoot;
		const button = bar?.querySelector<HTMLButtonElement>('.history button[aria-label="Undo"]');
		if (!button) return false;
		return label === null ? button.disabled : !button.disabled && button.title.startsWith(`Undo ${label} (`);
	}, label);
}

/** Types over the Tagline in place and leaves it, so the burst is saved as one finished action. */
async function typeTagline(page: Page, text: string): Promise<void> {
	await tagline(page).fill(text);
	await tagline(page).press("Tab");
}

async function debug(page: Page): Promise<string> {
	return JSON.stringify({
		errors: pageErrors(page),
		undo: await undoButton(page).getAttribute("title"),
		redo: await redoButton(page).getAttribute("title"),
		messages: await page.locator("[data-editor-messages]").allTextContents(),
	});
}

for (const theme of THEMES) {
	test(`text, Props and Page layout steps undo and redo in the order they were made (${theme})`, async () => {
		const site = await bakery(`history-${theme}`);
		const page = await enter(theme, site.siteId, site.member.account);
		try {
			// Nothing to take back yet: both are off, and say what they are with their keys.
			expect(await undoButton(page).isDisabled()).toBe(true);
			expect(await redoButton(page).isDisabled()).toBe(true);
			expect(await undoButton(page).getAttribute("title")).toMatch(/^Undo \((⌘Z|Ctrl\+Z)\)$/);
			expect(await undoButton(page).getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+Z$/);

			// Three finished actions: text typed in place, a Prop, and a Page layout action.
			await typeTagline(page, "Baked twice daily");
			await nextUndo(page, "Edit Tagline");
			await layoutButton(page).click();
			await page.getByRole("treeitem", { name: /Hero · North/ }).click();
			await page.getByRole("button", { name: "Props", exact: true }).click();
			const heading = page.locator('[data-editor-region="inspector"]').getByLabel("Heading", { exact: true });
			await heading.fill("North Cork");
			await heading.press("Tab");
			await nextUndo(page, "Props Hero · North");
			await page.keyboard.press("Shift+F6");
			await page.getByRole("treeitem", { name: /Hero · South/ }).click();
			await page.getByRole("button", { name: "Hide or show", exact: true }).click();
			await nextUndo(page, "Hide or show Hero · South");
			expect(await site.read()).toEqual({ tagline: "Baked twice daily", placements: ["North Cork", "South (hidden)"] });
			expect(await redoButton(page).isDisabled()).toBe(true);

			// The bar's button takes back the last one, says so, and offers it again as Redo.
			await undoButton(page).click();
			await said(page, "Undid Hide or show Hero · South");
			await nextUndo(page, "Props Hero · North");
			expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Hide or show Hero · South (");
			expect(await site.read()).toEqual({ tagline: "Baked twice daily", placements: ["North Cork", "South"] });

			// The keys step through the same history, whatever has focus on the page.
			await page.keyboard.press("ControlOrMeta+z");
			await said(page, "Undid Props Hero · North");
			await page
				.locator("main h1")
				.filter({ hasText: /^North$/ })
				.waitFor();
			await page.keyboard.press("ControlOrMeta+z");
			await said(page, "Undid Edit Tagline");
			await tagline(page)
				.filter({ hasText: /^Baked daily$/ })
				.waitFor();
			await nextUndo(page, null);
			expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["North", "South"] });

			// Redo makes them again, oldest first, from either set of keys.
			await page.keyboard.press("ControlOrMeta+Shift+z");
			await said(page, "Redid Edit Tagline");
			await tagline(page)
				.filter({ hasText: /^Baked twice daily$/ })
				.waitFor();
			await page.keyboard.press("ControlOrMeta+y");
			await said(page, "Redid Props Hero · North");
			await redoButton(page).click();
			await said(page, "Redid Hide or show Hero · South");
			expect(await redoButton(page).isDisabled()).toBe(true);
			expect(await site.read()).toEqual({ tagline: "Baked twice daily", placements: ["North Cork", "South (hidden)"] });
			expect(await page.locator("[data-editor-messages]").count()).toBe(1);
			await expectAccessibleScreen(page, `Edit mode Undo history ${theme}`);

			// A new step after an Undo leaves nothing to redo.
			await undoButton(page).click();
			await said(page, "Undid Hide or show Hero · South");
			await typeTagline(page, "Baked three times daily");
			await nextUndo(page, "Edit Tagline");
			expect(await redoButton(page).isDisabled()).toBe(true);

			// The Publish menu's Revert is still there, per change, and is not a step of the history.
			await page.getByRole("button", { name: "Publish", exact: true }).click();
			await page.getByRole("button", { name: "Revert Tagline", exact: true }).waitFor();
			await page.keyboard.press("Escape");
			await nextUndo(page, "Edit Tagline");

			// The history lasts as long as the tab's page: loading it again starts an empty one.
			await page.reload();
			await layoutButton(page).waitFor();
			await nextUndo(page, null);
			expect(await redoButton(page).isDisabled()).toBe(true);
		} catch (error) {
			console.error(await debug(page));
			throw error;
		} finally {
			await page.close();
		}
	});
}

for (const theme of THEMES) {
	test(`a Member and Staff on one Draft each undo only their own steps (${theme})`, async () => {
		const site = await bakery(`history-peers-${theme}`);
		const staff = (await install.install.createStaff({ workspaces: [site.workspaceId], name: "Sam Staff" })).account;
		const member = await enter(theme, site.siteId, site.member.account);
		const peer = await enter(theme, site.siteId, staff);
		try {
			// Their steps interleave on the same Page: Member, Staff, Member, Staff.
			const inline = member.locator('main [data-wc-placement="north"][data-wc-placement-prop="heading"]');
			await inline.fill("Member North");
			await inline.press("Enter");
			await nextUndo(member, "Props Hero · North");
			await layoutButton(peer).click();
			await peer.getByRole("treeitem", { name: /Hero · South/ }).click();
			await peer.getByRole("button", { name: "Hide or show", exact: true }).click();
			await nextUndo(peer, "Hide or show Hero · South");
			await member.locator('main [data-wc-page-placement="south"][data-wc-hidden-placement="true"]').waitFor();
			await typeTagline(member, "Member tagline");
			await nextUndo(member, "Edit Tagline");
			await tagline(peer)
				.filter({ hasText: /^Member tagline$/ })
				.waitFor();
			await peer.getByRole("button", { name: "Props", exact: true }).click();
			const heading = peer.locator('[data-editor-region="inspector"]').getByLabel("Heading", { exact: true });
			await heading.fill("Staff South");
			await heading.press("Tab");
			await nextUndo(peer, "Props Hero · South");
			expect(await site.read()).toEqual({
				tagline: "Member tagline",
				placements: ["Member North", "Staff South (hidden)"],
			});

			// The Member's history holds the Member's two steps and nothing of Staff's later ones.
			await nextUndo(member, "Edit Tagline");
			await member.keyboard.press("ControlOrMeta+z");
			await said(member, "Undid Edit Tagline");
			await nextUndo(member, "Props Hero · North");
			await undoButton(member).click();
			await said(member, "Undid Props Hero · North");
			await nextUndo(member, null);
			expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["North", "Staff South (hidden)"] });

			// Staff see the Member's steps go, and take back their own two the same way.
			await tagline(peer)
				.filter({ hasText: /^Baked daily$/ })
				.waitFor();
			await nextUndo(peer, "Props Hero · South");
			await undoButton(peer).click();
			await said(peer, "Undid Props Hero · South");
			await undoButton(peer).click();
			await said(peer, "Undid Hide or show Hero · South");
			await nextUndo(peer, null);
			expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["North", "South"] });

			// Each can make their own again; the other's Redo stays their own.
			expect(await redoButton(member).getAttribute("title")).toStartWith("Redo Props Hero · North (");
			expect(await redoButton(peer).getAttribute("title")).toStartWith("Redo Hide or show Hero · South (");
			await redoButton(member).click();
			await said(member, "Redid Props Hero · North");
			expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["Member North", "South"] });
			await expectAccessibleScreen(peer, `Edit mode Undo history beside a peer ${theme}`);
		} catch (error) {
			console.error(await debug(member), await debug(peer));
			throw error;
		} finally {
			await member.close();
			await peer.close();
		}
	});
}

test("a step that no longer applies, or that the server refuses, is skipped with its reason", async () => {
	const site = await bakery("history-skipped");
	const page = await enter("light", site.siteId, site.member.account);
	try {
		// Someone else writes the same value after the Member did: the Member's step would overwrite it.
		await typeTagline(page, "Mine");
		await nextUndo(page, "Edit Tagline");
		await site.api.globals.saveDraft({ siteId: site.siteId, fields: { tagline: "Staff's" } });
		await tagline(page)
			.filter({ hasText: /^Staff's$/ })
			.waitFor();
		await undoButton(page).click();
		await said(page, "Skipped Edit Tagline. This step overlaps a newer change or its target no longer exists.");
		await nextUndo(page, null);
		expect(await redoButton(page).isDisabled()).toBe(true);
		expect((await site.read()).tagline).toBe("Staff's");

		// The Member removes a Placement; Staff then stop allowing its Component. Putting it back would
		// add one Members may not add: the server refuses, and the history says so.
		await layoutButton(page).click();
		await page.getByRole("treeitem", { name: /Hero · South/ }).click();
		await page.getByRole("button", { name: "Remove", exact: true }).click();
		await nextUndo(page, "Remove Hero · South");
		await site.api.pageLayouts.configure({ siteId: site.siteId, allowedComponents: [] });
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Skipped Remove Hero · South. The server refused this step.");
		expect(await page.locator('[data-editor-messages] [role="alert"]').textContent()).toContain("Skipped Remove");
		await nextUndo(page, null);
		expect((await site.read()).placements).toEqual(["North"]);
	} catch (error) {
		console.error(await debug(page));
		throw error;
	} finally {
		await page.close();
	}
});

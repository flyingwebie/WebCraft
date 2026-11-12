// The Undo history in Edit mode (ADR 0036), in a real browser: a Member's text typed in place, Props
// and Page layout actions are steps of the one history of the tab, each taken back from the Edit bar,
// the keyboard or the text toolbar, in the order they were made, with its label and a message for
// screen readers. A person only ever takes back their own steps, the server's rules still decide, and
// the Publish menu's Revert stays what it was.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
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
 * A Site whose pages show the Globals' Tagline above their content, links to its two Pages, and the
 * Globals' Note (rich text) below: a home Page ("Home") of Hero Placements, "North" and "South" unless
 * given, which Members may arrange, and a second Page, "About".
 */
async function bakery(slug: string, headings = ["North", "South"]) {
	const local = install.install;
	const staff = await local.superadmin();
	const workspaceId = (await local.createWorkspace()).id;
	const siteId = (await local.createSite(workspaceId, { slug })).id;
	const member = await local.createMember({ workspaceId, role: "editor", name: "Mia Member" });
	const api = staff.api;
	await api.globals.setFields({
		siteId,
		fields: [
			{ key: "tagline", label: "Tagline", type: "text" },
			{ key: "note", label: "Note", type: "richText" },
		],
	});
	await api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily", note: "<p>Open daily.</p>" } });
	await api.globals.publish({ siteId });
	const template = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p>{{ site.tagline }}</p><nav><a href="/">Home page</a> <a href="/about">About us</a></nav></header><main>{{@outlet}}</main><footer><div>{{ site.note }}</div></footer>',
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

/** What the page said and what its history offers, for a failing case's report (the bar hides its buttons on a phone). */
async function debug(page: Page): Promise<string> {
	return JSON.stringify({
		errors: pageErrors(page),
		history: await page.evaluate(() =>
			[
				...(document
					.querySelector("webcraft-edit-bar")
					?.shadowRoot?.querySelectorAll<HTMLButtonElement>(".history button") ?? []),
			].map((button) => `${button.title}${button.disabled ? " (off)" : ""}`),
		),
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

test("Undo with a Prop still focused, or its save not yet answered, takes back that Prop and nothing earlier", async () => {
	const site = await bakery("history-pending");
	// The Page's shared Draft, with the server's answers held back while `holding`.
	let holding = false;
	const held: (() => void)[] = [];
	const page = await enter("light", site.siteId, site.member.account, {
		prepare: (page) =>
			page.routeWebSocket(/\/_webcraft\/edit\/drafts\/entry\//, (socket) => {
				const server = socket.connectToServer();
				socket.onMessage((message) => server.send(message));
				server.onMessage((message) => {
					if (holding) held.push(() => socket.send(message));
					else socket.send(message);
				});
			}),
	});
	try {
		// An earlier step, which must stay: South is hidden.
		await layoutButton(page).click();
		await page.getByRole("treeitem", { name: /Hero · South/ }).click();
		await page.getByRole("button", { name: "Hide or show", exact: true }).click();
		await nextUndo(page, "Hide or show Hero · South");
		await page.getByRole("treeitem", { name: /Hero · North/ }).click();
		await page.getByRole("button", { name: "Props", exact: true }).click();
		const heading = page.locator('[data-editor-region="inspector"]').getByLabel("Heading", { exact: true });

		// Typed and still in the field: nothing is a step yet. Undo finishes the input first, so it is
		// this Prop that is taken back, in its place after the earlier step.
		await heading.fill("Still typing");
		await nextUndo(page, "Hide or show Hero · South");
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Props Hero · North");
		await nextUndo(page, "Hide or show Hero · South");
		expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Props Hero · North (");
		expect(await heading.inputValue()).toBe("North");
		expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["North", "South (hidden)"] });

		// Left the field, the save not yet answered: Undo waits for the answer, then takes back that Prop.
		await page.keyboard.press("Shift+F6");
		await page.getByRole("treeitem", { name: /Hero · South/ }).click();
		await page.getByRole("button", { name: "Props", exact: true }).click();
		await heading.fill("Slow to save");
		holding = true;
		await heading.press("Tab");
		await page.keyboard.press("ControlOrMeta+z");
		await page.waitForTimeout(300);
		// Nothing moved while the answer was out: not this step, and not the one before it.
		expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Props Hero · North (");
		holding = false;
		for (const send of held.splice(0)) send();
		await said(page, "Undid Props Hero · South");
		await nextUndo(page, "Hide or show Hero · South");
		expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Props Hero · South (");
		expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["North", "South (hidden)"] });
	} catch (error) {
		console.error(await debug(page));
		throw error;
	} finally {
		await page.close();
	}
});

test("a refused Prop is no step: Undo then takes back the last one that was accepted", async () => {
	const site = await bakery("history-refused");
	const page = await enter("light", site.siteId, site.member.account);
	try {
		await typeTagline(page, "Accepted");
		await nextUndo(page, "Edit Tagline");
		await layoutButton(page).click();
		await page.getByRole("treeitem", { name: /Hero · South/ }).click();
		await page.getByRole("button", { name: "Props", exact: true }).click();
		const heading = page.locator('[data-editor-region="inspector"]').getByLabel("Heading", { exact: true });
		await heading.fill("Typed into a Placement that is going");
		// Staff remove the Placement while the Member's input is still open: the input is refused.
		const now = await site.api.pageLayouts.get({ siteId: site.siteId, entryId: site.homeId });
		await site.api.pageLayouts.save({
			siteId: site.siteId,
			entryId: site.homeId,
			basedOn: now.version,
			layout: { placements: now.layout.placements.filter((p) => p.id !== "south") },
		});
		await said(page, "Someone changed this at the same moment. Try again.");
		await nextUndo(page, "Edit Tagline");
		expect(await redoButton(page).isDisabled()).toBe(true);
		await undoButton(page).click();
		await said(page, "Undid Edit Tagline");
		await nextUndo(page, null);
		expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Edit Tagline (");
		expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["North"] });
	} catch (error) {
		console.error(await debug(page));
		throw error;
	} finally {
		await page.close();
	}
});

test("one finished action is one step: a move however many rows, a burst of typing, add, duplicate and remove", async () => {
	const site = await bakery("history-steps", ["North", "South", "West"]);
	const page = await enter("light", site.siteId, site.member.account);
	const order = async () => (await site.read()).placements;
	try {
		await layoutButton(page).click();
		const tree = page.getByRole("tree");
		const row = (name: string) => tree.getByRole("treeitem", { name: new RegExp(`Hero · ${name}`) });

		// Picked up, moved two rows, put down: one step, however many rows it passed.
		await row("West").click();
		await page.keyboard.press("Space");
		await tree.locator('[data-grabbed="true"]').waitFor();
		await page.keyboard.press("ArrowUp");
		await said(page, "Hero · West, 2 / 3");
		await page.keyboard.press("ArrowUp");
		await said(page, "Hero · West, 1 / 3");
		await nextUndo(page, null);
		await page.keyboard.press("Space");
		await nextUndo(page, "Move Placement");
		expect(await order()).toEqual(["West", "North", "South"]);
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Move Placement");
		await nextUndo(page, null);
		expect(await order()).toEqual(["North", "South", "West"]);
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await said(page, "Redid Move Placement");
		expect(await order()).toEqual(["West", "North", "South"]);

		// Picked up, moved, and put back with Escape: no step at all.
		await row("South").click();
		await page.keyboard.press("Space");
		await page.keyboard.press("ArrowUp");
		await page.waitForFunction(() =>
			document.querySelectorAll("main [data-wc-page-placement]")[1]?.textContent?.includes("South"),
		);
		await page.keyboard.press("Escape");
		await page.waitForFunction(() =>
			document.querySelectorAll("main [data-wc-page-placement]")[2]?.textContent?.includes("South"),
		);
		await nextUndo(page, "Move Placement");
		expect(await redoButton(page).isDisabled()).toBe(true);
		expect(await order()).toEqual(["West", "North", "South"]);

		// Dragged to a new row: one step.
		const target = await row("West").boundingBox();
		if (!target) throw new Error("Missing target row");
		await row("South").dragTo(row("West"), { targetPosition: { x: 15, y: 2 } });
		await page.waitForFunction(() =>
			document.querySelector("main [data-wc-page-placement]")?.textContent?.includes("South"),
		);
		expect(await order()).toEqual(["South", "West", "North"]);
		await undoButton(page).click();
		await said(page, "Undid Move Placement");
		expect(await order()).toEqual(["West", "North", "South"]);

		// Add, duplicate and remove are each one step, taken back newest first.
		await row("South").click();
		await page.getByRole("button", { name: "Duplicate", exact: true }).first().click();
		await nextUndo(page, "Duplicate Hero · South");
		await page.getByRole("button", { name: "Insert", exact: true }).click();
		await page.locator("[data-picker]").getByRole("button", { name: "Hero", exact: true }).click();
		await nextUndo(page, "Add component Hero");
		await row("North").click();
		await page.getByRole("button", { name: "Remove", exact: true }).first().click();
		await nextUndo(page, "Remove Hero · North");
		expect((await order()).length).toBe(4);
		await undoButton(page).click();
		await said(page, "Undid Remove Hero · North");
		await undoButton(page).click();
		await said(page, "Undid Add component Hero");
		await undoButton(page).click();
		await said(page, "Undid Duplicate Hero · South");
		expect(await order()).toEqual(["West", "North", "South"]);

		// Typing without a pause, then leaving the text, is one burst and one step.
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await tagline(page).click();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("Fresh every morning");
		await tagline(page).press("Tab");
		await nextUndo(page, "Edit Tagline");
		expect((await site.read()).tagline).toBe("Fresh every morning");
		// A pause ends a burst while the text keeps focus: what is typed next is a step of its own.
		await tagline(page).click();
		await page.keyboard.press("End");
		await page.keyboard.type(" and noon");
		await page.waitForFunction(
			() =>
				document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelector(".saved")?.textContent ===
				"Saved to Draft · just now",
		);
		await page.waitForResponse((response) => response.url().endsWith("/api/state") && response.ok());
		expect((await site.read()).tagline).toBe("Fresh every morning and noon");
		// The keys step back from inside the text, which keeps focus and shows each step taken back.
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Edit Tagline");
		await tagline(page)
			.filter({ hasText: /^Fresh every morning$/ })
			.waitFor();
		expect(await tagline(page).evaluate((region) => document.activeElement === region)).toBe(true);
		await page.keyboard.press("ControlOrMeta+z");
		await tagline(page)
			.filter({ hasText: /^Baked daily$/ })
			.waitFor();
		expect(await tagline(page).evaluate((region) => document.activeElement === region)).toBe(true);
		expect((await site.read()).tagline).toBe("Baked daily");
	} catch (error) {
		console.error(await debug(page));
		throw error;
	} finally {
		await page.close();
	}
});

test("the history goes along to another page of the Site, says where a step was made, and a reload clears it", async () => {
	const site = await bakery("history-pages");
	const page = await enter("light", site.siteId, site.member.account);
	try {
		await typeTagline(page, "Typed on Home");
		await nextUndo(page, "Edit Tagline");
		await layoutButton(page).click();
		await page.getByRole("treeitem", { name: /Hero · South/ }).click();
		await page.getByRole("button", { name: "Move up", exact: true }).first().click();
		await nextUndo(page, "Move up Hero · South");
		expect((await site.read()).placements).toEqual(["South", "North"]);

		// The bar's page switcher takes the history to the next page; its token doesn't stay in the address.
		await page.getByRole("button", { name: "Page: Home. Switch page" }).click();
		await page.getByRole("menuitem", { name: /About/ }).click();
		await page.waitForURL((url) => url.pathname === "/about");
		await layoutButton(page).waitFor();
		await nextUndo(page, "Move up Hero · South");
		expect(new URL(page.url()).hash).toBe("");

		// A step made on another page is taken back there, and the message says where.
		await undoButton(page).click();
		await said(page, "Undid Move up Hero · South on Home");
		expect((await site.read()).placements).toEqual(["North", "South"]);
		// The Tagline shows on this page too: its step is taken back in view, with no "on Home".
		await undoButton(page).click();
		await said(page, "Undid Edit Tagline");
		await tagline(page)
			.filter({ hasText: /^Baked daily$/ })
			.waitFor();
		expect(await page.locator("[data-editor-messages]").textContent()).not.toContain("on Home");
		expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Edit Tagline (");

		// A step made here goes back with a link of the page itself, as well as the earlier Redo.
		await redoButton(page).click();
		await said(page, "Redid Edit Tagline");
		const inline = page.locator('main [data-wc-placement="east"][data-wc-placement-prop="heading"]');
		await inline.fill("East Cork");
		await inline.press("Enter");
		await nextUndo(page, "Props Hero · East");
		await page.getByRole("link", { name: "Home page", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/");
		await layoutButton(page).waitFor();
		await nextUndo(page, "Props Hero · East");
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Props Hero · East on About");
		await nextUndo(page, "Edit Tagline");
		const about = await site.api.pageLayouts.get({ siteId: site.siteId, entryId: site.aboutId });
		expect(about.placements.map((p) => p.values.heading)).toEqual(["East"]);

		// Text typed in a Placement on the page, the keys pressed while still in it: the step is made and
		// taken back, and focus is in that text again once the page has drawn it as it was.
		const north = page.locator('main [data-wc-placement="north"][data-wc-placement-prop="heading"]');
		await north.click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Cork");
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Props Hero · North");
		await north.filter({ hasText: /^North$/ }).waitFor();
		await page.waitForFunction(() =>
			document.activeElement?.matches('[data-wc-placement="north"][data-wc-placement-prop]'),
		);
		expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Props Hero · North (");
		expect((await site.read()).placements).toEqual(["North", "South"]);

		// Loading the page again is a new tab's worth of history: none.
		await page.reload();
		await layoutButton(page).waitFor();
		await nextUndo(page, null);
		expect(await redoButton(page).isDisabled()).toBe(true);
		expect((await site.read()).tagline).toBe("Typed on Home");
	} catch (error) {
		console.error(await debug(page));
		throw error;
	} finally {
		await page.close();
	}
});

test("Staff keep the history when they switch to Code mode and back", async () => {
	const site = await bakery("history-code");
	const staff = (await install.install.createStaff({ workspaces: [site.workspaceId] })).account;
	const page = await enter("light", site.siteId, staff);
	try {
		await typeTagline(page, "Typed in Edit mode");
		await nextUndo(page, "Edit Tagline");
		await layoutButton(page).click();
		await page.getByRole("treeitem", { name: /Hero · South/ }).click();
		await page.getByRole("button", { name: "Hide or show", exact: true }).click();
		await nextUndo(page, "Hide or show Hero · South");

		// Code mode shows the same history in its own Undo, and takes a step back from there.
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("textbox", { name: /^HTML of / }).waitFor();
		const codeUndo = page.getByRole("button", { name: "Undo", exact: true });
		await codeUndo.and(page.locator(":not([disabled])")).waitFor();
		expect(await codeUndo.getAttribute("title")).toStartWith("Undo Hide or show Hero · South (");
		expect(new URL(page.url()).hash).toBe("");
		await codeUndo.click();
		await said(page, "Undid Hide or show Hero · South on Home");
		expect(await site.read()).toEqual({ tagline: "Typed in Edit mode", placements: ["North", "South"] });

		// Back in Edit mode the rest is still there, with the step just taken back as Redo.
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await layoutButton(page).waitFor();
		await nextUndo(page, "Edit Tagline");
		expect(await redoButton(page).getAttribute("title")).toStartWith("Redo Hide or show Hero · South (");
		await undoButton(page).click();
		await said(page, "Undid Edit Tagline");
		expect(await site.read()).toEqual({ tagline: "Baked daily", placements: ["North", "South"] });
	} catch (error) {
		console.error(JSON.stringify({ errors: pageErrors(page), url: page.url() }));
		throw error;
	} finally {
		await page.close();
	}
});

for (const theme of THEMES) {
	test(`the text toolbar's Undo is the same history, and the text keeps focus (${theme})`, async () => {
		const site = await bakery(`history-toolbar-${theme}`);
		const page = await enter(theme, site.siteId, site.member.account);
		const note = page.locator('footer [data-wc-item="globals"][data-wc-field="note"]');
		const toolbar = page.getByRole("toolbar", { name: "Formatting" });
		const inNote = () => note.evaluate((region) => document.activeElement === region);
		try {
			// With nothing to take back, the toolbar's Undo is off and the arrow keys pass it by.
			await note.click();
			await toolbar.waitFor();
			expect(await toolbar.getByRole("button", { name: "Undo", exact: true }).isDisabled()).toBe(true);
			await page.keyboard.press("Alt+F10");
			await page.keyboard.press("ArrowLeft");
			expect(
				await toolbar
					.getByRole("button", { name: "Done", exact: true })
					.evaluate((done) => (done.getRootNode() as ShadowRoot).activeElement === done),
			).toBe(true);
			await page.keyboard.press("Escape");
			expect(await inNote()).toBe(true);

			// A step from elsewhere on the page, then rich text typed here: both are the toolbar's to take back.
			await typeTagline(page, "Typed first");
			await nextUndo(page, "Edit Tagline");
			await note.click();
			await page.keyboard.press("ControlOrMeta+End");
			await page.keyboard.type(" Closed on Mondays.");
			await nextUndo(page, "Edit Note");
			const undo = toolbar.getByRole("button", { name: "Undo", exact: true });
			expect(await undo.getAttribute("title")).toStartWith("Undo Edit Note (");
			// The toolbar comes and goes with the text's focus, so it is checked as it stands, not walked through.
			await expectNoAxeViolations(page, `Edit mode text toolbar Undo ${theme}`);
			await note.click();
			await undo.click();
			await said(page, "Undid Edit Note");
			await note.filter({ hasText: /^Open daily\.$/ }).waitFor();
			expect(await inNote()).toBe(true);
			expect(await undo.getAttribute("title")).toStartWith("Undo Edit Tagline (");
			// From the keyboard: into the toolbar, along to Undo, and the text has focus again afterwards.
			await page.keyboard.press("Alt+F10");
			await page.keyboard.press("End");
			await page.keyboard.press("ArrowLeft");
			await page.keyboard.press("Enter");
			await said(page, "Undid Edit Tagline");
			await tagline(page)
				.filter({ hasText: /^Baked daily$/ })
				.waitFor();
			expect(await inNote()).toBe(true);
			// Redo, from the keys inside the text, makes the rich text step again as it was stored.
			await page.keyboard.press("ControlOrMeta+Shift+z");
			await said(page, "Redid Edit Tagline");
			await page.keyboard.press("ControlOrMeta+Shift+z");
			await said(page, "Redid Edit Note");
			await note.filter({ hasText: /^Open daily\. Closed on Mondays\.$/ }).waitFor();
			expect(await inNote()).toBe(true);
			expect((await site.api.globals.get({ siteId: site.siteId })).globals.draft.note).toBe(
				"<p>Open daily. Closed on Mondays.</p>",
			);
		} catch (error) {
			console.error(await debug(page));
			throw error;
		} finally {
			await page.close();
		}
	});
}

test("on a phone, Undo and Redo are in the bar's menu with the step they would take", async () => {
	const site = await bakery("history-phone");
	const page = await enter("light", site.siteId, site.member.account, { phone: true });
	try {
		await tagline(page).fill("Typed on a phone");
		await tagline(page).evaluate((region: HTMLElement) => region.blur());
		const more = page.getByRole("button", { name: "Edit mode menu", exact: true });
		await page.waitForFunction(
			() =>
				document
					.querySelector("webcraft-edit-bar")
					?.shadowRoot?.querySelector<HTMLButtonElement>('.history button[aria-label="Undo"]')?.disabled === false,
		);
		await more.tap();
		const menu = page.getByRole("dialog");
		expect(await menu.getByRole("button", { name: "Redo", exact: true }).isDisabled()).toBe(true);
		await menu.getByRole("button", { name: "Undo Edit Tagline", exact: true }).tap();
		await said(page, "Undid Edit Tagline");
		await tagline(page)
			.filter({ hasText: /^Baked daily$/ })
			.waitFor();
		await more.tap();
		await page.getByRole("dialog").getByRole("button", { name: "Redo Edit Tagline", exact: true }).tap();
		await said(page, "Redid Edit Tagline");
		expect((await site.read()).tagline).toBe("Typed on a phone");
	} catch (error) {
		console.error(await debug(page));
		throw error;
	} finally {
		await page.close();
	}
});

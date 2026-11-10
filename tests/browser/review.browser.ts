// Review in a real browser (GLOSSARY.md › Review): the Author's "Submit for review" and its dialog, an
// item In review as its Author sees it (Withdraw) and as a reviewer sees it (Send back and its
// dialog), a sent-back comment, the Site overview's "Waiting for review" list with the sidebar's
// count, the Entries list's chips, and Edit mode's Publish menu for an Author (Submit for review, then
// In review), in light and dark, with axe and the keyboard; and submitting and sending back without a
// mouse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let author: TestAccount;
let editor: TestAccount;
let siteId: string;
let postTypeId: string;
/** In review, with a note. */
let springId: string;
/** Sent back with a comment. */
let autumnId: string;
/** A Draft nobody submitted. */
let winterId: string;
/** Submitted from the keyboard. */
let summerId: string;
/** Sent back from the keyboard. */
let soupId: string;

const slug = "review-bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const ann = await local.createMember({ workspaceId, role: "author", name: "Ann Author" });
	const eve = await local.createMember({ workspaceId, role: "editor", name: "Eve Editor" });
	author = ann.account;
	editor = eve.account;
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<header><p>Welcome to <a href="/">Acme Bakery</a>.</p></header><main>{{@outlet}}</main>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	postTypeId = postType.id;
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const bread = await api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId, entryId: bread.entry.id });
	// The Author changed the page; Edit mode offers to submit it.
	await ann.browser.api.entries.saveDraft({ siteId, entryId: bread.entry.id, fields: { subtitle: "Still warm" } });

	const draft = async (title: string) =>
		(await ann.browser.api.entries.create({ siteId, postTypeId, title, fields: { subtitle: "Seasonal" } })).entry.id;
	const submit = (entryId: string, note?: string) =>
		ann.browser.api.reviews.submit({ siteId, items: [{ kind: "entry", id: entryId }], note });
	springId = await draft("Spring menu");
	await submit(springId, "Ready for Friday's newsletter.\nThe prices are new.");
	autumnId = await draft("Autumn menu");
	const sentBack = await submit(autumnId);
	await eve.browser.api.reviews.sendBack({
		siteId,
		reviewId: sentBack.reviews[0]?.id as string,
		comment: "The prices are last year's. Check them with the shop.",
	});
	winterId = await draft("Winter menu");
	summerId = await draft("Summer menu");
	soupId = await draft("Soup of the day");
	await submit(soupId);
});

afterAll(async () => {
	await install.close();
});

/** A page signed in as `account`, opened at `pagePath` on the admin. */
async function open(theme: Theme, account: TestAccount, pagePath: string): Promise<Page> {
	const page = await install.newPage(theme);
	await install.signIn(page, account);
	await page.goto(install.adminUrl(pagePath));
	await page.waitForLoadState("networkidle");
	return page;
}

const editorOf = (entryId: string) => `/sites/${siteId}/entries/${postTypeId}/${entryId}`;

/** The Author's edit cookie from the first time Edit mode opened, handed to later pages (the link works once). */
let editCookies: Cookie[] | undefined;

/** A page in Edit mode at /blog/fresh-bread, as the Author: the first time through "Edit on site". */
async function editModePage(theme: Theme): Promise<Page> {
	const page = await install.newPage(theme);
	if (editCookies) {
		await page.context().addCookies(editCookies);
	} else {
		await install.signIn(page, author);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
		editCookies = (await page.context().cookies()).filter((cookie) => cookie.name === "webcraft.edit");
	}
	await page.goto(install.siteUrl(slug, path));
	await page.getByRole("button", { name: "Changes", exact: true }).waitFor();
	return page;
}

/** Whether focus is on `element` within a second (a dialog moves focus as it opens). */
function focusedSoon(element: Element): Promise<boolean> {
	const deadline = performance.now() + 1000;
	return new Promise((resolve) => {
		const check = () => {
			if (element === document.activeElement) resolve(true);
			else if (performance.now() > deadline) resolve(false);
			else requestAnimationFrame(check);
		};
		check();
	});
}

for (const theme of THEMES) {
	describe(`Review, ${theme}`, () => {
		test("an Author's Draft offers Submit for review; its dialog with a note works from the keyboard", async () => {
			const page = await open(theme, author, editorOf(winterId));
			await page.getByRole("button", { name: "Submit for review" }).waitFor();
			await expectAccessibleScreen(page, `Entry editor, Submit for review (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Submit for review" }),
				"dialog",
				`The Submit for review dialog (${theme})`,
			);
		});

		test("In review, its Author sees who submitted it and when, their note, and Withdraw", async () => {
			const page = await open(theme, author, editorOf(springId));
			await page.getByRole("button", { name: "Withdraw" }).waitFor();
			await page.getByText("Submitted by you").waitFor();
			await expectAccessibleScreen(page, `Entry editor, In review for its Author (${theme})`);
		});

		test("a reviewer sees it In review, publishes or schedules it with the card's buttons, or sends it back", async () => {
			const page = await open(theme, editor, editorOf(springId));
			await page.getByText("Submitted by Ann Author").waitFor();
			await expectAccessibleScreen(page, `Entry editor, In review for a reviewer (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Send back…" }),
				"dialog",
				`The Send back dialog (${theme})`,
			);
		});

		test("sent back, the comment shows to its Author until they submit it again", async () => {
			const page = await open(theme, author, editorOf(autumnId));
			await page.getByText("The prices are last year's. Check them with the shop.").waitFor();
			await expectAccessibleScreen(page, `Entry editor, sent back (${theme})`);
		});

		test("the Site overview lists what waits for review, and the sidebar says how many wait for the reviewer", async () => {
			const page = await open(theme, editor, `/sites/${siteId}`);
			await page.getByRole("heading", { name: "Waiting for review" }).waitFor();
			await page.getByRole("link", { name: /^Overview\s*\d+ to review$/ }).waitFor();
			await expectAccessibleScreen(page, `Site overview with Reviews waiting (${theme})`);
		});

		test("the Entries list marks what is In review and what was sent back", async () => {
			const page = await open(theme, author, `/sites/${siteId}/entries/${postTypeId}`);
			await page.getByText("Sent back").first().waitFor();
			await expectAccessibleScreen(page, `Entries list with Reviews (${theme})`);
		});

		test("Edit mode's Publish menu offers an Author Submit for review, with a note", async () => {
			const page = await editModePage(theme);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Changes", exact: true }),
				"dialog",
				`Edit mode › Changes with Submit for review (${theme})`,
			);
		});
	});
}

describe("without a mouse", () => {
	test("an Author submits from the keyboard: the note is typed, Enter submits, and the editor says In review", async () => {
		const page = await open("light", author, editorOf(summerId));
		const trigger = page.getByRole("button", { name: "Submit for review" });
		await trigger.focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Submit for review" });
		const note = dialog.getByLabel("Note for the reviewer (optional)");
		await note.waitFor();
		expect({ focusedOnNote: await note.evaluate(focusedSoon) }).toEqual({ focusedOnNote: true });
		await page.keyboard.type("Summer prices are in.");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Enter");
		await dialog.waitFor({ state: "hidden" });
		await page.getByRole("button", { name: "Withdraw" }).waitFor();

		const { reviews } = await (await install.install.superadmin()).api.reviews.list({ siteId });
		expect(reviews.find((review) => review.item.kind === "entry" && review.item.id === summerId)).toMatchObject({
			note: "Summer prices are in.",
		});
	});

	test("a reviewer sends back from the keyboard: the comment is required, then sent, and focus goes back", async () => {
		const page = await open("light", editor, editorOf(soupId));
		const trigger = page.getByRole("button", { name: "Send back…" });
		await trigger.focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog", { name: "Send back" });
		const comment = dialog.getByLabel("Comment");
		await comment.waitFor();
		expect({ focusedOnComment: await comment.evaluate(focusedSoon) }).toEqual({ focusedOnComment: true });
		await dialog.getByRole("button", { name: "Send back" }).click();
		await dialog.getByText("Say why you're sending it back.").waitFor();
		expect({ backOnComment: await comment.evaluate(focusedSoon) }).toEqual({ backOnComment: true });
		expect(await comment.getAttribute("aria-invalid")).toBe("true");
		await page.keyboard.type("Add the soup's allergens.");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Enter");
		await dialog.waitFor({ state: "hidden" });
		await page.getByText("Add the soup's allergens.").waitFor();
		expect(await page.getByRole("button", { name: "Send back…" }).count()).toBe(0);

		const { entry } = await (await install.install.superadmin()).api.entries.get({ siteId, entryId: soupId });
		expect(entry.review).toMatchObject({ status: "sentBack", comment: "Add the soup's allergens." });
	});

	test("in Edit mode an Author submits the page with a note, then sees it In review with Withdraw", async () => {
		const page = await editModePage("light");
		const trigger = page.getByRole("button", { name: "Changes", exact: true });
		await trigger.focus();
		await page.keyboard.press("Enter");
		const note = page.getByLabel("Note for the reviewer (optional)");
		await note.waitFor();
		await note.focus();
		await page.keyboard.type("New subtitle.");
		await page.keyboard.press("Tab");
		await page.keyboard.press("Enter");
		await page.getByRole("button", { name: "Withdraw from review" }).waitFor();
		await page.getByText(/In review · submitted by you/).waitFor();
		// The panel is open over the page: axe checks it as it checks open overlays.
		await expectNoAxeViolations(page, "Edit mode › Changes In review (light, open)", ["region"]);
		expect({ chip: await page.getByText("In review", { exact: true }).count() }).toEqual({ chip: 1 });

		const { reviews } = await (await install.install.superadmin()).api.reviews.list({ siteId });
		expect(reviews.some((review) => review.note === "New subtitle.")).toBe(true);
	});
});

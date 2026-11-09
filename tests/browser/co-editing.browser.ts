// Co-editing in a real browser (ADR 0025): two people in the same Entry's editor see each other by name
// (avatars and an outline on the Field each is in), each other's changes as they are saved, and a
// Draft that turns read-only after 5 minutes without the server, said in a live region; the Globals
// editor too. axe and the keyboard, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let siteId: string;
let postTypeId: string;
let entryId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await local.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Eve Editor" })).account;
	const { api } = created.browser;
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "minutes", label: "Minutes", type: "number" },
		],
	});
	postTypeId = postType.id;
	const { entry } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: { summary: "Crusty" },
	});
	entryId = entry.id;
	await api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
});

afterAll(async () => {
	await install?.close();
});

const entryPath = () => `/sites/${siteId}/entries/${postTypeId}/${entryId}`;

async function openEntry(page: Page, account: TestAccount): Promise<void> {
	await install.signIn(page, account);
	await page.goto(install.adminUrl(entryPath()));
	await page.getByRole("status").filter({ hasText: "All changes saved" }).first().waitFor();
}

describe("two people in one Entry's editor", () => {
	for (const theme of THEMES) {
		test(`see each other by name and where each is, and each other's changes (${theme})`, async () => {
			const ada = await install.newPage(theme);
			const eve = await install.newPage(theme);
			await openEntry(ada, staff);
			await openEntry(eve, editor);

			// Eve goes into the Summary: Ada sees her name in the list and on the Field.
			await eve.getByLabel("Summary").focus();
			await ada.getByText("Eve Editor is here").waitFor();
			await expect(ada.getByRole("region", { name: "Also editing" }).getByText("Eve Editor")).toBeTruthy();

			// What Eve types reaches Ada as it is saved.
			await eve.getByLabel("Summary").fill(`Crusty, ${theme}`);
			await ada
				.getByLabel("Summary")
				.and(ada.locator(`[value="Crusty, ${theme}"]`))
				.waitFor();

			await expectAccessibleScreen(ada, `Entry editor with someone else in a Field (${theme})`);
			await ada.close();
			await eve.close();
		});
	}
});

describe("without the server", () => {
	for (const theme of THEMES) {
		test(`the editor says it is offline, then read-only after 5 minutes (${theme})`, async () => {
			const page = await install.newPage(theme);
			await page.clock.install();
			const sockets: { close(): Promise<void> }[] = [];
			// The socket goes through the test, which can break it as a network would.
			await page.routeWebSocket(/\/api\/drafts\//, (socket) => {
				const upstream = socket.connectToServer();
				sockets.push({ close: () => upstream.close() });
			});
			await openEntry(page, staff);
			await page.routeWebSocket(/\/api\/drafts\//, (socket) => socket.close({ code: 1006 }).catch(() => {}));
			for (const socket of sockets) await socket.close();
			await page.getByRole("status").filter({ hasText: "Offline" }).first().waitFor();
			// Changes made offline are kept.
			await page.getByLabel("Summary").fill("Written offline");
			await expectAccessibleScreen(page, `Entry editor offline (${theme})`);

			await page.clock.fastForward("05:10");
			await page.getByRole("status").filter({ hasText: "Read-only until the connection is back" }).first().waitFor();
			expect(await page.getByLabel("Summary").isDisabled()).toBe(true);
			await expectAccessibleScreen(page, `Entry editor read-only after 5 minutes offline (${theme})`);
			await page.close();
		});
	}
});

describe("the Globals editor", () => {
	test("is shared too, with the same presence", async () => {
		const ada = await install.newPage("light");
		const eve = await install.newPage("dark");
		for (const [page, account] of [
			[ada, staff],
			[eve, editor],
		] as const) {
			await install.signIn(page, account);
			await page.goto(install.adminUrl(`/sites/${siteId}/globals`));
			await page.getByRole("status").filter({ hasText: "All changes saved" }).first().waitFor();
		}
		await ada.getByLabel("Phone").focus();
		await eve.getByText("Ada Staff is here").waitFor();
		await ada.getByLabel("Phone").fill("+353 21 000 0000");
		await eve.locator('[value="+353 21 000 0000"]').waitFor();
		await expectAccessibleScreen(eve, "Globals editor with someone else in a Field (dark)");
		await ada.close();
		await eve.close();
	});
});

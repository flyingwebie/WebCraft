// Rich text from a shared document in the admin, in a real browser (ADR 0025, audit A3-1). An editor's
// socket takes any Yjs update, so an Author can send rich text holding script; a Staff member with the
// same Entry open gets a new Repeater row whose rich text box starts with the document's value. Two
// things keep that from running in the admin: the server forwards the value as the save cleaned it,
// and the rich text box cleans what it is given before showing it. Each is tested on its own: the
// second by putting a change the server never sent into the socket on its way to the page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDraftClient, type DocumentJson, decodeFrame, encodeFrame } from "@webcraft/core";
import type { Page } from "playwright";

import { openDraft } from "../harness/co-editing.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let author: TestBrowser;
let siteId: string;
let postTypeId: string;

/** Rich text no editor writes: an image that runs script when it fails to load, and a script. */
const HOSTILE = '<p>Proof</p><img src="x" onerror="window.pwned = 1"><script>window.pwned = 2</script>';

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await local.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	staff = created.account;
	author = (await local.createMember({ workspaceId, role: "author", name: "Al Author" })).browser;
	const { postType } = await created.browser.api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "notes", label: "Notes", type: "repeater", fields: [{ key: "note", label: "Note", type: "richText" }] },
		],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install?.close();
});

/** An Entry the Author wrote, which Staff may open too. */
async function newEntry(title: string): Promise<string> {
	return (await author.api.entries.create({ siteId, postTypeId, title })).entry.id;
}

async function openEntry(page: Page, entryId: string): Promise<void> {
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
	await page.getByRole("status").filter({ hasText: "All changes saved" }).first().waitFor();
}

/** The Draft with a row added to its Notes, as an editor adds one. */
function withNote(draft: DocumentJson, id: string, note: string): DocumentJson {
	const values = (draft as { values?: Record<string, DocumentJson> } | null)?.values ?? {};
	const rows = (values.notes as { rows?: DocumentJson[] } | undefined)?.rows ?? [];
	return { values: { ...values, notes: { rows: [...rows, { id, values: { note: { en: note } } }] } } };
}

/** What the page holds of the hostile value once the new row's rich text box shows its text. */
async function whatRan(page: Page): Promise<{ pwned: unknown; images: number; handlers: number }> {
	await page.getByRole("textbox", { name: "Note", includeHidden: true }).filter({ hasText: "Proof" }).waitFor({
		state: "attached",
	});
	// An image that fails to load says so a moment after it is put in the page.
	await page.waitForTimeout(500);
	return {
		pwned: await page.evaluate(() => (window as { pwned?: unknown }).pwned ?? null),
		images: await page.locator('[role="textbox"] img').count(),
		handlers: await page.locator("[onerror]").count(),
	};
}

describe("rich text holding script, sent into a shared Draft", () => {
	test("reaches someone else's open editor cleaned, and nothing of it runs", async () => {
		const entryId = await newEntry("Fresh bread");
		const ada = await install.newPage("light");
		await openEntry(ada, entryId);

		// Al sends the change over his own socket, as any client holding his session can.
		const al = await openDraft(install.install, author, siteId, { kind: "entry", id: entryId });
		al.change((draft) => withNote(draft, "row1", HOSTILE));
		await al.saved();

		expect(await whatRan(ada)).toEqual({ pwned: null, images: 0, handlers: 0 });
		al.close();
		await ada.close();
	});

	test("is cleaned by the rich text box itself when a document holds it uncleaned", async () => {
		const entryId = await newEntry("Rye bread");
		const ada = await install.newPage("light");
		let inject: (() => void) | undefined;
		// The socket goes through the test, which keeps a copy of the document as the page's editor
		// does and can add a change the server never checked, as a document kept before it cleaned would hold.
		await ada.routeWebSocket(/\/api\/drafts\/[^/]+\/entry\//, (socket) => {
			const upstream = socket.connectToServer();
			const sent: Uint8Array[] = [];
			const shadow = createDraftClient({ sendEveryMs: 0 });
			const ends = shadow.connect({
				send: (data) => {
					if (typeof data !== "string") sent.push(data);
				},
				close: () => {},
			});
			upstream.onMessage((message) => {
				socket.send(message);
				ends.receive(typeof message === "string" ? message : new Uint8Array(message));
			});
			inject = () => {
				if (!shadow.change((draft) => withNote(draft, "row1", HOSTILE))) throw new Error("The copy can't be changed.");
				shadow.flush();
				const change = sent.map(decodeFrame).findLast((frame) => frame?.kind === "change");
				if (!change) throw new Error("The copy made no change.");
				socket.send(Buffer.from(encodeFrame("changed", change.data)));
			};
		});
		await openEntry(ada, entryId);
		if (!inject) throw new Error("The editor opened no socket.");
		inject();

		expect(await whatRan(ada)).toEqual({ pwned: null, images: 0, handlers: 0 });
		await ada.close();
	});
});

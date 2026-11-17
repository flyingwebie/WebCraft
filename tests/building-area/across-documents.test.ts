// Before the cutover (BA-34), on the server:
// - opening a Template with a Filter selected: the admin's way in takes `wc-filter` (a Filter's id)
//   after a Template's or Component's address, the link lands on the shell with it, and the shell's
//   page carries it to the shell (not to the page in the frame); anything else is refused;
// - the Popup review: Publish for a Popup's Component (the document) names its Popup, whether it
//   changed and where it is reviewed in the admin, and never publishes it from the bar.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type DocumentPublish, isBuildingDocument, parseBuildingDocument } from "@webcraft/core";

import { openBuildingArea } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
let siteId: string;
let postTypeId: string;

const FILTER = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	postTypeId = (await staff.api.postTypes.create({ siteId, name: "Products", urlPattern: "/products/{slug}" })).postType
		.id;
});

afterAll(async () => {
	await install.close();
});

describe("a Template opened with a Filter selected", () => {
	test("the address takes one Filter's id after a Template or a Component, and leaves it out of the document", () => {
		expect(parseBuildingDocument(`/archive-template/${postTypeId}?wc-filter=${FILTER}`)).toEqual({
			kind: "archiveTemplate",
			postTypeId,
		});
		expect(parseBuildingDocument(`/entry-template/${postTypeId}?entry=${FILTER}&wc-filter=${FILTER}`)).toEqual({
			kind: "entryTemplate",
			postTypeId,
			entryId: FILTER,
		});
		expect(isBuildingDocument(`/site-template?wc-filter=${FILTER}`)).toBe(true);
		expect(isBuildingDocument(`/component/${FILTER}?wc-filter=${FILTER}`)).toBe(true);
		for (const refused of [
			`/archive-template/${postTypeId}?wc-filter=nope`,
			`/archive-template/${postTypeId}?wc-filter=${FILTER}&wc-filter=${FILTER}`,
			`/archive-template/${postTypeId}?wc-filter=${FILTER}&other=1`,
			"/site-template?wc-select=site%23header",
		]) {
			expect([refused, isBuildingDocument(refused)]).toEqual([refused, false]);
		}
	});

	test("the admin's way in lands on the shell with it, and the shell keeps it from the frame's page", async () => {
		const open = `/archive-template/${postTypeId}?wc-filter=${FILTER}`;
		const area = await openBuildingArea(install, staff, siteId, { open });
		expect(area.landed).toBe(`/_webcraft/build${open}`);

		const shell = await area.shell(area.landed);
		expect(shell.status).toBe(200);
		const filtered = await area.shell(`/_webcraft/build/page/products?wc-filter=${FILTER}`);
		expect(filtered.status).toBe(200);
		// The page's own address in the shell's config is the page, without the shell's parameter.
		expect(await filtered.text()).toContain('"page":"/products"');
	});

	test("a link naming something that isn't a Filter's id is refused when it is made", async () => {
		expect(
			await rejection(
				staff.api.editMode.open({
					siteId,
					open: `/archive-template/${postTypeId}?wc-filter=<script>`,
				}),
			),
		).toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("the Popup review before publishing", () => {
	let popupId: string;
	let componentId: string;
	/** The Site's other Drafts while the Popup is as published. */
	let others: number;

	beforeAll(async () => {
		const { popup } = await staff.api.popups.create({ siteId, name: "Offer", key: "offer" });
		popupId = popup.id;
		componentId = popup.componentId;
		await staff.api.components.saveMarkup({ siteId, componentId, markup: "<p>Original Popup tree</p>" });
		await staff.api.popups.publish({ siteId, popupId });
	});

	async function publishFor(admin: TestBrowser, id: string): Promise<DocumentPublish> {
		const area = await openBuildingArea(install, admin, siteId);
		const response = await area.edit("publish/items", { path: null, sources: [{ kind: "component", id }] });
		expect(response.status).toBe(200);
		return (await response.json()) as DocumentPublish;
	}

	test("a Popup's Component names its Popup and its review in the admin, as published", async () => {
		const answer = await publishFor(staff, componentId);
		expect(answer.popup).toEqual({
			id: popupId,
			name: "Offer",
			changed: false,
			review: expect.stringMatching(new RegExp(`/sites/${siteId}/popups\\?popup=${popupId}$`)),
		});
		expect(answer.items).toEqual([]);
		others = answer.otherDrafts;
	});

	test("once its tree changes, the Popup is changed, and the bar still publishes neither it nor its Component", async () => {
		await staff.api.components.saveMarkup({ siteId, componentId, markup: "<p>Revised Popup tree</p>" });
		const answer = await publishFor(staff, componentId);
		expect(answer.popup).toMatchObject({ id: popupId, changed: true });
		expect(answer.items).toEqual([]);
		expect(answer.drafts).toEqual([]);
		// It is the review's, not one more of the other Drafts Publish all would hold.
		expect(answer.otherDrafts).toBe(others);
	});

	test("an ordinary Component has no Popup, and a Member gets none", async () => {
		const { component } = await staff.api.components.create({ siteId, name: "Badge" });
		expect((await publishFor(staff, component.id)).popup).toBeNull();
		expect((await publishFor(editor, componentId)).popup).toBeNull();
	});
});

// Who imports: Staff, Owners and Editors (`import.run`), never Authors. The run writes Drafts as the
// person who started it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csv, csvSettings, importCsv } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let postTypeId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Products", urlPattern: "/products/{slug}" });
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

const settings = () => csvSettings(postTypeId, [{ column: "name", to: "title" }]);

describe("who imports", () => {
	test("an Owner imports a CSV file; the Drafts are theirs", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });

		const { run } = await importCsv(install, owner.browser.api, siteId, settings(), "name\nPumpkin loaf\n");

		expect(run).toMatchObject({ status: "done", startedBy: { id: owner.personId }, counts: { created: 1 } });
		const { entries } = await owner.browser.api.entries.list({ siteId, postTypeId });
		expect(entries.find((entry) => entry.draft.title === "Pumpkin loaf")?.author).toMatchObject({
			id: owner.personId,
		});
	});

	test("an Author can't create, run, read or undo Imports", async () => {
		const { run, importId } = await importCsv(install, staff.api, siteId, settings(), "name\nSeeded rye\n");
		const author = (await install.createMember({ workspaceId, role: "author" })).browser.api;
		const fileId = crypto.randomUUID();
		const refusals = [
			() => author.imports.uploadCsv({ siteId, file: csv("name\nRye\n") }),
			() => author.imports.preview({ siteId, fileId, settings: settings() }),
			() => author.imports.list({ siteId }),
			() => author.imports.get({ siteId, importId }),
			() => author.imports.create({ siteId, name: "Mine", source: "csv", settings: settings() }),
			() => author.imports.update({ siteId, importId, name: "Mine" }),
			() => author.imports.start({ siteId, importId, fileId }),
			() => author.imports.stop({ siteId, runId: run.id }),
			() => author.imports.report({ siteId, runId: run.id }),
			() => author.imports.undo({ siteId, runId: run.id }),
		];
		for (const refusal of refusals) {
			await expect(refusal()).rejects.toMatchObject({ code: "FORBIDDEN", data: { permission: "import.run" } });
		}
	});
});

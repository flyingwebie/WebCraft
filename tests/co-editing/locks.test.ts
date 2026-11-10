// Lock order between a live change and every other Draft writer (ADR 0025): every writer that
// touches a Page's parent or the Site's paths (`saveDraft`, `publishEntry`, `publishItems`,
// `renameComponent`, `deleteComponent`, `saveSiteTemplate`, `saveComponentDraft`, `post-types.ts`,
// `site-languages.ts`) takes the advisory lock its save needs (`lockSitePaths`, `lockComponents`)
// before the item's own row, so two of them never wait on each other in a circle. A live change
// (`hub.ts`'s `applyChange`, and `load`) takes the same locks the same way (`locks.ts`'s `lockItem`),
// so a live Page move racing a publish of the same Page never deadlocks (Postgres `40P01`).
//
// A true deadlock needs both sides' two lock acquisitions to interleave exactly (each already
// holding what the other waits for): this test can't force that interleaving without reaching
// hub.ts's internals, so it races the two paths many times instead, over real connections, and
// asserts every live change lands or is refused with a known code -- never the generic
// INTERNAL_SERVER_ERROR a dropped deadlock showed before the fix -- and that every publish call
// answers the same way. It is a stress test, not a deterministic reproduction.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { withValue } from "./support.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with two top-level Pages (A, B) and a Page (C) under A, all published. */
async function pagesSite(): Promise<{ siteId: string; a: string; b: string; c: string }> {
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `locks-${++sites}` })).id;
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pagesId = postTypes.find((postType) => postType.builtIn === "page")?.id ?? "";
	const page = async (title: string, parentId?: string) => {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: pagesId, title, parentId });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		return entry.id;
	};
	const a = await page("Section A");
	const b = await page("Section B");
	const c = await page("Moving page", a);
	return { siteId, a, b, c };
}

describe("a live Page move racing a publish of the same Page", () => {
	test("every change lands or is refused with a known code, never INTERNAL_SERVER_ERROR", async () => {
		const { siteId, a, b, c } = await pagesSite();
		const mover = await openDraft(install, editor, siteId, { kind: "entry", id: c });

		const ROUNDS = 30;
		const publishErrors: unknown[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			mover.change((draft) => withValue(draft, "parent", round % 2 === 0 ? a : b, "en"));
			await Promise.all([
				mover.saved(),
				staff.api.entries.publish({ siteId, entryId: c }).catch((error: unknown) => {
					publishErrors.push(error);
				}),
			]);
		}

		expect(mover.refusals.map((refusal) => refusal.code)).not.toContain("INTERNAL_SERVER_ERROR");
		for (const error of publishErrors) expect(error).not.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });

		// The Entry is still readable and in a consistent state after the race.
		const { entry } = await staff.api.entries.get({ siteId, entryId: c });
		expect([a, b]).toContain(entry.draft.parentId as string);
		mover.close();
	});
});

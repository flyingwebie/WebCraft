// A Module's Site routes: requests under /_wc/m/<route prefix>/ on Sites where it runs, answered by
// the Module and never cached as pages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { sample } from "./sample/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	await (await install.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	workspaceId = (await install.createWorkspace()).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const notes = (browser: TestBrowser) => moduleApi<typeof sample>(browser, "sample").notes;

/** A new Site with the sample Module on, and the address of its Staging host. */
async function newSite() {
	const site = await install.createSite(workspaceId);
	return { id: site.id, url: (path: string) => `https://${site.slug}.sites.test${path}` };
}

describe("a Module's Site routes", () => {
	test("answer visitors on Sites where the Module runs, with that Site's data, and are never cached", async () => {
		const site = await newSite();
		const other = await newSite();
		await notes(staff).add({ siteId: site.id, body: "Opening hours change on Monday" });
		await notes(staff).add({ siteId: other.id, body: "Another Site's note" });

		const first = await install.request(site.url("/_wc/m/sample/notes"));

		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		expect(first.headers.get("x-cache")).toBeNull();
		expect(first.headers.get("x-robots-tag")).toBe("noindex");
		expect(await first.json()).toEqual({ notes: [{ body: "Opening hours change on Monday", source: "person" }] });

		await notes(staff).add({ siteId: site.id, body: "And on Tuesday" });
		const second = await install.request(site.url("/_wc/m/sample/notes"));
		expect(((await second.json()) as { notes: unknown[] }).notes).toHaveLength(2);
	});

	test("take posts from visitors, and path parameters", async () => {
		const site = await newSite();

		const posted = await install.request(site.url("/_wc/m/sample/notes"), {
			method: "POST",
			body: new URLSearchParams({ body: "Left by a visitor" }),
		});

		expect(posted.status).toBe(201);
		const { note } = (await posted.json()) as { note: { id: string } };
		const one = await install.request(site.url(`/_wc/m/sample/notes/${note.id}`));
		expect(await one.json()).toEqual({ body: "Left by a visitor" });
		expect((await notes(staff).list({ siteId: site.id })).notes).toEqual([
			expect.objectContaining({ body: "Left by a visitor", source: "visitor" }),
		]);
		expect((await install.request(site.url(`/_wc/m/sample/notes/${crypto.randomUUID()}`))).status).toBe(404);
	});

	test("answer HEAD for their GET routes, and 405 for a method they don't take", async () => {
		const site = await newSite();

		const head = await install.request(site.url("/_wc/m/sample/notes"), { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");

		const put = await install.request(site.url("/_wc/m/sample/notes"), { method: "PUT", body: "x" });
		expect(put.status).toBe(405);
		expect(put.headers.get("allow")).toBe("GET, POST, HEAD");
	});

	test("are the plain 404 where the Module is off, for paths it doesn't declare, and for other prefixes", async () => {
		const site = await newSite();
		await staff.api.modules.setOnSite({ siteId: site.id, moduleId: "sample", on: false });

		for (const path of ["/_wc/m/sample/notes", "/_wc/m/nobody/notes", "/_wc/m/sample/undeclared", "/_wc/m/"]) {
			const answer = await install.request(site.url(path));
			expect([path, answer.status, await answer.text()]).toEqual([path, 404, "Not Found"]);
		}
		const running = await newSite();
		const undeclared = await install.request(running.url("/_wc/m/sample/undeclared"));
		expect([undeclared.status, await undeclared.text()]).toEqual([404, "Not Found"]);
	});

	test("that fail answer a plain 500 and leave the reason in the Module log", async () => {
		const site = await newSite();

		const answer = await install.request(site.url("/_wc/m/sample/broken"));

		expect(answer.status).toBe(500);
		expect(await answer.text()).toBe("Internal Server Error");
		const { lines } = await (await install.superadmin()).api.modules.log({ moduleId: "sample" });
		expect(lines[0]).toMatchObject({
			level: "error",
			message: "The Site route GET /broken failed.",
			siteId: site.id,
			details: { error: { message: "The sample's broken route broke, as it should." } },
		});
	});

	test("don't answer while the Module waits for approval", async () => {
		const waiting = await createTestInstall({ modules: [sample] });
		try {
			const site = await waiting.createSite((await waiting.createWorkspace()).id);

			const answer = await waiting.request(`https://${site.slug}.sites.test/_wc/m/sample/notes`);

			expect(answer.status).toBe(404);
		} finally {
			await waiting.close();
		}
	});
});

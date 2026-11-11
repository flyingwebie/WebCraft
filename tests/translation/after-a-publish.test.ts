// What hears of a change once it is saved (the Module host, Webhooks, Social cards, AI translation,
// Review emails) hears of it whatever the others do: one that fails is logged, and the rest go on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { freshBread, translatedSite, visit } from "./support.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

describe("a publish whose Social card can't be queued", () => {
	test("is still translated, and the failure is logged", async () => {
		const site = await translatedSite(install, { de: "automatic" });
		const entryId = await freshBread(site);
		install.refuseJobs(["socialCards.render"]);

		try {
			const { entry } = await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
			expect(entry.status).toBe("published");
		} finally {
			install.refuseJobs([]);
		}
		expect((await install.drainJobs()).failed).toEqual([]);

		expect((await visit(install, site, "/de/blog/fresh-bread")).article).toContain("<h1>[de] Fresh bread</h1>");
		expect(
			install.logs.filter(
				(line) =>
					line.level === "error" && JSON.stringify(line).includes('did not accept a \\"socialCards.render\\" job'),
			),
		).toEqual([expect.objectContaining({ siteId: site.siteId, action: "entry.publish" })]);
	});
});

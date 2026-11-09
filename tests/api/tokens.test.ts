// API tokens (spec › Management API): made by a person under Your account › API tokens, for one
// Workspace, shown once and kept only as a hash; scripts call `/api/v1` with one, acting as that
// person, recorded in the Audit log as the token.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

describe("a token at work", () => {
	test("a script with a token reads its Workspace through /api/v1, as the token's person", async () => {
		const workspace = await install.createWorkspace("Acme");
		const site = await install.createSite(workspace.id, { name: "Acme Bakery" });
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { secret } = await createApiToken(owner.browser, { workspaceId: workspace.id, name: "Deploy script" });

		const script = tokenClient(install, secret);
		const { sites } = await script.api.sites.list({ workspaceId: workspace.id });

		expect(sites.map((listed) => listed.id)).toEqual([site.id]);
	});
});

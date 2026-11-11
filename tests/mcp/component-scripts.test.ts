// Component scripts through the MCP server (ADR 0030): an AI client with the Structure Toolset reads
// and saves a Component's script with the tools generated from the public Management API, as Staff do
// in Code mode; its Component's publish then publishes it too.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { answerOf, approveAiClient, connectMcp, refusalOf } from "../harness/mcp.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let componentId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const admin = await install.superadmin();
	componentId = (await admin.api.components.create({ siteId, name: "PriceCard", props: [] })).component.id;
});

afterAll(async () => {
	await install.close();
});

test("an AI client with the Structure Toolset saves and reads a Component script's Draft", async () => {
	const staff = await install.createStaff({ workspaces: [workspaceId] });
	const client = await connectMcp(
		install,
		(await approveAiClient(install, staff.browser, { workspaceId, toolsets: ["structure"] })).accessToken,
	);
	const code = "export default (root) => { root.dataset.price = 'shown'; };";

	const saved = answerOf<{
		script: { draft: { code: string; consentCategory: string; libraryIds: string[] } };
		version: string;
	}>(
		await client.callTool({
			name: "components_save_script_draft",
			arguments: { siteId, componentId, code, consentCategory: "analytics", basedOn: null },
		}),
	);
	expect(saved.script.draft).toEqual({ code, consentCategory: "analytics", libraryIds: [] });

	const read = answerOf<{ script: { draft: { code: string }; status: string } }>(
		await client.callTool({ name: "components_get_script", arguments: { siteId, componentId } }),
	);
	expect(read.script).toMatchObject({ status: "draft", draft: { code } });
	// A stale save is refused, as in Code mode.
	const stale = refusalOf(
		await client.callTool({
			name: "components_save_script_draft",
			arguments: { siteId, componentId, code: "export default () => {};", basedOn: null },
		}),
	);
	expect(stale.code).toBe("CHANGED_MEANWHILE");
	await client.close();
});

test("a client without the Structure Toolset has no such tools", async () => {
	const owner = await install.createMember({ workspaceId, role: "owner" });
	const client = await connectMcp(
		install,
		(await approveAiClient(install, owner.browser, { workspaceId, toolsets: ["content"] })).accessToken,
	);
	const names = (await client.listTools()).tools.map((tool) => tool.name);
	expect(names).not.toContain("components_save_script_draft");
	expect(names).not.toContain("components_get_script");
	await client.close();
});

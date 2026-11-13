// What AI clients read before they write: the Template markup reference, a Site's schema and its
// Protected terms, as resources and through the hand-written `guide_get` tool, which gathers in one
// call what would take many. A client reads only what its Toolsets and its person allow.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { answerOf, approveAiClient, connectMcp, refusalOf } from "../harness/mcp.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let otherSiteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	otherSiteId = (await install.createSite((await install.createWorkspace("Other")).id)).id;
	const admin = await install.superadmin();
	await admin.api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [{ key: "serves", type: "number", label: "Serves" }],
	});
	await admin.api.components.create({ siteId, name: "PriceCard", props: [] });
});

afterAll(async () => {
	await install.close();
});

describe("guide_get", () => {
	test("template-markup is the reference of Template markup, naming its commands and formatters", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const client = await connectMcp(
			install,
			(await approveAiClient(install, owner.browser, { workspaceId })).accessToken,
		);

		const result = await client.callTool({ name: "guide_get", arguments: { topic: "template-markup" } });
		const text = (result.content as { text: string }[])[0]?.text ?? "";
		expect(text).toStartWith("# Template markup");
		for (const name of ["{{@if}}", "{{@loop}}", "{{@outlet}}", "`truncate`", "`date`", "data-wc-id"]) {
			expect({ name, named: text.includes(name) }).toEqual({ name, named: true });
		}
		await client.close();
	});

	test("site-schema gathers a Site's languages, Post Types with their Fields, Components and Loops", async () => {
		const staff = await install.createStaff({ workspaces: [workspaceId] });
		const client = await connectMcp(
			install,
			(await approveAiClient(install, staff.browser, { workspaceId, toolsets: ["content", "structure"] })).accessToken,
		);

		const schema = answerOf<{
			site: { id: string; name: string };
			languages: unknown;
			postTypes: { name: string; fields: { key: string }[] }[];
			components: { name: string }[];
			loops: unknown[];
			unavailable: string[];
		}>(await client.callTool({ name: "guide_get", arguments: { topic: "site-schema", siteId } }));

		expect(schema.site).toMatchObject({ id: siteId, name: "Acme Bakery" });
		expect(schema.languages).not.toBeNull();
		expect(
			schema.postTypes.find((postType) => postType.name === "Recipes")?.fields.map((field) => field.key),
		).toContain("serves");
		expect(schema.components.map((component) => component.name)).toContain("PriceCard");
		expect(schema.loops).toEqual([]);
		await client.close();
	});

	test("leaves out what the client may not read: an Editor's client sees no Components or Loops", async () => {
		const editor = await install.createMember({ workspaceId, role: "editor" });
		const client = await connectMcp(
			install,
			(await approveAiClient(install, editor.browser, { workspaceId, toolsets: ["content", "structure"] })).accessToken,
		);
		const schema = answerOf<{ postTypes: unknown[]; components: unknown; unavailable: string[] }>(
			await client.callTool({ name: "guide_get", arguments: { topic: "site-schema", siteId } }),
		);
		expect(schema.postTypes.length).toBeGreaterThan(0);
		expect(schema.components).toBeNull();
		expect(schema.unavailable).toEqual(expect.arrayContaining(["components", "loops"]));
		await client.close();
	});

	test("never reads a Site outside the client's reach", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const client = await connectMcp(
			install,
			(await approveAiClient(install, owner.browser, { workspaceId })).accessToken,
		);
		for (const topic of ["site-schema", "protected-terms"]) {
			const refused = await client.callTool({ name: "guide_get", arguments: { topic, siteId: otherSiteId } });
			expect({ topic, code: refusalOf(refused).code }).toEqual({ topic, code: "SITE_NOT_FOUND" });
		}
		await client.close();
	});

	test("protected-terms lists the words the Site never translates", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const client = await connectMcp(
			install,
			(await approveAiClient(install, owner.browser, { workspaceId })).accessToken,
		);
		const answer = answerOf<{ terms: unknown[] }>(
			await client.callTool({ name: "guide_get", arguments: { topic: "protected-terms", siteId } }),
		);
		expect(answer.terms).toEqual([]);
		await client.close();
	});
});

describe("resources", () => {
	test("list the reference, and each reached Site's schema and Protected terms; reading one answers the guide", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const client = await connectMcp(
			install,
			(await approveAiClient(install, owner.browser, { workspaceId })).accessToken,
			{
				era: "modern",
			},
		);

		const { resources } = await client.listResources();
		expect(resources.map((resource) => resource.uri)).toEqual([
			"webcraft://guides/template-markup",
			`webcraft://sites/${siteId}/schema`,
			`webcraft://sites/${siteId}/protected-terms`,
		]);
		const { resourceTemplates } = await client.listResourceTemplates();
		expect(resourceTemplates.map((template) => template.uriTemplate)).toEqual([
			"webcraft://sites/{siteId}/schema",
			"webcraft://sites/{siteId}/protected-terms",
		]);

		const read = await client.readResource({ uri: `webcraft://sites/${siteId}/schema` });
		const content = read.contents[0] as { text: string; mimeType: string };
		expect(content.mimeType).toBe("application/json");
		expect(JSON.parse(content.text).site.id).toBe(siteId);
		await expect(client.readResource({ uri: `webcraft://sites/${otherSiteId}/schema` })).rejects.toThrow();
		await client.close();
	});
});

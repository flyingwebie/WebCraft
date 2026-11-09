// MCP tools are generated from the public Management API (ADR 0030): one tool per public procedure,
// named `noun_verb` after its operation id, with its input schema from the OpenAPI document, and
// grouped in Toolsets. Internal procedures and Sensitive actions never become tools. Checked here
// through `tools/list`, as an AI client holding an API token with every Toolset sees it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@modelcontextprotocol/client";
import { FIRST_PARTY_MODULES, TOOLSETS } from "@webcraft/core";

import { createApiToken } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { connectMcp } from "../harness/mcp.ts";

type Operation = {
	operationId: string;
	summary: string;
	requestBody?: { content: Record<string, { schema: Record<string, unknown> }> };
	"x-webcraft-access": "read" | "write";
	"x-webcraft-toolsets": string[] | "always";
	"x-webcraft-sensitive"?: string;
	"x-webcraft-confirmation"?: true;
};

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const EVERY_TOOLSET: string[] = [...TOOLSETS];

let install: TestInstall;
let operations: Operation[];
let tools: Map<string, Tool>;

beforeAll(async () => {
	install = await createTestInstall({ modules: FIRST_PARTY_MODULES });
	const document = (await (await install.request(install.adminUrl("/api/v1/openapi.json"))).json()) as {
		paths: Record<string, Record<string, Operation>>;
	};
	operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const admin = await install.superadmin();
	// Every first-party Module approved and on, so its tools are there to list.
	for (const module of (await admin.api.modules.list()).modules) {
		if (module.status !== "approved") await admin.api.modules.approve({ moduleId: module.id, version: module.version });
		if (module.level === "site") await admin.api.modules.setOnSite({ siteId: site.id, moduleId: module.id, on: true });
	}
	const { secret } = await createApiToken(admin, {
		workspaceId: workspace.id,
		name: "Every tool",
		toolsets: EVERY_TOOLSET,
	});
	const client = await connectMcp(install, secret);
	tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
	await client.close();
});

afterAll(async () => {
	await install.close();
});

describe("tool names", () => {
	test("follow each procedure's operation id: noun_verb, a Module's tools starting with its id", () => {
		const names = [...tools.keys()];
		for (const [operationId, name] of [
			["entries.publish", "entries_publish"],
			["entries.saveDraft", "entries_save_draft"],
			["postTypes.list", "post_types_list"],
			["media.folders.list", "media_folders_list"],
			["templates.getEntryTemplateMarkup", "templates_get_entry_template_markup"],
			["publishing.publishAll", "publishing_publish_all"],
			["m.redirects.rules.list", "redirects_rules_list"],
			["m.site-analytics.stats.totals", "site_analytics_stats_totals"],
			["m.forms.submissions.get", "forms_submissions_get"],
		]) {
			expect({ operationId, listed: names.includes(name as string) }).toEqual({ operationId, listed: true });
		}
	});

	test("are unique and short, of lower-case letters, digits and underscores", () => {
		for (const name of tools.keys()) expect(name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
		expect(new Set(tools.keys()).size).toBe(tools.size);
	});
});

describe("one tool per public procedure", () => {
	test("every public procedure but the Sensitive actions is a tool, plus the hand-written guide", () => {
		const generated = [...tools.values()].filter((tool) => tool.name !== "guide_get");
		const expected = operations.filter((operation) => !operation["x-webcraft-sensitive"]);
		expect(generated.map((tool) => tool._meta?.["webcraft/operation"]).sort()).toEqual(
			expected.map((operation) => operation.operationId).sort(),
		);
		expect(tools.has("guide_get")).toBe(true);
	});

	test("Sensitive actions are never tools", () => {
		const sensitive = operations.filter((operation) => operation["x-webcraft-sensitive"]);
		expect(sensitive.length).toBeGreaterThan(0);
		const listed = [...tools.values()].map((tool) => tool._meta?.["webcraft/operation"]);
		for (const operation of sensitive) {
			expect({ sensitive: operation.operationId, listed: listed.includes(operation.operationId) }).toEqual({
				sensitive: operation.operationId,
				listed: false,
			});
		}
		for (const name of ["members_invite", "webhooks_add", "staging_set_password", "site_smtp_update"]) {
			expect({ name, listed: tools.has(name) }).toEqual({ name, listed: false });
		}
	});

	test("the admin's own procedures are never tools", () => {
		for (const name of [
			"api_tokens_create",
			"api_tokens_list",
			"me_change_password",
			"session_sign_in",
			"setup_claim",
			"install_settings_update",
			"workspaces_create",
			"staff_invite",
			"audit_list",
			"modules_approve",
			"oauth_approve",
			"ai_clients_list",
			"edit_mode_open",
		]) {
			expect({ name, listed: tools.has(name) }).toEqual({ name, listed: false });
		}
	});
});

describe("each tool", () => {
	test("takes the procedure's input schema and says what it does", () => {
		for (const operation of operations.filter((each) => !each["x-webcraft-sensitive"])) {
			const tool = [...tools.values()].find((each) => each._meta?.["webcraft/operation"] === operation.operationId);
			const content = operation.requestBody?.content ?? {};
			const schema = content["application/json"]?.schema ?? content["multipart/form-data"]?.schema;
			expect(tool?.description).toStartWith(operation.summary);
			expect(tool?.inputSchema.type).toBe("object");
			if (schema && !("multipart/form-data" in content)) expect(tool?.inputSchema).toEqual(schema as never);
		}
	});

	test("takes a file as its name, type and base64 content", () => {
		const upload = tools.get("media_upload");
		expect(upload?.inputSchema.properties?.file).toMatchObject({
			type: "object",
			properties: { name: { type: "string" }, base64: { type: "string", contentEncoding: "base64" } },
		});
		expect(upload?.inputSchema.required).toEqual(expect.arrayContaining(["siteId", "file"]));
	});

	test("says whether it only reads, and whether it changes something past undoing in two steps", () => {
		expect(tools.get("entries_list")?.annotations).toMatchObject({ readOnlyHint: true });
		expect(tools.get("entries_save_draft")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
		expect(tools.get("entries_publish")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		expect(tools.get("entries_publish")?.description).toContain("confirmation");
		expect(tools.get("media_empty_trash")?.annotations).toMatchObject({ destructiveHint: true });
	});
});

describe("Toolsets", () => {
	test("every tool belongs to a Toolset, or to every client", () => {
		for (const tool of tools.values()) {
			const toolsets = tool._meta?.["webcraft/toolsets"];
			expect({
				tool: tool.name,
				grouped: toolsets === "always" || (Array.isArray(toolsets) && toolsets.length > 0),
			}).toEqual({
				tool: tool.name,
				grouped: true,
			});
		}
	});

	test("only the Forms Module's Submissions procedures are in the Submissions Toolset", () => {
		const inSubmissions = [...tools.values()]
			.filter((tool) => (tool._meta?.["webcraft/toolsets"] as string[] | undefined)?.includes?.("submissions"))
			.map((tool) => tool.name)
			.sort();
		expect(inSubmissions).toEqual(
			[
				"forms_submissions_delete",
				"forms_submissions_export",
				"forms_submissions_get",
				"forms_submissions_list",
				"forms_submissions_not_spam",
				"forms_submissions_set_read",
			].sort(),
		);
	});

	test("groups tools as the document does", () => {
		expect(tools.get("entries_save_draft")?._meta?.["webcraft/toolsets"]).toEqual(["content"]);
		expect(tools.get("templates_save_site_template_markup")?._meta?.["webcraft/toolsets"]).toEqual(["structure"]);
		expect(tools.get("media_upload")?._meta?.["webcraft/toolsets"]).toEqual(["media"]);
		expect(tools.get("publishing_publish_all")?._meta?.["webcraft/toolsets"]).toEqual(["publishing"]);
		expect(tools.get("site_analytics_stats_totals")?._meta?.["webcraft/toolsets"]).toEqual(["analytics"]);
		expect(tools.get("redirects_rules_add")?._meta?.["webcraft/toolsets"]).toEqual(["content"]);
		expect(tools.get("sites_list")?._meta?.["webcraft/toolsets"]).toBe("always");
	});
});

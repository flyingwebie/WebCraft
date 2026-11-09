// AI clients at work through the MCP server (`/mcp`): a session lists only the tools its Toolsets
// and its person's Permissions allow, reads and writes as its person ("<person> via <client>" in
// the Audit log), and confirms publishing and deleting: in two calls with a confirmation id, or by
// asking its person when the client can (the 2026-07-28 revision's questions).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { answerOf, approveAiClient, connectMcp, refusalOf } from "../harness/mcp.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let pagesId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery" })).id;
	const admin = await install.superadmin();
	const { postTypes } = await admin.api.postTypes.list({ siteId });
	pagesId = postTypes.find((postType) => postType.builtIn === "page")?.id as string;
});

afterAll(async () => {
	await install.close();
});

async function toolNames(token: string, era: "modern" | "legacy" = "legacy"): Promise<string[]> {
	const client = await connectMcp(install, token, { era });
	const { tools } = await client.listTools();
	await client.close();
	return tools.map((tool) => tool.name);
}

describe("connecting", () => {
	test("a client of the 2025 revisions initializes; one of the 2026-07-28 revision needs no handshake", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId });
		for (const era of ["legacy", "modern"] as const) {
			const client = await connectMcp(install, accessToken, { era });
			expect(client.getServerVersion()).toMatchObject({ name: "webcraft" });
			expect(client.getInstructions()).toContain("sites_list");
			const result = await client.callTool({ name: "sites_list", arguments: { workspaceId } });
			expect(answerOf<{ sites: { id: string }[] }>(result).sites.map((site) => site.id)).toEqual([siteId]);
			await client.close();
		}
	});
});

describe("tools/list", () => {
	test("lists only the tools of the Toolsets switched on", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId, toolsets: ["media"] });
		const names = await toolNames(accessToken);

		expect(names).toEqual(expect.arrayContaining(["media_list", "media_upload", "sites_list", "guide_get"]));
		expect(names).not.toContain("entries_save_draft");
		expect(names).not.toContain("post_types_list");
		expect(names.every((name) => /^(media_|workspaces_|sites_(list|get)$|guide_get$)/.test(name))).toBe(true);
	});

	test("a read-only client lists only reads, and one that may not publish lists nothing that publishes", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const readOnly = await approveAiClient(install, owner.browser, { workspaceId, readOnly: true });
		const readNames = await toolNames(readOnly.accessToken);
		expect(readNames).toContain("entries_list");
		expect(readNames).not.toContain("entries_save_draft");
		expect(readNames).not.toContain("entries_publish");

		const writer = await approveAiClient(install, owner.browser, { workspaceId, mayPublish: false });
		const writeNames = await toolNames(writer.accessToken);
		expect(writeNames).toContain("entries_save_draft");
		expect(writeNames).not.toContain("entries_publish");
		expect(writeNames).not.toContain("publishing_publish_all");

		const publisher = await approveAiClient(install, owner.browser, { workspaceId, mayPublish: true });
		expect(await toolNames(publisher.accessToken)).toEqual(
			expect.arrayContaining(["entries_publish", "publishing_publish_all"]),
		);
	});

	test("lists only what the person may do: an Author's client has no Structure and no publishing", async () => {
		const author = await install.createMember({ workspaceId, role: "author" });
		const { accessToken } = await approveAiClient(install, author.browser, {
			workspaceId,
			toolsets: ["content", "structure", "publishing"],
			mayPublish: true,
		});
		const names = await toolNames(accessToken);

		expect(names).toEqual(expect.arrayContaining(["entries_list", "entries_save_draft"]));
		for (const name of [
			"entries_publish",
			"templates_save_site_template_markup",
			"components_create",
			"post_types_create",
		]) {
			expect({ name, listed: names.includes(name) }).toEqual({ name, listed: false });
		}
	});

	test("never lists a Sensitive action, whatever the Toolsets", async () => {
		const admin = await install.superadmin();
		const { accessToken } = await approveAiClient(install, admin, {
			workspaceId,
			toolsets: ["content", "media", "structure", "forms", "publishing", "translation", "siteSettings", "analytics"],
			mayPublish: true,
		});
		const names = await toolNames(accessToken, "modern");
		expect(names).toContain("webhooks_list");
		for (const name of [
			"webhooks_add",
			"members_invite",
			"members_remove",
			"staging_set_password",
			"forms_captcha_set",
		]) {
			expect({ name, listed: names.includes(name) }).toEqual({ name, listed: false });
		}
	});

	test("an API token works at /mcp too, with its own Toolsets", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { secret } = await createApiToken(owner.browser, { workspaceId, name: "Agent", toolsets: ["content"] });
		const names = await toolNames(secret);
		expect(names).toContain("entries_save_draft");
		expect(names).not.toContain("media_upload");
	});
});

describe("calling tools", () => {
	test("a read answers what the procedure answers", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId });
		const client = await connectMcp(install, accessToken);

		const { postTypes } = answerOf<{ postTypes: { id: string; builtIn: string | null }[] }>(
			await client.callTool({ name: "post_types_list", arguments: { siteId } }),
		);
		expect(postTypes.map((postType) => postType.id)).toContain(pagesId);
		await client.close();
	});

	test("a tool the session doesn't list can't be called, and a refusal comes back as the procedure's", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId, readOnly: true });
		const client = await connectMcp(install, accessToken);

		await expect(
			client.callTool({ name: "entries_create", arguments: { siteId, postTypeId: pagesId, title: "Nope" } }),
		).rejects.toThrow(/no tool entries_create/);
		const refused = await client.callTool({ name: "entries_get", arguments: { siteId, entryId: crypto.randomUUID() } });
		expect(refusalOf(refused).code).toBe("ENTRY_NOT_FOUND");
		await client.close();
	});

	test("a write acts as the person, recorded as '<person> via <client>'", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner", name: "Olive Owner" });
		const { accessToken } = await approveAiClient(
			install,
			owner.browser,
			{ workspaceId, mayPublish: true },
			{ client_name: "Writing assistant" },
		);
		const client = await connectMcp(install, accessToken);

		const { entry } = answerOf<{ entry: { id: string } }>(
			await client.callTool({ name: "entries_create", arguments: { siteId, postTypeId: pagesId, title: "About us" } }),
		);
		const first = answerOf<{ confirmation: { id: string }; preview: { name: string } }>(
			await client.callTool({ name: "entries_publish", arguments: { siteId, entryId: entry.id } }),
		);
		answerOf(
			await client.callTool({
				name: "entries_publish",
				arguments: { siteId, entryId: entry.id, confirmation: first.confirmation.id },
			}),
		);

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 10 });
		expect(entries.find((each) => each.action === "entry.publish" && each.details.entryId === entry.id)).toMatchObject({
			personId: owner.personId,
			via: { kind: "aiClient", name: "Writing assistant" },
			siteId,
		});
		await client.close();
	});
});

describe("history", () => {
	test("a Draft an AI client changed shows as changed by '<person> via <client>'; one the person changed, by them", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner", name: "Olive Owner" });
		const { accessToken } = await approveAiClient(
			install,
			owner.browser,
			{ workspaceId },
			{ client_name: "Writing assistant" },
		);
		const client = await connectMcp(install, accessToken);
		const { entry } = answerOf<{ entry: { id: string } }>(
			await client.callTool({ name: "entries_create", arguments: { siteId, postTypeId: pagesId, title: "Menu" } }),
		);
		await client.close();
		const { entry: own } = await owner.browser.api.entries.create({ siteId, postTypeId: pagesId, title: "Prices" });

		const { drafts } = await owner.browser.api.publishing.drafts({ siteId });
		const draftOf = (id: string) =>
			drafts.find((draft) => draft.item.kind === "entry" && "id" in draft.item && draft.item.id === id);
		expect(draftOf(entry.id)?.changedBy).toEqual({ id: owner.personId, name: "Olive Owner", via: "Writing assistant" });
		expect(draftOf(own.id)?.changedBy).toEqual({ id: owner.personId, name: "Olive Owner", via: null });
	});
});

describe("confirming", () => {
	async function newPage(title: string): Promise<string> {
		const admin = await install.superadmin();
		const { entry } = await admin.api.entries.create({ siteId, postTypeId: pagesId, title });
		return entry.id;
	}

	async function publishedAt(entryId: string): Promise<unknown> {
		const { entry } = await (await install.superadmin()).api.entries.get({ siteId, entryId });
		return (entry as { publishedAt?: unknown }).publishedAt ?? null;
	}

	test("in two calls: the first changes nothing and answers a preview and a confirmation id", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId, mayPublish: true });
		const client = await connectMcp(install, accessToken);
		const entryId = await newPage("Opening hours");

		const first = answerOf<{ confirmation: { id: string; expiresAt: string }; preview: { name: string } }>(
			await client.callTool({ name: "entries_publish", arguments: { siteId, entryId } }),
		);
		expect(first.preview).toMatchObject({ name: "Opening hours" });
		expect(await publishedAt(entryId)).toBeNull();

		const wrong = await client.callTool({
			name: "entries_publish",
			arguments: { siteId, entryId, confirmation: "nope" },
		});
		expect(refusalOf(wrong).code).toBe("CONFIRMATION_INVALID");
		answerOf(
			await client.callTool({
				name: "entries_publish",
				arguments: { siteId, entryId, confirmation: first.confirmation.id },
			}),
		);
		expect(await publishedAt(entryId)).not.toBeNull();
		await client.close();
	});

	test("a client that can ask its person a question asks, and goes ahead only once they agree", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId, mayPublish: true });
		const questions: string[] = [];
		const agreeing = await connectMcp(install, accessToken, {
			era: "modern",
			answer: (question) => {
				questions.push(question.message);
				return { confirm: true };
			},
		});
		const entryId = await newPage("Our story");

		const result = await agreeing.callTool({ name: "entries_publish", arguments: { siteId, entryId } });

		expect(result.isError).toBeFalsy();
		expect(questions).toHaveLength(1);
		expect(questions[0]).toContain("Our story");
		expect(await publishedAt(entryId)).not.toBeNull();
		await agreeing.close();

		const declining = await connectMcp(install, accessToken, { era: "modern", answer: () => null });
		const other = await newPage("Not yet");
		const declined = await declining.callTool({ name: "entries_publish", arguments: { siteId, entryId: other } });
		expect(answerOf(declined)).toEqual({ confirmed: false });
		expect(await publishedAt(other)).toBeNull();
		await declining.close();
	});
});

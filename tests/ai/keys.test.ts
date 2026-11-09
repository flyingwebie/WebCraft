// AI keys (ADR 0011, GLOSSARY.md › AI key): a Workspace's own key, set by its Owner or Staff, and
// shared Install keys the Superadmin adds and assigns to Workspaces, each with a monthly cap. The
// Workspace's own key wins. Keys are write-only: nobody reads one back, and a stored key is never
// sent anywhere but where it was saved for.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const OWN_KEY = "sk-ant-own-workspace-key-0123456789abcd";
const SHARED_KEY = "sk-or-shared-install-key-9876543210wxyz";

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
});

afterAll(async () => {
	await install.close();
});

async function workspaceWithOwner() {
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const owner = await install.createMember({ workspaceId, role: "owner" });
	return { workspaceId, siteId, owner: owner.browser };
}

async function auditEntries(action: string) {
	const { entries } = await admin.api.audit.list({ limit: 200 });
	return entries.filter((entry) => entry.action === action);
}

describe("a Workspace's own AI key", () => {
	test("an Owner sets it with a provider and a model; it shows only as set, with its last 4 characters", async () => {
		const { workspaceId, owner } = await workspaceWithOwner();
		expect((await owner.api.aiKeys.get({ workspaceId })).own).toBeNull();

		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "anthropic",
			model: "claude-haiku-5-5",
			endpoint: null,
			key: OWN_KEY,
		});

		const view = await owner.api.aiKeys.get({ workspaceId });
		expect(view.own).toMatchObject({
			provider: "anthropic",
			model: "claude-haiku-5-5",
			endpoint: null,
			key: { set: true, lastFour: "abcd" },
			monthlyCap: null,
			setBy: { name: expect.any(String) },
		});
		expect(view.inUse).toBe("own");
		expect(JSON.stringify(view)).not.toContain(OWN_KEY);
		const [entry] = await auditEntries("aiKey.set");
		expect(entry).toMatchObject({ workspaceId, details: { provider: "anthropic", model: "claude-haiku-5-5" } });
		expect(JSON.stringify(entry)).not.toContain(OWN_KEY);
		expect(await install.tablesHolding(OWN_KEY)).toEqual([]);
	});

	test("Staff set it too; Editors and Authors can't see or change it", async () => {
		const { workspaceId } = await workspaceWithOwner();
		const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
		await staff.api.aiKeys.setOwn({
			workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: OWN_KEY,
		});
		expect((await staff.api.aiKeys.get({ workspaceId })).own?.provider).toBe("openai");

		for (const role of ["editor", "author"] as const) {
			const member = (await install.createMember({ workspaceId, role })).browser;
			await expect(member.api.aiKeys.get({ workspaceId })).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				member.api.aiKeys.setOwn({
					workspaceId,
					provider: "openai",
					model: "gpt-5-mini",
					endpoint: null,
					key: OWN_KEY,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});

	test("a stored key is never sent somewhere new: changing the provider or endpoint needs the key again", async () => {
		const { workspaceId, owner } = await workspaceWithOwner();
		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "openaiCompatible",
			model: "llama-4-scout",
			endpoint: "https://llm.client.example/v1",
			key: OWN_KEY,
		});

		await expect(
			owner.api.aiKeys.setOwn({
				workspaceId,
				provider: "openaiCompatible",
				model: "llama-4-scout",
				endpoint: "https://collector.attacker.example/v1",
			}),
		).rejects.toMatchObject({ code: "AI_KEY_INVALID", data: { field: "key", reason: "needed" } });
		await expect(
			owner.api.aiKeys.setOwn({ workspaceId, provider: "openai", model: "gpt-5-mini", endpoint: null }),
		).rejects.toMatchObject({ code: "AI_KEY_INVALID", data: { field: "key", reason: "needed" } });

		// The model alone may change without it.
		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "openaiCompatible",
			model: "qwen-3-32b",
			endpoint: "https://llm.client.example/v1",
		});
		expect((await owner.api.aiKeys.get({ workspaceId })).own).toMatchObject({
			model: "qwen-3-32b",
			key: { set: true, lastFour: "abcd" },
		});
	});

	test("an OpenAI-compatible endpoint is an https address outside any private network", async () => {
		const { workspaceId, owner } = await workspaceWithOwner();
		const set = (endpoint: string | null) =>
			owner.api.aiKeys.setOwn({ workspaceId, provider: "openaiCompatible", model: "m", endpoint, key: OWN_KEY });
		for (const endpoint of [
			"http://llm.client.example/v1",
			"https://10.0.0.5/v1",
			"https://localhost:11434/v1",
			"https://user:pass@llm.client.example/v1",
		]) {
			await expect(set(endpoint)).rejects.toMatchObject({ code: "AI_KEY_INVALID", data: { field: "endpoint" } });
		}
		await expect(set(null)).rejects.toMatchObject({ code: "AI_KEY_INVALID", data: { field: "endpoint" } });
		await expect(
			owner.api.aiKeys.setOwn({
				workspaceId,
				provider: "openai",
				model: "gpt-5-mini",
				endpoint: "https://api.openai.example/v1",
				key: OWN_KEY,
			}),
		).rejects.toMatchObject({ code: "AI_KEY_INVALID", data: { field: "endpoint" } });
	});

	test("removing it forgets the key; an API token can never set or remove one", async () => {
		const { workspaceId, owner } = await workspaceWithOwner();
		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "google",
			model: "gemini-2.5-flash",
			endpoint: null,
			key: OWN_KEY,
		});
		const token = await createApiToken(owner, { workspaceId, name: "Script" });
		const script = tokenClient(install, token.secret);
		await expect(
			script.api.aiKeys.setOwn({ workspaceId, provider: "openai", model: "gpt-5-mini", endpoint: null, key: OWN_KEY }),
		).rejects.toMatchObject({ code: "SENSITIVE_ACTION_REFUSED" });
		await expect(script.api.aiKeys.removeOwn({ workspaceId })).rejects.toMatchObject({
			code: "SENSITIVE_ACTION_REFUSED",
		});

		await owner.api.aiKeys.removeOwn({ workspaceId });
		expect((await owner.api.aiKeys.get({ workspaceId })).own).toBeNull();
		expect(await auditEntries("aiKey.remove")).toContainEqual(expect.objectContaining({ workspaceId }));
	});
});

describe("shared Install keys", () => {
	test("the Superadmin adds one and assigns it to a Workspace with a required monthly cap", async () => {
		const { workspaceId, owner } = await workspaceWithOwner();
		const { key } = await admin.api.sharedAiKeys.add({
			name: "Agency OpenRouter",
			provider: "openrouter",
			model: "anthropic/claude-haiku-5-5",
			endpoint: null,
			key: SHARED_KEY,
		});
		expect(key).toMatchObject({ name: "Agency OpenRouter", key: { set: true, lastFour: "wxyz" } });

		await expect(admin.api.sharedAiKeys.assign({ workspaceId, keyId: key.id, monthlyCap: null })).rejects.toMatchObject(
			{ code: "AI_KEY_INVALID", data: { field: "monthlyCap" } },
		);
		await admin.api.sharedAiKeys.assign({ workspaceId, keyId: key.id, monthlyCap: 5 });

		const view = await owner.api.aiKeys.get({ workspaceId });
		expect(view.own).toBeNull();
		expect(view.shared).toEqual({
			name: "Agency OpenRouter",
			provider: "openrouter",
			model: "anthropic/claude-haiku-5-5",
			monthlyCap: 5,
		});
		expect(view.inUse).toBe("shared");
		expect(JSON.stringify(view)).not.toContain(SHARED_KEY);
		expect(JSON.stringify(view)).not.toContain("wxyz");

		const { keys } = await admin.api.sharedAiKeys.list();
		expect(keys.find((candidate) => candidate.id === key.id)?.workspaces).toContainEqual(
			expect.objectContaining({ id: workspaceId, monthlyCap: 5 }),
		);
		expect(await auditEntries("sharedAiKey.assign")).toContainEqual(
			expect.objectContaining({ workspaceId, details: expect.objectContaining({ keyId: key.id, monthlyCap: 5 }) }),
		);
	});

	test("only the Superadmin manages them; Staff and Owners don't", async () => {
		const { workspaceId, owner } = await workspaceWithOwner();
		const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
		for (const browser of [staff, owner]) {
			await expect(browser.api.sharedAiKeys.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				browser.api.sharedAiKeys.add({
					name: "Mine",
					provider: "openai",
					model: "gpt-5-mini",
					endpoint: null,
					key: SHARED_KEY,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});

	test("the Workspace's own key wins over the shared one, for Suggest alt text too", async () => {
		const { workspaceId, siteId, owner } = await workspaceWithOwner();
		const { key } = await admin.api.sharedAiKeys.add({
			name: "Agency key",
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: SHARED_KEY,
		});
		await admin.api.sharedAiKeys.assign({ workspaceId, keyId: key.id, monthlyCap: 10 });
		install.ai.answer("A loaf of bread.");
		const { media } = await owner.api.media.upload({
			siteId,
			file: upload(await photo({ width: 640, height: 480 }), "loaf.jpg"),
		});
		expect((await install.drainJobs()).failed).toEqual([]);

		await owner.api.media.suggestAltText({ siteId, mediaId: media.id });
		expect(install.ai.requests.at(-1)?.connection).toEqual({
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: SHARED_KEY,
			privateNetwork: false,
		});

		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "anthropic",
			model: "claude-haiku-5-5",
			endpoint: null,
			key: OWN_KEY,
		});
		await owner.api.media.suggestAltText({ siteId, mediaId: media.id });
		expect(install.ai.requests.at(-1)?.connection).toMatchObject({ provider: "anthropic", key: OWN_KEY });
		expect((await owner.api.aiKeys.get({ workspaceId })).inUse).toBe("own");
	});

	test("only a shared key may reach a self-hosted endpoint inside the network, once the Superadmin allows it", async () => {
		const add = (endpoint: string) =>
			admin.api.sharedAiKeys.add({
				name: "Office model",
				provider: "openaiCompatible",
				model: "llama",
				endpoint,
				key: SHARED_KEY,
				// A model on the agency's own server costs nothing per token.
				price: { input: 0, output: 0 },
			});
		await expect(add("http://10.1.2.3:11434/v1")).rejects.toMatchObject({
			code: "AI_KEY_INVALID",
			data: { field: "endpoint" },
		});
		await admin.api.sharedAiKeys.setPrivateEndpoints({ on: true });
		const { key } = await add("http://10.1.2.3:11434/v1");
		expect(key.endpoint).toBe("http://10.1.2.3:11434/v1");
		expect((await admin.api.sharedAiKeys.list()).privateEndpoints).toBe(true);
		await admin.api.sharedAiKeys.setPrivateEndpoints({ on: false });
	});
});

describe("testing a key", () => {
	test("Test makes one small call with the key and records when it went through", async () => {
		const { workspaceId, owner } = await workspaceWithOwner();
		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: OWN_KEY,
		});
		install.ai.translateWith((text) => `[fr] ${text}`);

		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: true, problem: null });
		const request = install.ai.requests.at(-1);
		expect(request).toMatchObject({ purpose: "test", connection: { key: OWN_KEY } });
		expect((await owner.api.aiKeys.get({ workspaceId })).own?.testedAt).toEqual(install.clock.now());

		install.ai.fail("refused");
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "refused" });
	});
});

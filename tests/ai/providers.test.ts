// AI providers are called directly (ADR 0011), each in its own API, through the guarded fetcher:
// what WebCraft sends OpenAI, Anthropic, Google, OpenRouter and an OpenAI-compatible endpoint, how it
// reads their answers, and that a key never leaves for anywhere but its provider, nor reaches a log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { RecordedRequest } from "../harness/fake-http.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const KEY = "sk-provider-test-key-0123456789abcdef";
/** A public address the providers' hosts resolve to in these tests. */
const PUBLIC_ADDRESS = "151.101.1.1";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ aiProviders: "http" });
	for (const host of [
		"api.openai.com",
		"api.anthropic.com",
		"generativelanguage.googleapis.com",
		"openrouter.ai",
		"llm.client.example",
	]) {
		install.dns.answer(host, [PUBLIC_ADDRESS]);
	}
});

afterAll(async () => {
	await install.close();
});

async function ownerWithKey(input: { provider: string; model: string; endpoint?: string | null }) {
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId)).id;
	const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	await owner.api.aiKeys.setOwn({
		workspaceId,
		provider: input.provider as "openai",
		model: input.model,
		endpoint: input.endpoint ?? null,
		key: KEY,
	});
	return { workspaceId, siteId, owner };
}

function lastRequestTo(host: string): RecordedRequest {
	const request = install.http.requests.filter((candidate) => new URL(candidate.url).hostname === host).at(-1);
	if (!request) throw new Error(`Nothing was sent to ${host}.`);
	return request;
}

/** The texts a translation call sent, as the user message holds them. */
function sentTexts(content: string): string[] {
	return JSON.parse(content) as string[];
}

function expectKeyNowhereElse(request: RecordedRequest, header: string) {
	expect(request.headers.get(header)).toContain(KEY);
	expect(request.url).not.toContain(KEY);
	expect(request.body).not.toContain(KEY);
	expect(JSON.stringify(install.logs)).not.toContain(KEY);
}

describe("each provider's own API", () => {
	test("OpenAI: chat completions, the key as a bearer token, usage read back", async () => {
		const { workspaceId, owner } = await ownerWithKey({ provider: "openai", model: "gpt-5-mini" });
		install.http.respond("POST", "https://api.openai.com/v1/chat/completions", (request) => {
			const body = JSON.parse(request.body);
			const texts = sentTexts(body.messages[1].content[0].text);
			return {
				body: JSON.stringify({
					choices: [{ message: { content: JSON.stringify(texts.map((text) => `Bonjour (${text})`)) } }],
					usage: { prompt_tokens: 42, completion_tokens: 7 },
				}),
			};
		});

		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: true, problem: null });
		const request = lastRequestTo("api.openai.com");
		expectKeyNowhereElse(request, "authorization");
		expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		const body = JSON.parse(request.body);
		expect(body.model).toBe("gpt-5-mini");
		expect(body.messages[0]).toMatchObject({ role: "system" });
		expect(sentTexts(body.messages[1].content[0].text)).toEqual(["Hello"]);
		expect(request.address).toBe(PUBLIC_ADDRESS);
	});

	test("Anthropic: the Messages API with x-api-key and its version, text blocks read back", async () => {
		const { workspaceId, owner } = await ownerWithKey({ provider: "anthropic", model: "claude-haiku-5-5" });
		install.http.respond("POST", "https://api.anthropic.com/v1/messages", {
			body: JSON.stringify({
				content: [{ type: "text", text: '["Bonjour"]' }],
				stop_reason: "end_turn",
				usage: { input_tokens: 30, output_tokens: 5 },
			}),
		});

		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: true, problem: null });
		const request = lastRequestTo("api.anthropic.com");
		expectKeyNowhereElse(request, "x-api-key");
		expect(request.headers.get("anthropic-version")).toBe("2026-10-21");
		const body = JSON.parse(request.body);
		expect(body).toMatchObject({ model: "claude-haiku-5-5", messages: [{ role: "user" }] });
		expect(body.temperature).toBeUndefined();
		expect(typeof body.system).toBe("string");
	});

	test("Anthropic: a declined request is refused, a cut-off answer is no answer", async () => {
		const { workspaceId, owner } = await ownerWithKey({ provider: "anthropic", model: "claude-opus-5-5" });
		install.http.respond("POST", "https://api.anthropic.com/v1/messages", {
			body: JSON.stringify({ content: [], stop_reason: "refusal", usage: { input_tokens: 30, output_tokens: 0 } }),
		});
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "refused" });
		// Models that take them ask for the provider's own fallback when a request is declined.
		const body = JSON.parse(lastRequestTo("api.anthropic.com").body);
		expect(body.fallbacks).toBe("default");

		install.http.respond("POST", "https://api.anthropic.com/v1/messages", {
			body: JSON.stringify({ content: [{ type: "text", text: '["Bon' }], stop_reason: "max_tokens" }),
		});
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "answer" });
	});

	test("Google: generateContent with the key in a header, never in the address", async () => {
		const { workspaceId, owner } = await ownerWithKey({ provider: "google", model: "gemini-2.5-flash" });
		install.http.respond(
			"POST",
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
			{
				body: JSON.stringify({
					candidates: [{ content: { parts: [{ text: '["Bonjour"]' }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4 },
				}),
			},
		);

		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: true, problem: null });
		expectKeyNowhereElse(lastRequestTo("generativelanguage.googleapis.com"), "x-goog-api-key");
	});

	test("OpenRouter and an OpenAI-compatible endpoint speak OpenAI's chat API at their own address", async () => {
		const answer = {
			body: JSON.stringify({ choices: [{ message: { content: '["Bonjour"]' } }], usage: {} }),
		};
		install.http.respond("POST", "https://openrouter.ai/api/v1/chat/completions", answer);
		install.http.respond("POST", "https://llm.client.example/v1/chat/completions", answer);

		const router = await ownerWithKey({ provider: "openrouter", model: "anthropic/claude-haiku-5-5" });
		expect(await router.owner.api.aiKeys.testOwn({ workspaceId: router.workspaceId })).toMatchObject({ ok: true });
		expectKeyNowhereElse(lastRequestTo("openrouter.ai"), "authorization");

		const compatible = await ownerWithKey({
			provider: "openaiCompatible",
			model: "llama-4-scout",
			endpoint: "https://llm.client.example/v1",
		});
		expect(await compatible.owner.api.aiKeys.testOwn({ workspaceId: compatible.workspaceId })).toMatchObject({
			ok: true,
		});
		expect(JSON.parse(lastRequestTo("llm.client.example").body).model).toBe("llama-4-scout");
	});

	test("an image is sent as the provider reads one, for Suggest alt text", async () => {
		const { siteId, owner } = await ownerWithKey({ provider: "anthropic", model: "claude-haiku-5-5" });
		install.http.respond("POST", "https://api.anthropic.com/v1/messages", {
			body: JSON.stringify({ content: [{ type: "text", text: "A round loaf on a board." }], stop_reason: "end_turn" }),
		});
		const { media } = await owner.api.media.upload({
			siteId,
			file: upload(await photo({ width: 640, height: 480 }), "loaf.jpg"),
		});
		expect((await install.drainJobs()).failed).toEqual([]);

		expect(await owner.api.media.suggestAltText({ siteId, mediaId: media.id })).toEqual({
			alt: "A round loaf on a board.",
		});
		const content = JSON.parse(lastRequestTo("api.anthropic.com").body).messages[0].content;
		expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/webp" } });
		expect(content[1].text).toContain("loaf.jpg");
	});
});

describe("answers that can't be used", () => {
	let workspaceId: string;
	let owner: TestBrowser;

	beforeAll(async () => {
		({ workspaceId, owner } = await ownerWithKey({ provider: "openai", model: "gpt-5-mini" }));
	});

	test("a refused key, a provider that is down, and an answer with the wrong number of texts", async () => {
		install.http.respond("POST", "https://api.openai.com/v1/chat/completions", { status: 401, body: "{}" });
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "refused" });

		install.http.respond("POST", "https://api.openai.com/v1/chat/completions", { status: 503, body: "busy" });
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "unavailable" });

		install.http.respond("POST", "https://api.openai.com/v1/chat/completions", {
			body: JSON.stringify({ choices: [{ message: { content: '["Bonjour", "Salut"]' } }] }),
		});
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "answer" });
	});

	test("a redirect isn't followed: the call carries the key", async () => {
		install.http.respond("POST", "https://api.openai.com/v1/chat/completions", {
			status: 307,
			headers: { location: "https://collector.attacker.example/steal" },
		});
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "unavailable" });
		expect(install.http.requests.some((request) => request.url.includes("attacker"))).toBe(false);
	});
});

describe("where a key may go", () => {
	test("a Workspace's endpoint that resolves inside the network is never called", async () => {
		install.dns.answer("sneaky.client.example", ["10.0.0.8"]);
		const { workspaceId, owner } = await ownerWithKey({
			provider: "openaiCompatible",
			model: "m",
			endpoint: "https://sneaky.client.example/v1",
		});
		expect(await owner.api.aiKeys.testOwn({ workspaceId })).toEqual({ ok: false, problem: "unavailable" });
		expect(install.http.requests.some((request) => request.url.includes("sneaky"))).toBe(false);
	});

	test("a shared key reaches a self-hosted model inside the network while the Superadmin allows it", async () => {
		const admin = await install.superadmin();
		await admin.api.sharedAiKeys.setPrivateEndpoints({ on: true });
		install.http.respond("POST", "http://10.1.2.3:11434/v1/chat/completions", {
			body: JSON.stringify({ choices: [{ message: { content: '["Bonjour"]' } }] }),
		});
		const { key } = await admin.api.sharedAiKeys.add({
			name: "Office model",
			provider: "openaiCompatible",
			model: "llama",
			endpoint: "http://10.1.2.3:11434/v1",
			key: KEY,
			price: { input: 0, output: 0 },
		});
		expect(await admin.api.sharedAiKeys.test({ keyId: key.id })).toEqual({ ok: true, problem: null });
		expect(install.http.requests.at(-1)?.address).toBe("10.1.2.3");

		await admin.api.sharedAiKeys.setPrivateEndpoints({ on: false });
		expect(await admin.api.sharedAiKeys.test({ keyId: key.id })).toEqual({ ok: false, problem: "unavailable" });
	});
});

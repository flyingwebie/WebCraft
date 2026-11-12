import { type GuardedFetch, GuardedFetchError } from "../guarded-fetch.ts";
import { AI_PROVIDER_ENDPOINTS } from "./models.ts";
import {
	type AiAnswer,
	type AiConnection,
	AiProviderError,
	type AiProviders,
	type AiUsage,
	type ImageDescriptionRequest,
	type ReportTextRequest,
	type TranslationAnswer,
	type TranslationRequest,
} from "./providers.ts";

/**
 * The AI providers WebCraft calls directly (ADR 0011), each in its own API: OpenAI's chat completions
 * (OpenAI, OpenRouter and any OpenAI-compatible endpoint), Anthropic's Messages API and Google's
 * Gemini API. Every call goes through the guarded fetcher: only to the provider's host (or the key's
 * endpoint), checked and pinned, no redirect followed (the call carries the key). Nothing here logs:
 * neither the key nor what was sent or answered ever reaches a log line or an error message.
 */

/** How long a call may take: translations of long text take a while. */
const TIMEOUT_MS = 120_000;

/** The Messages API version Anthropic's calls use. */
const ANTHROPIC_VERSION = "2026-10-21";

/** Anthropic models that take server-side fallbacks when a request is declined. */
const ANTHROPIC_FALLBACK_MODELS = new Set([
	"claude-fable-5-1",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
]);

/** The most output a call may write: generous, so long text is never cut off. */
const MAX_OUTPUT_TOKENS = 16_000;

export function createHttpAiProviders({ fetch }: { fetch: GuardedFetch }): AiProviders {
	return {
		async translate(request) {
			const answer = await complete(fetch, request.connection, {
				system: translationInstructions(request),
				user: [{ kind: "text", text: JSON.stringify(request.texts) }],
			});
			return { texts: parseTexts(answer.text, request.texts.length), usage: answer.usage } satisfies TranslationAnswer;
		},
		async writeReport(request) {
			return complete(fetch, request.connection, {
				system: reportInstructions(request),
				user: [{ kind: "text", text: request.facts }],
			});
		},
		async describeImage(request) {
			return complete(fetch, request.connection, {
				system: altTextInstructions(request),
				user: [
					{ kind: "image", data: request.image.data, contentType: request.image.contentType },
					{ kind: "text", text: altTextHints(request) },
				],
			});
		},
	};
}

/** What WebCraft asks of a translation: the texts as a JSON list, answered as one. */
function translationInstructions(request: TranslationRequest): string {
	const { from, to } = request;
	return [
		`You translate text for a website from ${from.name} (${from.code}) into ${to.name} (${to.code}).`,
		"You get a JSON array of strings. Answer with only a JSON array of the same number of strings: each string's translation, in the same order.",
		"Keep every marker such as ⟦1⟧, ⟦/1⟧, ⟦B1⟧ or ⟦T1⟧ exactly as written, around the words it belongs with; never translate, drop, add or change one.",
		"Keep line breaks. Leave text that needs no translation, such as numbers or names, as it is.",
	].join("\n");
}

/** What WebCraft asks of a Report's text: a JSON object, from the totals given and nothing else. */
function reportInstructions(request: ReportTextRequest): string {
	const services =
		request.services.length > 0
			? `The agency offers these services (id, name, description): ${JSON.stringify(request.services.map((service) => [service.id, service.name, service.description]))}. A suggestion may name the one service it relates to by its id.`
			: "The agency has listed no services: give no service ids.";
	return [
		`You explain a website's analytics report to its owner, in the language with the BCP 47 tag ${request.language.code} (${request.language.name}), in plain words without jargon.`,
		"You get the report's totals as JSON: each Widget's id, title and counts for the period, and for the period before when known. Use only these numbers; never invent figures, causes you can't see, or details about any visitor.",
		services,
		'Answer with only a JSON object: {"widgets": {"<widget id>": "1 to 3 sentences about that Widget"}, "whatHappened": "2 to 4 sentences about the period as a whole", "suggestions": [{"text": "one practical suggestion in 1 or 2 sentences", "service": "<service id or null>"}]}. Give at most 3 suggestions. Write plain text: no Markdown, no HTML, no links.',
	].join("\n");
}

function altTextInstructions(request: ImageDescriptionRequest): string {
	return [
		`Write alt text for the image in the language with the BCP 47 tag ${request.language}: one short sentence a screen reader reads in the image's place.`,
		"Describe what the image shows; don't start with words like 'Image of'. Answer with the alt text only.",
	].join("\n");
}

function altTextHints(request: ImageDescriptionRequest): string {
	const hints = [`File name: ${request.hints.fileName}`];
	if (request.hints.title) hints.push(`Title: ${request.hints.title}`);
	if (request.hints.caption) hints.push(`Caption: ${request.hints.caption}`);
	return hints.join("\n");
}

type Part = { kind: "text"; text: string } | { kind: "image"; data: Uint8Array; contentType: string };

type Prompt = { system: string; user: Part[] };

/** One call to the connection's provider; answers its text and usage. */
async function complete(fetch: GuardedFetch, connection: AiConnection, prompt: Prompt): Promise<AiAnswer> {
	switch (connection.provider) {
		case "anthropic":
			return anthropic(fetch, connection, prompt);
		case "google":
			return google(fetch, connection, prompt);
		default:
			return chatCompletions(fetch, connection, prompt);
	}
}

/** The base address calls go to: the provider's own, or the key's endpoint for an OpenAI-compatible one. */
function baseOf(connection: AiConnection): string {
	if (connection.provider === "openaiCompatible") {
		if (!connection.endpoint) throw new AiProviderError("refused", "This key has no endpoint.");
		return connection.endpoint.replace(/\/+$/, "");
	}
	return AI_PROVIDER_ENDPOINTS[connection.provider];
}

async function call(
	fetch: GuardedFetch,
	connection: AiConnection,
	url: string,
	headers: Record<string, string>,
	body: unknown,
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(
			new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify(body),
			}),
			{
				allowedHosts: [new URL(url).hostname],
				maxRedirects: 0,
				timeoutMs: TIMEOUT_MS,
				privateNetwork: connection.privateNetwork,
			},
		);
	} catch (error) {
		// The guarded fetcher's messages name the host, never the key or the body.
		const reason = error instanceof GuardedFetchError ? error.problem : "unreachable";
		throw new AiProviderError("unavailable", `The AI provider couldn't be reached (${reason}).`, { cause: error });
	}
	if (response.status === 401 || response.status === 403) {
		throw new AiProviderError("refused", `The AI provider refused the key (${response.status}).`);
	}
	if (response.status === 400 || response.status === 404 || response.status === 422) {
		throw new AiProviderError("refused", `The AI provider refused the request (${response.status}).`);
	}
	if (!response.ok) throw new AiProviderError("unavailable", `The AI provider answered ${response.status}.`);
	try {
		return await response.json();
	} catch {
		throw new AiProviderError("answer", "The AI provider's answer isn't JSON.");
	}
}

function base64(data: Uint8Array): string {
	return Buffer.from(data).toString("base64");
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

/**
 * What a call used, as the provider reported it: its tokens in and out. Undefined when it reported
 * neither (some compatible endpoints leave usage out), which is not the same as none used: the call
 * is then counted by its estimate (`AiKeys.call`).
 */
function usageOf(inputTokens: unknown, outputTokens: unknown): AiUsage | undefined {
	if (typeof inputTokens !== "number" && typeof outputTokens !== "number") return undefined;
	return { inputTokens: count(inputTokens), outputTokens: count(outputTokens) };
}

/** OpenAI's chat completions: OpenAI, OpenRouter and OpenAI-compatible endpoints. */
async function chatCompletions(fetch: GuardedFetch, connection: AiConnection, prompt: Prompt): Promise<AiAnswer> {
	const content = prompt.user.map((part) =>
		part.kind === "text"
			? { type: "text", text: part.text }
			: { type: "image_url", image_url: { url: `data:${part.contentType};base64,${base64(part.data)}` } },
	);
	const answer = record(
		await call(
			fetch,
			connection,
			`${baseOf(connection)}/chat/completions`,
			{ authorization: `Bearer ${connection.key}` },
			{
				model: connection.model,
				messages: [
					{ role: "system", content: prompt.system },
					{ role: "user", content },
				],
			},
		),
	);
	const choice = record(Array.isArray(answer.choices) ? answer.choices[0] : undefined);
	const message = record(choice.message);
	if (typeof message.refusal === "string" && message.refusal) {
		throw new AiProviderError("refused", "The AI provider declined the request.");
	}
	if (choice.finish_reason === "length") throw new AiProviderError("answer", "The AI provider's answer was cut off.");
	if (typeof message.content !== "string") throw new AiProviderError("answer", "The AI provider answered no text.");
	const usage = record(answer.usage);
	return { text: message.content, usage: usageOf(usage.prompt_tokens, usage.completion_tokens) };
}

/** Anthropic's Messages API. */
async function anthropic(fetch: GuardedFetch, connection: AiConnection, prompt: Prompt): Promise<AiAnswer> {
	const content = prompt.user.map((part) =>
		part.kind === "text"
			? { type: "text", text: part.text }
			: { type: "image", source: { type: "base64", media_type: part.contentType, data: base64(part.data) } },
	);
	const fallbacks = ANTHROPIC_FALLBACK_MODELS.has(connection.model);
	const answer = record(
		await call(
			fetch,
			connection,
			`${baseOf(connection)}/messages`,
			{
				"x-api-key": connection.key,
				"anthropic-version": ANTHROPIC_VERSION,
				...(fallbacks ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
			},
			{
				model: connection.model,
				max_tokens: MAX_OUTPUT_TOKENS,
				system: prompt.system,
				messages: [{ role: "user", content }],
				...(fallbacks ? { fallbacks: "default" } : {}),
			},
		),
	);
	if (answer.stop_reason === "refusal") throw new AiProviderError("refused", "The AI provider declined the request.");
	if (answer.stop_reason === "max_tokens") throw new AiProviderError("answer", "The AI provider's answer was cut off.");
	const blocks = Array.isArray(answer.content) ? answer.content.map(record) : [];
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
	if (text === "") throw new AiProviderError("answer", "The AI provider answered no text.");
	const usage = record(answer.usage);
	return { text, usage: usageOf(usage.input_tokens, usage.output_tokens) };
}

/** Google's Gemini API. The key goes in a header, never in the address. */
async function google(fetch: GuardedFetch, connection: AiConnection, prompt: Prompt): Promise<AiAnswer> {
	const parts = prompt.user.map((part) =>
		part.kind === "text"
			? { text: part.text }
			: { inlineData: { mimeType: part.contentType, data: base64(part.data) } },
	);
	const answer = record(
		await call(
			fetch,
			connection,
			`${baseOf(connection)}/models/${encodeURIComponent(connection.model)}:generateContent`,
			{ "x-goog-api-key": connection.key },
			{
				systemInstruction: { parts: [{ text: prompt.system }] },
				contents: [{ role: "user", parts }],
			},
		),
	);
	const candidate = record(Array.isArray(answer.candidates) ? answer.candidates[0] : undefined);
	if (candidate.finishReason === "SAFETY" || record(answer.promptFeedback).blockReason) {
		throw new AiProviderError("refused", "The AI provider declined the request.");
	}
	if (candidate.finishReason === "MAX_TOKENS")
		throw new AiProviderError("answer", "The AI provider's answer was cut off.");
	const content = record(candidate.content);
	const text = (Array.isArray(content.parts) ? content.parts.map(record) : [])
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
	if (text === "") throw new AiProviderError("answer", "The AI provider answered no text.");
	const usage = record(answer.usageMetadata);
	return { text, usage: usageOf(usage.promptTokenCount, usage.candidatesTokenCount) };
}

/** The list of translations in a provider's answer: a JSON array of strings, as many as were sent. */
function parseTexts(text: string, expected: number): string[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	let parsed: unknown;
	try {
		parsed = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : undefined;
	} catch {
		parsed = undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== expected || parsed.some((item) => typeof item !== "string")) {
		throw new AiProviderError("answer", `The AI provider didn't answer ${expected} translations.`);
	}
	return parsed as string[];
}

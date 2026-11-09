/**
 * AI providers and the models WebCraft suggests for each, with estimated prices (ADR 0011). This file
 * imports nothing, so the admin's browser code reads the same list (`@webcraft/core/ai-models`).
 *
 * Prices are estimates in US dollars per million tokens, as providers listed them when this table was
 * written; providers change them, and a key can give its own (`price` on a key), which then wins. A
 * model missing here has no estimate until its key gives one: its calls are recorded with their tokens
 * and no cost, so a cap needs a price. Costs are kept in micro-dollars (millionths of a dollar).
 */

/** The providers WebCraft calls directly. `openaiCompatible` is any endpoint speaking OpenAI's chat API (self-hosted models too). */
export const AI_PROVIDERS = ["openai", "anthropic", "google", "openrouter", "openaiCompatible"] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

/** A model's estimated price, in dollars per million input and output tokens. */
export type AiPrice = { input: number; output: number };

export type AiModel = { id: string; price: AiPrice };

/** The models offered for each provider, the default first. Any other model id may be typed in. */
export const AI_MODELS: Readonly<Record<AiProvider, readonly AiModel[]>> = {
	openai: [
		{ id: "gpt-5-mini", price: { input: 0.25, output: 2 } },
		{ id: "gpt-5-nano", price: { input: 0.05, output: 0.4 } },
		{ id: "gpt-5", price: { input: 1.25, output: 10 } },
	],
	anthropic: [
		{ id: "claude-opus-5-5", price: { input: 4, output: 20 } },
		{ id: "claude-sonnet-5-5", price: { input: 2, output: 10 } },
		{ id: "claude-haiku-5-5", price: { input: 0.1, output: 0.5 } },
	],
	google: [
		{ id: "gemini-2.5-flash", price: { input: 0.3, output: 2.5 } },
		{ id: "gemini-2.5-flash-lite", price: { input: 0.1, output: 0.4 } },
		{ id: "gemini-2.5-pro", price: { input: 1.25, output: 10 } },
	],
	openrouter: [
		{ id: "anthropic/claude-opus-5-5", price: { input: 4, output: 20 } },
		{ id: "anthropic/claude-haiku-5-5", price: { input: 0.1, output: 0.5 } },
		{ id: "openai/gpt-5-mini", price: { input: 0.25, output: 2 } },
		{ id: "google/gemini-2.5-flash", price: { input: 0.3, output: 2.5 } },
	],
	openaiCompatible: [],
};

/** Where each provider answers. An OpenAI-compatible provider answers at the endpoint its key gives. */
export const AI_PROVIDER_ENDPOINTS: Readonly<Record<Exclude<AiProvider, "openaiCompatible">, string>> = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
	google: "https://generativelanguage.googleapis.com/v1beta",
	openrouter: "https://openrouter.ai/api/v1",
};

/** The longest model id, endpoint and key. */
export const AI_KEY_LIMITS = { model: 200, endpoint: 2000, key: 1000, name: 100 } as const;

/** The most a monthly cap may be, in dollars. */
export const AI_CAP_MAX = 1_000_000;

/** At these shares of a cap (per cent) people are told: a notice and an email at 80, a stop at 100. */
export const AI_CAP_NOTICES = [80, 100] as const;

export function isAiProvider(value: unknown): value is AiProvider {
	return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

/** A provider's default model, or null when it has none to offer (an OpenAI-compatible endpoint). */
export function defaultAiModel(provider: AiProvider): string | null {
	return AI_MODELS[provider][0]?.id ?? null;
}

/** The estimated price WebCraft knows for a model of a provider, or null. */
export function knownAiPrice(provider: AiProvider, model: string): AiPrice | null {
	return AI_MODELS[provider].find((candidate) => candidate.id === model)?.price ?? null;
}

/** Dollars to micro-dollars, the unit costs and caps are kept in. */
export function toMicros(dollars: number): number {
	return Math.round(dollars * 1_000_000);
}

/** Micro-dollars to dollars. */
export function fromMicros(micros: number): number {
	return micros / 1_000_000;
}

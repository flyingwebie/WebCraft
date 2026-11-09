/**
 * What can be wrong with an AI key's settings, by field: `key` (missing where it is needed, or not a
 * key), `endpoint` (an OpenAI-compatible provider's address: missing, not https, inside a private
 * network, or given to a provider that has none), `model`, `price`, `monthlyCap` and `name`.
 */
export type AiKeyField = "key" | "endpoint" | "model" | "price" | "monthlyCap" | "name" | "provider";

/**
 * Why: `needed` (it must be given: a new key, a key moved to another provider or endpoint, a shared
 * key's cap), `format`, `scheme` (an endpoint not on https), `host` (an endpoint inside a private
 * network, or a provider that takes none) or `range` (a number out of range).
 */
export type AiKeyInvalidReason = "needed" | "format" | "scheme" | "host" | "range";

const WORDS: Record<AiKeyField, string> = {
	key: "Give the AI key: a new key, and a key moved to another provider or endpoint, must be typed again.",
	endpoint:
		"An OpenAI-compatible provider needs an https address on the internet, such as https://llm.example.com/v1; other providers take none.",
	model: "Give the model, such as gpt-5-mini.",
	price: "Give the model's price per million tokens: WebCraft has no estimate for it.",
	monthlyCap: "Give a monthly cap of at least $0.01.",
	name: "Give the key a name of at most 100 characters.",
	provider: "Choose one of the providers WebCraft calls.",
};

export class AiKeyInvalidError extends Error {
	override name = "AiKeyInvalidError";
	readonly field: AiKeyField;
	readonly reason: AiKeyInvalidReason;
	constructor(field: AiKeyField, reason: AiKeyInvalidReason) {
		super(WORDS[field]);
		this.field = field;
		this.reason = reason;
	}
}

/** No shared Install key with this id. */
export class SharedAiKeyNotFoundError extends Error {
	override name = "SharedAiKeyNotFoundError";
	constructor() {
		super("There is no shared AI key with this id.");
	}
}

/**
 * The key's monthly cap is reached: nothing more is asked of the provider until the cap is raised or
 * the month ends (`key` says which of the Workspace's keys, `resumesAt` when the month ends).
 */
export class AiCapReachedError extends Error {
	override name = "AiCapReachedError";
	readonly key: "own" | "shared";
	readonly resumesAt: Date;
	constructor(key: "own" | "shared", resumesAt: Date) {
		super("This month's AI cap is reached: AI calls wait until the cap is raised or the month ends.");
		this.key = key;
		this.resumesAt = resumesAt;
	}
}

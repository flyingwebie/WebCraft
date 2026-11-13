import type { AiProvider } from "./models.ts";

/**
 * AI providers (ADR 0011): WebCraft calls them directly, with the AI key a Workspace uses (its own,
 * else the shared Install key assigned to it). A port, so tests answer with a fake; the processes use
 * `createHttpAiProviders`, which speaks each provider's own API through the guarded fetcher.
 */

/** The name of a Workspace's own AI key among its secrets. */
export const WORKSPACE_AI_KEY = "ai.key";

/** The name of a shared Install key among the Install's secrets. */
export function sharedAiKeySecret(keyId: string): string {
	return `ai.shared:${keyId}`;
}

/**
 * Where and how a call goes: the provider, the model, the endpoint of an OpenAI-compatible provider,
 * the key (filled in from its secret for this call only, never kept or logged), and whether the
 * endpoint may be inside the Install's own network (a shared key, while the Superadmin allows it).
 */
export type AiConnection = {
	provider: AiProvider;
	model: string;
	endpoint: string | null;
	key: string;
	privateNetwork: boolean;
};

/** A language as a prompt names it: its BCP 47 tag and its name. */
export type AiLanguage = { code: string; name: string };

/** What WebCraft asks a provider to write about an image. */
export type ImageDescriptionRequest = {
	connection: AiConnection;
	/** What the text is for: `altText`, text a screen reader reads in the image's place. */
	purpose: "altText";
	/** The image, in a format providers read (JPEG, PNG, WebP or GIF). */
	image: { data: Uint8Array; contentType: string };
	/** The language to write in, a BCP 47 tag such as `it`. */
	language: string;
	/** What people already wrote about the file, to help (never personal data). */
	hints: { fileName: string; title: string | null; caption: string | null };
};

/**
 * Pieces of text to translate, in order. Only text is sent, never markup, addresses, ids or Media:
 * formatted text keeps where its formatting goes as markers (`⟦1⟧bold⟦/1⟧`), and Protected terms are
 * markers too (`⟦T1⟧`). The answer must hold every marker exactly as sent, or it is refused.
 * `purpose: "test"` is a key's Test: one short text.
 */
export type TranslationRequest = {
	connection: AiConnection;
	purpose: "translation" | "test";
	from: AiLanguage;
	to: AiLanguage;
	texts: string[];
};

/**
 * What WebCraft asks a provider to write for a Report (#104): short explanations of each Widget, what
 * happened, and suggestions that may point to the agency's services. Only totals are sent (`facts`:
 * the Report's Widgets' counts for its period and the one before, as JSON), never anything about a
 * visitor; the answer is a JSON object, checked by WebCraft and shown as plain text.
 */
export type ReportTextRequest = {
	connection: AiConnection;
	purpose: "report";
	/** The language to write in. */
	language: AiLanguage;
	/** The Report's totals, as JSON. */
	facts: string;
	/** The agency's Services list: what suggestions may point to, by id. */
	services: { id: string; name: string; description: string }[];
};

/** What a call used, as the provider reports it. */
export type AiUsage = { inputTokens: number; outputTokens: number };

/** A provider's answer to an image description, and what the call used. */
export type AiAnswer = { text: string; usage?: AiUsage };

/** A provider's translations, one per text and in the same order, and what the call used. */
export type TranslationAnswer = { texts: string[]; usage?: AiUsage };

export type AiProviders = {
	describeImage(request: ImageDescriptionRequest): Promise<AiAnswer>;
	translate(request: TranslationRequest): Promise<TranslationAnswer>;
	/** A Report's text, as the provider answered it (a JSON object, read by WebCraft). */
	writeReport(request: ReportTextRequest): Promise<AiAnswer>;
};

/**
 * Why a provider gave no usable answer: `unavailable` (it couldn't be reached or failed), `refused`
 * (it refused the request, or the key), or `answer` (it answered something that isn't what was
 * asked: the wrong number of texts, or markers dropped or changed).
 */
export type AiProviderProblem = "unavailable" | "refused" | "answer";

export class AiProviderError extends Error {
	override name = "AiProviderError";
	readonly problem: AiProviderProblem;
	constructor(problem: AiProviderProblem, message: string, options?: ErrorOptions) {
		super(message, options);
		this.problem = problem;
	}
}

/** The Workspace has no AI key (neither its own nor a shared one), so nothing can be asked of an AI provider. */
export class AiKeyMissingError extends Error {
	override name = "AiKeyMissingError";
	constructor() {
		super("This Workspace has no AI key.");
	}
}

/** What every process had before AI providers were connected; kept for server commands, which never call one. */
export const aiProvidersToCome: AiProviders = {
	describeImage: () =>
		Promise.reject(new AiProviderError("unavailable", "AI providers aren't connected in this process.")),
	translate: () => Promise.reject(new AiProviderError("unavailable", "AI providers aren't connected in this process.")),
	writeReport: () =>
		Promise.reject(new AiProviderError("unavailable", "AI providers aren't connected in this process.")),
};

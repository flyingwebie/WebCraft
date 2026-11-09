/**
 * AI providers (ADR 0011): WebCraft calls them directly, with a Workspace's own AI key. A port, so
 * tests answer with a fake. The real providers (OpenAI, Anthropic, Google, OpenRouter and any
 * OpenAI-compatible endpoint), shared AI keys, recorded costs and monthly caps come with AI keys and
 * translation; until then every process gets `aiProvidersToCome`, which no feature reaches while no
 * Workspace can hold an AI key.
 */

/** The name of a Workspace's AI key among its secrets. */
export const WORKSPACE_AI_KEY = "ai.key";

/** What WebCraft asks a provider to write about an image. */
export type ImageDescriptionRequest = {
	/** The AI key to call with, filled in from the Workspace's secret for this call only. */
	key: string;
	/** What the text is for: `altText`, text a screen reader reads in the image's place. */
	purpose: "altText";
	/** The image, in a format providers read (JPEG, PNG, WebP or GIF). */
	image: { data: Uint8Array; contentType: string };
	/** The language to write in, a BCP 47 tag such as `it`. */
	language: string;
	/** What people already wrote about the file, to help (never personal data). */
	hints: { fileName: string; title: string | null; caption: string | null };
};

/** A provider's answer, and what the call used (recorded per Workspace and Site once caps exist). */
export type AiAnswer = { text: string; usage?: { inputTokens: number; outputTokens: number } };

export type AiProviders = {
	describeImage(request: ImageDescriptionRequest): Promise<AiAnswer>;
};

/** Why a provider gave no answer: `unavailable` (it couldn't be reached or failed), `refused` (it refused the request). */
export class AiProviderError extends Error {
	override name = "AiProviderError";
	readonly problem: "unavailable" | "refused";
	constructor(problem: "unavailable" | "refused", message: string, options?: ErrorOptions) {
		super(message, options);
		this.problem = problem;
	}
}

/** The Workspace has no AI key, so nothing can be asked of an AI provider. */
export class AiKeyMissingError extends Error {
	override name = "AiKeyMissingError";
	constructor() {
		super("This Workspace has no AI key.");
	}
}

/** What every process has until AI providers are connected: each call is refused as unavailable. */
export const aiProvidersToCome: AiProviders = {
	describeImage: () =>
		Promise.reject(new AiProviderError("unavailable", "AI providers aren't connected on this Install yet.")),
};

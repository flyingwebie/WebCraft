import {
	type AiAnswer,
	AiProviderError,
	type AiProviderProblem,
	type AiProviders,
	type AiUsage,
	type ImageDescriptionRequest,
	type ReportTextRequest,
	type TranslationRequest,
} from "@webcraft/core";

/** A call WebCraft made to the fake AI providers: an image description, a translation or a key's Test. */
export type FakeAiRequest = ImageDescriptionRequest | TranslationRequest | ReportTextRequest;

/**
 * AI providers that never leave the test (ADR 0011 calls real ones directly). Tests say how they
 * answer; until then every call is refused as unavailable, like a provider that can't be reached.
 */
export type FakeAi = {
	readonly providers: AiProviders;
	/** Answers every image description with `text`, or with what `answer` makes of the request. */
	answer(answer: string | ((request: ImageDescriptionRequest) => AiAnswer | Promise<AiAnswer>)): void;
	/**
	 * Translates every text sent with `translate` (one call, many texts), reporting `usage` for each
	 * call: by default one input token per character sent and one output token per character answered.
	 */
	translateWith(
		translate: (text: string, request: TranslationRequest) => string,
		usage?: AiUsage | ((request: TranslationRequest, texts: string[]) => AiUsage),
	): void;
	/**
	 * Answers every Report's text with what `write` makes of the request (an object, sent as JSON; or
	 * the provider's raw text), reporting `usage` (by default 1,000 tokens in and 300 out).
	 */
	reportWith(write: (request: ReportTextRequest) => unknown, usage?: AiUsage): void;
	/** The Report text requests made so far, oldest first. */
	reportRequests(): ReportTextRequest[];
	/** Every call from then on fails, as a provider that is down, refuses or answers nonsense. */
	fail(problem?: AiProviderProblem): void;
	/** Every request made so far, oldest first. */
	readonly requests: readonly FakeAiRequest[];
	/** The translation requests made so far (Tests included), oldest first. */
	translations(): TranslationRequest[];
};

/** A translation that keeps every marker and shows the language: `[it] Fresh bread`. */
export function taggedTranslation(text: string, request: TranslationRequest): string {
	return `[${request.to.code}] ${text}`;
}

export function createFakeAi(): FakeAi {
	const requests: FakeAiRequest[] = [];
	let failing: AiProviderProblem | null = null;
	let describe: (request: ImageDescriptionRequest) => AiAnswer | Promise<AiAnswer> = () => {
		throw new AiProviderError("unavailable", "The fake AI provider has no answer prepared.");
	};
	let translate: ((request: TranslationRequest) => { texts: string[]; usage: AiUsage }) | null = null;
	let report: ((request: ReportTextRequest) => AiAnswer) | null = null;
	const failed = (problem: AiProviderProblem) => new AiProviderError(problem, `The fake AI provider is ${problem}.`);
	return {
		requests,
		translations: () => requests.filter((request): request is TranslationRequest => "texts" in request),
		reportRequests: () => requests.filter((request): request is ReportTextRequest => request.purpose === "report"),
		reportWith(write, usage = { inputTokens: 1000, outputTokens: 300 }) {
			failing = null;
			report = (request) => {
				const answer = write(request);
				return { text: typeof answer === "string" ? answer : JSON.stringify(answer), usage };
			};
		},
		answer(answer) {
			failing = null;
			describe = typeof answer === "string" ? () => ({ text: answer }) : answer;
		},
		translateWith(translateText, usage) {
			failing = null;
			translate = (request) => {
				const texts = request.texts.map((text) => translateText(text, request));
				const used =
					typeof usage === "function"
						? usage(request, texts)
						: (usage ?? {
								inputTokens: request.texts.join("").length,
								outputTokens: texts.join("").length,
							});
				return { texts, usage: used };
			};
		},
		fail(problem = "unavailable") {
			failing = problem;
		},
		providers: {
			async describeImage(request) {
				requests.push(request);
				if (failing) throw failed(failing);
				return describe(request);
			},
			async writeReport(request) {
				requests.push(request);
				if (failing) throw failed(failing);
				if (!report) throw new AiProviderError("unavailable", "The fake AI provider has no Report text prepared.");
				return report(request);
			},
			async translate(request) {
				requests.push(request);
				if (failing) throw failed(failing);
				if (!translate) throw new AiProviderError("unavailable", "The fake AI provider has no translation prepared.");
				return translate(request);
			},
		},
	};
}

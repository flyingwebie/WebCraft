import { type AiAnswer, AiProviderError, type AiProviders, type ImageDescriptionRequest } from "@webcraft/core";

/**
 * AI providers that never leave the test (ADR 0011 calls real ones directly). Tests say how they
 * answer; until then every call is refused as unavailable, like a provider that can't be reached.
 */
export type FakeAi = {
	readonly providers: AiProviders;
	/** Answers every image description with `text`, or with what `answer` makes of the request. */
	answer(answer: string | ((request: ImageDescriptionRequest) => AiAnswer | Promise<AiAnswer>)): void;
	/** Every call from then on fails, as a provider that is down or refuses. */
	fail(problem?: "unavailable" | "refused"): void;
	/** Every request made so far, oldest first. */
	readonly requests: readonly ImageDescriptionRequest[];
};

export function createFakeAi(): FakeAi {
	const requests: ImageDescriptionRequest[] = [];
	let respond: (request: ImageDescriptionRequest) => AiAnswer | Promise<AiAnswer> = () => {
		throw new AiProviderError("unavailable", "The fake AI provider has no answer prepared.");
	};
	return {
		requests,
		answer(answer) {
			respond = typeof answer === "string" ? () => ({ text: answer }) : answer;
		},
		fail(problem = "unavailable") {
			respond = () => {
				throw new AiProviderError(problem, `The fake AI provider is ${problem}.`);
			};
		},
		providers: {
			async describeImage(request) {
				requests.push(request);
				return respond(request);
			},
		},
	};
}

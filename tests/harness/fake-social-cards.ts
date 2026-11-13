import type { SocialCardInput, SocialCardRenderer } from "@webcraft/core";

/** A controllable rendering edge: its PNG carries the inputs, so HTTP tests can read what was published. */
export function createFakeSocialCards() {
	const rendered: SocialCardInput[] = [];
	let failure = false;
	let pending: (() => Promise<void>) | null = null;
	return {
		rendered,
		fail: () => {
			failure = true;
		},
		work: () => {
			failure = false;
		},
		beforeRender: (fn: (() => Promise<void>) | null) => {
			pending = fn;
		},
		renderer: {
			async render(input: SocialCardInput) {
				rendered.push(input);
				if (failure) throw new Error("Social card rendering failed.");
				await pending?.();
				return new Uint8Array(
					Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(JSON.stringify(input))]),
				);
			},
		} satisfies SocialCardRenderer,
	};
}

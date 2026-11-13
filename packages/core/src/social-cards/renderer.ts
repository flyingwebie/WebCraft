import type { SocialCardLayout } from "./rules.ts";

/** Only local, cleaned raster logo bytes cross this port; renderers never resolve URLs. */
export type SocialCardInput = {
	layout: SocialCardLayout;
	title: string;
	siteName: string;
	language: string;
	colours: { primary: string; accent: string; background: string; text: string };
	logo: Uint8Array | null;
};
export type SocialCardRenderer = { render(input: SocialCardInput): Promise<Uint8Array> };
export const SOCIAL_CARD_MAX_BYTES = 2 * 1024 * 1024;
export const socialCardsOnlyInWorker: SocialCardRenderer = {
	render: async () => {
		throw new Error("Social cards are rendered by the worker only.");
	},
};

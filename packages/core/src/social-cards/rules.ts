/** Original built-in Social card compositions. Shared with the admin; no server imports. */
export const SOCIAL_CARD_LAYOUTS = [
	"editorial",
	"frame",
	"split",
	"band",
	"corner",
	"orbit",
	"arch",
	"steps",
	"grid",
	"spotlight",
	"ribbon",
	"window",
	"stack",
	"diagonal",
	"horizon",
	"columns",
	"ticket",
	"underline",
	"mosaic",
	"capsule",
] as const;
export type SocialCardLayout = (typeof SOCIAL_CARD_LAYOUTS)[number];
export const DEFAULT_SOCIAL_CARD_LAYOUT: SocialCardLayout = "editorial";
export function isSocialCardLayout(value: unknown): value is SocialCardLayout {
	return (SOCIAL_CARD_LAYOUTS as readonly unknown[]).includes(value);
}
export type SocialCardSettings = { enabled: boolean; layout: SocialCardLayout };
export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;
export const SOCIAL_CARD_PATH = "/_wc/social/";

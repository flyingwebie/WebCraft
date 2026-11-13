import { entries, media, mediaFiles, socialCards } from "@webcraft/db/schema";
import { colourSteps, type SocialImage } from "@webcraft/renderer";
import { and, eq, isNull } from "drizzle-orm";
import { siteLanguages } from "../content/languages.ts";
import { listPostTypes } from "../content/post-types.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { publishedDesignSystem } from "../design-system/stylesheet.ts";
import { isUuid } from "../ids.ts";
import { contentHash } from "../media/names.ts";
import { isShareableImage } from "../seo/entry-seo.ts";
import { siteSeoSettings } from "../seo/site-settings.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";
import type { SocialCardInput } from "./renderer.ts";
import { SOCIAL_CARD_HEIGHT, SOCIAL_CARD_PATH, SOCIAL_CARD_WIDTH } from "./rules.ts";

type Reader = Pick<VisitorScope, "first" | "select" | "db" | "site" | "where">;
export type CardSnapshot = {
	hash: string;
	input: Omit<SocialCardInput, "logo">;
	logo: typeof mediaFiles.$inferSelect | null;
};

/** Current published inputs, never a Draft. Their hash is the only authority for using a cached card. */
export async function cardSnapshot(scope: Reader, entryId: string, language: string): Promise<CardSnapshot | null> {
	const settings = await siteSeoSettings(scope);
	if (!settings.socialCards.enabled) return null;
	const row = await scope.first(entries, eq(entries.id, entryId));
	if (!row?.published) return null;
	const languages = await siteLanguages(scope);
	if (!languages.languages.some((item) => item.code === language)) return null;
	const version = storedVersion(row.published);
	const inLanguage = { language, defaultLanguage: languages.defaultLanguage };
	if (!isVisibleIn(version, inLanguage)) return null;
	const postType = (await listPostTypes(scope)).find((item) => item.id === row.postTypeId);
	if (!postType) return null;
	const design = await publishedDesignSystem(scope);
	const colours = design.tokens.colours;
	const primary = colours.find((item) => item.name === "primary") ?? colours[0];
	const accent = colours.find((item) => item.name === "accent") ?? colours[1] ?? primary;
	const neutral = colours.find((item) => item.name === "neutral");
	const neutralSteps = neutral ? colourSteps(neutral, "light") : {};
	let logo: typeof mediaFiles.$inferSelect | null = null;
	if (settings.organization.logo) {
		const item = await scope.first(media, and(eq(media.id, settings.organization.logo), isNull(media.trashedAt)));
		if (item?.status === "ready" && isShareableImage(item)) {
			logo =
				(await scope.first(
					mediaFiles,
					and(eq(mediaFiles.mediaId, item.id), eq(mediaFiles.role, "original"), isNull(mediaFiles.retiredAt)),
				)) ?? null;
		}
	}
	const siteName = settings.siteName ?? scope.site.name;
	const title = readValue(version, { key: "title", ...inLanguage }) || siteName;
	const input: CardSnapshot["input"] = {
		layout: postType.seo.socialCardLayout ?? settings.socialCards.layout,
		title,
		siteName,
		language,
		colours: {
			primary: primary ? (colourSteps(primary, "light")["60"] ?? primary.light.base) : "#2563eb",
			accent: accent ? (colourSteps(accent, "light")["60"] ?? accent.light.base) : "#f97316",
			background: neutralSteps["10"] ?? "#fafafa",
			text: neutralSteps["95"] ?? "#18181b",
		},
	};
	// Include the original's content-addressed name, not its storage location; a storage move changes no card.
	// Bump the renderer version when the artwork changes so reconciliation replaces cached images.
	const hash = await contentHash(
		new TextEncoder().encode(JSON.stringify({ renderer: 2, input, logo: logo?.name ?? null })),
	);
	return { hash, input, logo };
}

export function cardPath(entryId: string, language: string, hash: string): string {
	return `${SOCIAL_CARD_PATH}${entryId}/${language}/${hash}.png`;
}

/** A card is ready only for the current published inputs, even if an obsolete worker finishes later. */
export async function publishedCard(
	scope: Reader,
	entryId: string,
	language: string,
	origin: string,
): Promise<SocialImage | null> {
	const snapshot = await cardSnapshot(scope, entryId, language);
	if (!snapshot) return null;
	const [cached] = await scope.db
		.select({ hash: socialCards.hash })
		.from(socialCards)
		.where(
			scope.where(
				socialCards,
				and(eq(socialCards.entryId, entryId), eq(socialCards.language, language), eq(socialCards.hash, snapshot.hash)),
			),
		);
	return cached
		? {
				url: origin + cardPath(entryId, language, cached.hash),
				type: "image/png",
				width: SOCIAL_CARD_WIDTH,
				height: SOCIAL_CARD_HEIGHT,
				alt: snapshot.input.title,
			}
		: null;
}

/** The file route also checks publication, language visibility and switch-off; a known old URL grants no access. */
export async function socialCardFile(scope: Reader, path: string): Promise<{ png: Uint8Array; hash: string } | null> {
	const match = /^([0-9a-f-]{36})\/([A-Za-z0-9-]+)\/([0-9a-f]{64})\.png$/.exec(path);
	if (!match) return null;
	const [, entryId, language, hash] = match;
	if (!entryId || !isUuid(entryId) || !language || !hash) return null;
	const snapshot = await cardSnapshot(scope, entryId, language);
	if (!snapshot || snapshot.hash !== hash) return null;
	const cached = await scope.first(
		socialCards,
		and(eq(socialCards.entryId, entryId), eq(socialCards.language, language), eq(socialCards.hash, hash)),
	);
	return cached ? { png: cached.png, hash } : null;
}

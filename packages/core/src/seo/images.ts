import { media, mediaFiles } from "@webcraft/db/schema";
import type { SocialImage } from "@webcraft/renderer";
import { and, inArray, isNull } from "drizzle-orm";

import type { Languages } from "../content/field-values.ts";
import { isUuid } from "../ids.ts";
import { originalUrl, variantsOf } from "../media/library.ts";
import { readText, storedTexts } from "../media/texts.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";
import { isShareableImage } from "./entry-seo.ts";

/** How wide a shared image should be at least: the size social networks show large. */
export const SHARED_WIDTH = 1200;

/**
 * The Media images among `ids` that other sites and search engines can show (ready images of the
 * Site's Media library, not in the Trash, not SVGs), by id, as absolute addresses on `origin`: each
 * one's narrowest WebP variant at least `SHARED_WIDTH` wide, else its original (narrower than that, or
 * waiting for its variants), with its size and its alt text in the page's language. The server never crops (ADR 0027): the
 * whole image is shown, so its Focal point plays no part here (the Social card, #93, composes with it).
 */
export async function shareableImages(
	scope: Pick<VisitorScope, "select">,
	ids: readonly (string | null | undefined)[],
	languages: Languages,
	origin: string,
): Promise<Map<string, SocialImage>> {
	const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && isUuid(id)))].map((id) =>
		id.toLowerCase(),
	);
	const found = new Map<string, SocialImage>();
	if (wanted.length === 0) return found;
	const rows = await scope.select(media, and(inArray(media.id, wanted), isNull(media.trashedAt)));
	const files = await scope.select(
		mediaFiles,
		and(
			inArray(mediaFiles.mediaId, wanted),
			inArray(mediaFiles.role, ["original", "variant"]),
			isNull(mediaFiles.retiredAt),
		),
	);
	for (const row of rows) {
		if (row.status !== "ready" || !isShareableImage(row)) continue;
		const own = files.filter((file) => file.mediaId === row.id);
		const original = originalUrl(row, own);
		if (!original) continue;
		const webp = variantsOf(own).filter((variant) => variant.format === "webp");
		// No variant that wide means the original is narrower than it: then the original is the best there is.
		const chosen = webp.find((variant) => variant.width >= SHARED_WIDTH);
		const alt = readText(storedTexts(row.texts), "alt", languages);
		found.set(
			row.id,
			chosen
				? { url: `${origin}${chosen.url}`, type: "image/webp", width: chosen.width, height: chosen.height, alt }
				: { url: `${origin}${original}`, type: row.contentType, width: row.width, height: row.height, alt },
		);
	}
	return found;
}

/** The first of the candidates (in order) that `shareableImages` found; null when none is. */
export function firstImage(
	images: ReadonlyMap<string, SocialImage>,
	candidates: readonly (string | null | undefined)[],
): SocialImage | null {
	for (const id of candidates) {
		const image = id ? images.get(id.toLowerCase()) : undefined;
		if (image) return image;
	}
	return null;
}

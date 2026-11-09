import { media, mediaFiles } from "@webcraft/db/schema";
import type { PageMedia } from "@webcraft/renderer";
import { and, eq, inArray } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";
import { VARIANT_FORMATS } from "./images.ts";
import type { MediaKind } from "./kinds.ts";
import { originalUrl, variantsOf } from "./library.ts";
import { readText, storedTexts } from "./texts.ts";

/**
 * The Media items a page shows, by id, as the renderer needs them: the original's address and size,
 * the variants by format and the alt text in the page's language. Only the Site's own items that
 * visitors can get (ready) are found.
 */
export async function pageMedia(
	scope: VisitorScope,
	ids: readonly string[],
	languages: { language: string; defaultLanguage: string },
): Promise<Map<string, PageMedia>> {
	const wanted = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
	if (wanted.length === 0) return new Map();
	const rows = await scope.select(media, and(inArray(media.id, wanted), eq(media.status, "ready")));
	if (rows.length === 0) return new Map();
	const files = await scope.select(
		mediaFiles,
		and(
			inArray(
				mediaFiles.mediaId,
				rows.map((row) => row.id),
			),
			inArray(mediaFiles.role, ["original", "variant"]),
		),
	);
	const found = new Map<string, PageMedia>();
	for (const row of rows) {
		const own = files.filter((file) => file.mediaId === row.id);
		const url = originalUrl(row, own);
		if (!url) continue;
		const variants = variantsOf(own);
		found.set(row.id, {
			kind: row.kind as MediaKind,
			url,
			width: row.width,
			height: row.height,
			alt: readText(storedTexts(row.texts), "alt", languages),
			sources: VARIANT_FORMATS.map((format) => ({
				type: `image/${format}`,
				candidates: variants
					.filter((variant) => variant.format === format)
					.map((variant) => ({ url: variant.url, width: variant.width })),
			})),
		});
	}
	return found;
}

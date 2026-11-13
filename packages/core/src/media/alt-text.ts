import { mediaFiles } from "@webcraft/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import type { AiKeys } from "../ai/keys.ts";
import { AiKeyMissingError, AiProviderError, type AiProviders } from "../ai/providers.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { InstallStorage } from "./install-storage.ts";
import type { StorageKind } from "./storage.ts";
import { MEDIA_TEXT_MAX_LENGTH } from "./texts.ts";

/**
 * Why no alt text can be suggested for a file: `kind` (it isn't an image), `notReady` (the worker
 * hasn't cleaned it yet, or refused it) or `format` (no file in a format providers read: an SVG).
 */
export class AltTextUnavailableError extends Error {
	override name = "AltTextUnavailableError";
	readonly reason: "kind" | "notReady" | "format";
	constructor(reason: "kind" | "notReady" | "format") {
		super(
			reason === "kind"
				? "Alt text is suggested for images only."
				: reason === "notReady"
					? "The image isn't ready yet."
					: "This image can't be sent to an AI provider.",
		);
		this.reason = reason;
	}
}

/** The formats AI providers read images in. */
const READABLE = new Set(["jpeg", "png", "webp", "gif"]);

/** The width an image is sent at: the smallest WebP width at least this wide. */
const SENT_WIDTH = 640;

/** Whether the Workspace has an AI key (its own, or a shared one), so alt text can be suggested. */
export async function canSuggestAltText(keys: AiKeys, workspaceId: string): Promise<boolean> {
	return (await keys.readiness(workspaceId)).key !== null;
}

/** What a description is expected to use at most: the image and the prompt, then one sentence. */
const ESTIMATE = { inputTokens: 2_000, outputTokens: 300 };

/**
 * Asks an AI provider, with the AI key the Workspace uses (its own, else the shared one), for alt
 * text describing an image in `language`, recording what the call cost for the Site. Nothing is
 * saved. `item` is the image as the library reads it (ready, not in the Trash).
 */
export async function suggestAltText(
	options: { ai: AiProviders; keys: AiKeys; storage: InstallStorage },
	scope: SiteScope,
	item: {
		id: string;
		kind: string;
		status: string;
		fileName: string;
		title: string | null;
		caption: string | null;
		language: string;
	},
): Promise<string> {
	if (item.kind !== "image") throw new AltTextUnavailableError("kind");
	if (item.status !== "ready") throw new AltTextUnavailableError("notReady");
	if (!(await canSuggestAltText(options.keys, scope.workspace.id))) throw new AiKeyMissingError();
	const files = await scope.select(mediaFiles, and(eq(mediaFiles.mediaId, item.id), isNull(mediaFiles.retiredAt)));
	const widths = files
		.filter((file) => file.role === "variant" && file.format === "webp" && file.width !== null)
		.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
	const original = files.find((file) => file.role === "original" && READABLE.has(file.format));
	const sent = widths.find((file) => (file.width ?? 0) >= SENT_WIDTH) ?? widths.at(-1) ?? original;
	if (!sent) throw new AltTextUnavailableError("format");
	const data = await (await options.storage.holding(sent.storage as StorageKind)).read(sent.key);
	if (!data) throw new AltTextUnavailableError("notReady");
	// The key is filled in for this call only; it never leaves the call.
	const answer = await options.keys.call(
		{ workspaceId: scope.workspace.id, siteId: scope.site.id },
		"altText",
		ESTIMATE,
		async (connection) => {
			const described = await options.ai.describeImage({
				connection,
				purpose: "altText",
				image: { data, contentType: sent.contentType },
				language: item.language,
				hints: { fileName: item.fileName, title: item.title, caption: item.caption },
			});
			return { value: described.text, usage: described.usage };
		},
	);
	const text = answer.trim().slice(0, MEDIA_TEXT_MAX_LENGTH.alt);
	if (!text) throw new AiProviderError("refused", "The AI provider wrote no alt text.");
	return text;
}

import { mediaFiles } from "@webcraft/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { AiKeyMissingError, AiProviderError, type AiProviders, WORKSPACE_AI_KEY } from "../ai.ts";
import type { ScopedSecrets, SiteScope } from "../tenancy/data-layer.ts";
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

/** Whether the Workspace's AI key is set, so alt text can be suggested. */
export async function canSuggestAltText(workspaceSecrets: ScopedSecrets): Promise<boolean> {
	return (await workspaceSecrets.describe(WORKSPACE_AI_KEY)).set;
}

/**
 * Asks an AI provider, with the Workspace's AI key, for alt text describing an image in `language`.
 * Nothing is saved. `item` is the image as the library reads it (ready, not in the Trash).
 */
export async function suggestAltText(
	options: { ai: AiProviders; storage: InstallStorage },
	scope: SiteScope,
	workspaceSecrets: ScopedSecrets,
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
	if (!(await canSuggestAltText(workspaceSecrets))) throw new AiKeyMissingError();
	const files = await scope.select(mediaFiles, and(eq(mediaFiles.mediaId, item.id), isNull(mediaFiles.retiredAt)));
	const widths = files
		.filter((file) => file.role === "variant" && file.format === "webp" && file.width !== null)
		.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
	const original = files.find((file) => file.role === "original" && READABLE.has(file.format));
	const sent = widths.find((file) => (file.width ?? 0) >= SENT_WIDTH) ?? widths.at(-1) ?? original;
	if (!sent) throw new AltTextUnavailableError("format");
	const data = await (await options.storage.holding(sent.storage as StorageKind)).read(sent.key);
	if (!data) throw new AltTextUnavailableError("notReady");
	// The key is filled in for this call only; it never leaves `useWith`.
	const answer = await workspaceSecrets.useWith(WORKSPACE_AI_KEY, (key) =>
		options.ai.describeImage({
			key,
			purpose: "altText",
			image: { data, contentType: sent.contentType },
			language: item.language,
			hints: { fileName: item.fileName, title: item.title, caption: item.caption },
		}),
	);
	const text = answer.text.trim().slice(0, MEDIA_TEXT_MAX_LENGTH.alt);
	if (!text) throw new AiProviderError("refused", "The AI provider wrote no alt text.");
	return text;
}

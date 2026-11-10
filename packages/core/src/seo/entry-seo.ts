import { entries, media } from "@webcraft/db/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";

import type { FieldDefinition, GroupField, Json } from "../content/field-types.ts";
import {
	type Languages,
	readFields,
	type StoredValues,
	type WriteContext,
	writeFields,
} from "../content/field-values.ts";
import { checkReferences } from "../content/relationships.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * SEO fields (GLOSSARY.md): the values every Entry, Pages included, has for search engines and social
 * sharing, beside its title and slug. They are part of its Draft and publish with it. They are stored
 * the way Fields are (ADR 0003), as a Group under the key `seo` in each version: the SEO title,
 * description, canonical URL and social image per language, falling back to the Default language one
 * value at a time; noindex one value for every language, under the Default language. They aren't a
 * Post Type's Fields: Staff can't remove them, and no Field can take the key `seo`.
 */
export type EntrySeo = {
	/** The page's whole title as search engines show it; null to use the Post Type's title pattern. */
	title: string | null;
	/** What search engines show under the title; null for the Post Type's fallback. */
	description: string | null;
	/** The page's canonical URL (an http or https address, or a path on the Site); null for its own address. */
	canonical: string | null;
	/** The image other sites show when the page is shared: a Media image's id; null for the fallback. */
	image: string | null;
	/** Whether search engines are asked not to index the page (one value for every language). */
	noindex: boolean;
};

/** A change to an Entry's SEO fields: only those given change; null or "" clears one. */
export type EntrySeoChange = Partial<Record<keyof EntrySeo, unknown>>;

/** The key the SEO fields are stored under in a version, which no Field may take. */
export const SEO_KEY = "seo";

/** The most characters a canonical URL may have. */
export const CANONICAL_MAX_LENGTH = 2_000;

function leaf<Type extends "text" | "media" | "boolean">(
	key: string,
	label: string,
	type: Type,
	translatable: boolean,
) {
	const common = { key, label, help: "", required: false, translatable, default: null };
	return (
		type === "text" ? { ...common, type, minLength: null, maxLength: null, pattern: null } : { ...common, type }
	) as FieldDefinition;
}

/**
 * The SEO fields as a Group of Fields, so they are stored, read and moved between languages exactly as
 * Fields are. None has a rule: what search engines prefer (lengths, an image) is a Check, never a
 * reason not to publish.
 */
export const SEO_GROUP: GroupField = {
	key: SEO_KEY,
	label: "SEO fields",
	type: "group",
	help: "",
	required: false,
	translatable: false,
	default: null,
	fields: [
		leaf("title", "SEO title", "text", true),
		leaf("description", "Description", "text", true),
		leaf("canonical", "Canonical URL", "text", true),
		leaf("image", "Social image", "media", true),
		leaf("noindex", "Noindex", "boolean", false),
	],
};

/** An Entry version's SEO fields in a language, each falling back to the Default language's. */
export function readEntrySeo(values: StoredValues, languages: Languages): EntrySeo {
	const read = readFields(values, [SEO_GROUP], languages)[SEO_KEY] as Record<string, Json>;
	const text = (value: Json | undefined) => (typeof value === "string" && value !== "" ? value : null);
	return {
		title: text(read.title),
		description: text(read.description),
		canonical: text(read.canonical),
		image: text(read.image),
		noindex: read.noindex === true,
	};
}

/**
 * Writes a change to an Entry version's SEO fields, in the context's language (noindex under the
 * Default language). Values of the wrong kind go to `context.problems` at their path (`seo.canonical`)
 * and leave the value as it was: a canonical URL that isn't an http or https address or a path on the
 * Site, a social image that isn't an image of the Site's Media library (an SVG neither: other sites
 * can't show one).
 */
export async function writeEntrySeo(
	scope: Pick<SiteScope, "db" | "where" | "site" | "componentSources">,
	values: StoredValues,
	change: EntrySeoChange,
	context: WriteContext,
): Promise<StoredValues> {
	if (typeof change !== "object" || change === null || Array.isArray(change)) {
		context.problems.push({ at: SEO_KEY, message: "SEO fields are given by name." });
		return values;
	}
	const input = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
	if (typeof input.canonical === "string" && input.canonical.trim() !== "" && !isCanonical(input.canonical.trim())) {
		context.problems.push({
			at: `${SEO_KEY}.canonical`,
			message: "A canonical URL is an http or https address, or a path on the Site starting with /.",
		});
		delete input.canonical;
	}
	if (typeof input.image === "string" && input.image !== "" && isUuid(input.image)) {
		if (!(await isSocialImageOf(scope, input.image))) {
			context.problems.push({
				at: `${SEO_KEY}.image`,
				message: "A social image is a JPEG, PNG, WebP, AVIF or GIF image of the Site's Media library.",
			});
			delete input.image;
		}
	}
	const references: WriteContext["references"] = [];
	const written = writeFields(values, [SEO_GROUP], { [SEO_KEY]: input }, { ...context, references }, "", "An Entry");
	await checkReferences(
		scope,
		references.map((reference) => ({ ...reference, problems: context.problems })),
		"refuse",
	);
	return written;
}

/** Whether text is a canonical URL WebCraft writes into pages: an absolute http(s) address or a Site path. */
export function isCanonical(text: string): boolean {
	if (text.length > CANONICAL_MAX_LENGTH || [...text].some(isSpaceOrControl)) return false;
	if (text.startsWith("/")) return !text.startsWith("//");
	try {
		const url = new URL(text);
		return (
			(url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "" && !url.username && !url.password
		);
	} catch {
		return false;
	}
}

/** White space, a backslash or a control character: none belongs in a URL WebCraft writes. */
function isSpaceOrControl(character: string): boolean {
	const code = character.codePointAt(0) ?? 0;
	return code <= 0x20 || code === 0x7f || character === "\\" || /\s/u.test(character);
}

/** Whether a Media item of the scope's Site can be a social image: an image other sites show, not in the Trash. */
export async function isSocialImageOf(
	scope: Pick<SiteScope, "db" | "where" | "site" | "componentSources">,
	mediaId: string,
): Promise<boolean> {
	const [row] = await scope.db
		.select({ kind: media.kind, contentType: media.contentType })
		.from(media)
		.where(scope.where(media, and(eq(media.id, mediaId), isNull(media.trashedAt))));
	return row !== undefined && isShareableImage(row);
}

/** The image types other sites show for a shared page: JPEG, PNG, WebP, AVIF and GIF; never SVG. */
export function isShareableImage(item: { kind: string; contentType: string }): boolean {
	return item.kind === "image" && item.contentType !== "image/svg+xml";
}

/**
 * A condition on `entries` rows: the published version doesn't ask search engines to stay away
 * (noindex). Site search adds it to its query, so a noindex Entry isn't among its hits; sitemaps
 * (#92) and `llms.txt` leave such Entries out by the same rule.
 */
export function publishedIndexable(languages: Pick<Languages, "defaultLanguage">): SQL {
	return sql`coalesce(${entries.published} -> 'values' -> ${SEO_KEY}::text -> 'values' -> 'noindex' -> ${languages.defaultLanguage}::text ->> 'value', 'false') <> 'true'`;
}

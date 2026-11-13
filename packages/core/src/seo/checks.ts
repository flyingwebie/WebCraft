import type { Json } from "../content/field-types.ts";
import type { Languages } from "../content/field-values.ts";
import type { PostType } from "../content/post-types.ts";
import { entryParts, type Parts, resolvePath } from "../content/render-values.ts";
import type { SocialCardLayout } from "../social-cards/rules.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { EntrySeo } from "./entry-seo.ts";
import { firstImage, shareableImages } from "./images.ts";
import { descriptionFrom, imageFrom, titleFor } from "./page-seo.ts";
import { SEO_CHECK_LIMITS, type SeoCheckKind } from "./seo-rules.ts";
import { siteSeoSettings } from "./site-settings.ts";

/**
 * What search engines and other sites get from an Entry's Draft, in a language, through the same
 * fallbacks its page uses: its whole title, its description, and its social image with where it comes
 * from (the Entry's own, the Post Type's image Field, a Social card planned for publication, or the Site's default image). The Entry editor's SEO card shows it.
 */
export type SeoPreview = {
	title: string;
	description: string | null;
	image:
		| { mediaId: string; from: "entry" | "field" | "site" }
		| { from: "socialCard"; layout: SocialCardLayout; state: "onPublish" }
		| null;
};

/**
 * One warning of the SEO check: where it is (`seo.title`, `seo.description`, `seo.image`), what it is
 * about (`SEO_CHECKS`, for the admin to word) and the numbers its words need (`length`, `max`, `min`).
 */
export type SeoCheck = { at: string; check: SeoCheckKind; params?: Readonly<Record<string, number>> };

/** What the SEO check finds on a Draft, and what its page would carry. */
export type SeoDraftReport = { preview: SeoPreview; checks: SeoCheck[] };

/** A Draft's values, as the content store hands them out. */
type DraftValues = { title: string; fields: Readonly<Record<string, Json>>; seo: EntrySeo };

const NO_SITE: Parts = { text: null, part: () => undefined };

/**
 * The SEO check (a Check, GLOSSARY.md) of Drafts of one Post Type, each with its preview: a title
 * longer than search engines show, a missing, short or long description, no social image, and a
 * social image without alt text in the language. Warnings only: never a reason not to publish.
 */
export async function seoReports(
	scope: SiteScope,
	postType: PostType,
	drafts: readonly DraftValues[],
	languages: Languages,
): Promise<SeoDraftReport[]> {
	if (drafts.length === 0) return [];
	const settings = await siteSeoSettings(scope);
	const siteName = settings.siteName ?? scope.site.name;
	const read = drafts.map((draft) => {
		const root = entryParts({ title: draft.title }, postType.fields, draft.fields, {
			related: new Map(),
			site: NO_SITE,
		});
		const values = (path: string) => resolvePath(root, path);
		return { draft, values, field: imageFrom(postType, postType.seo, values) };
	});
	const images = await shareableImages(
		scope,
		[...read.flatMap(({ draft, field }) => [draft.seo.image, field]), settings.defaultImage],
		languages,
		"",
	);
	return read.map(({ draft, values, field }) => {
		const title = draft.seo.title ?? titleFor(siteName, settings.separator, postType.seo, draft.title, postType.name);
		const description = draft.seo.description ?? descriptionFrom(postType, postType.seo, values);
		const candidates = [
			{ mediaId: draft.seo.image, from: "entry" as const },
			{ mediaId: field, from: "field" as const },
			{ mediaId: settings.defaultImage, from: "site" as const },
		];
		const own = candidates.slice(0, 2).find((candidate) => firstImage(images, [candidate.mediaId]) !== null);
		const generated = !own && settings.socialCards.enabled;
		const chosen =
			own ??
			(!generated ? candidates.find((candidate) => firstImage(images, [candidate.mediaId]) !== null) : undefined);
		const image = chosen ? firstImage(images, [chosen.mediaId]) : null;
		const checks: SeoCheck[] = [];
		const { titleMax, descriptionMin, descriptionMax } = SEO_CHECK_LIMITS;
		if ([...title].length > titleMax) {
			checks.push({ at: "seo.title", check: "seoTitleLong", params: { length: [...title].length, max: titleMax } });
		}
		const length = description ? [...description].length : 0;
		if (!description) checks.push({ at: "seo.description", check: "seoDescriptionMissing" });
		else if (length < descriptionMin) {
			checks.push({ at: "seo.description", check: "seoDescriptionShort", params: { length, min: descriptionMin } });
		} else if (length > descriptionMax) {
			checks.push({ at: "seo.description", check: "seoDescriptionLong", params: { length, max: descriptionMax } });
		}
		if (!image && !generated) checks.push({ at: "seo.image", check: "seoImageMissing" });
		else if (image && !image.alt?.trim()) checks.push({ at: "seo.image", check: "seoImageAlt" });
		return {
			preview: {
				title,
				description,
				image: generated
					? {
							from: "socialCard" as const,
							layout: postType.seo.socialCardLayout ?? settings.socialCards.layout,
							state: "onPublish" as const,
						}
					: chosen?.mediaId
						? { mediaId: chosen.mediaId.toLowerCase(), from: chosen.from }
						: null,
			},
			checks,
		};
	});
}

/** The SEO check's words in English, for API clients; the admin words each check from its code. */
export const SEO_CHECK_MESSAGES: Readonly<Record<SeoCheckKind, (params: Readonly<Record<string, number>>) => string>> =
	{
		seoTitleLong: ({ length, max }) =>
			`The title is ${length} characters long: search engines show about ${max}, and cut the rest.`,
		seoDescriptionMissing: () => "The page has no description: search engines will pick some of its text instead.",
		seoDescriptionShort: ({ length, min }) =>
			`The description is ${length} characters long: at least ${min} says more about the page.`,
		seoDescriptionLong: ({ length, max }) =>
			`The description is ${length} characters long: search engines show about ${max}, and cut the rest.`,
		seoImageMissing: () => "The page has no social image: shared links will show without a picture.",
		seoImageAlt: () => "The social image has no alt text in this language.",
	};

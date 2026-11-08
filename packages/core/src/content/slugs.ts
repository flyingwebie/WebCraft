/** The longest slug WebCraft makes from a title; people may type longer ones, up to the slug limit. */
const MADE_SLUG_MAX_LENGTH = 80;

/**
 * A slug made from a title or name: accents dropped, lower case, everything other than letters and
 * digits turned into single dashes. "Crème brûlée, 2 ways!" gives `creme-brulee-2-ways`. Empty when
 * the text has no Latin letters or digits.
 */
export function slugify(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MADE_SLUG_MAX_LENGTH)
		.replace(/-+$/, "");
}

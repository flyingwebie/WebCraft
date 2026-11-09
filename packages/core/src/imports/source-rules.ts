/**
 * What a Module source's keys can go into, by the kind of value they hold: the rules the server
 * checks an Import's settings with, and the admin's Map step offers. It imports nothing, so the
 * admin's browser code reads it too (`@webcraft/core/import-rules`).
 */

/** The kinds of value a source's key holds: an item's own title and slug, then its values' kinds. */
export const SOURCE_VALUE_KINDS = ["title", "slug", "text", "html", "date", "file", "items"] as const;

export type SourceValueKind = (typeof SOURCE_VALUE_KINDS)[number];

/** Where a key can go besides a Field. */
export const SOURCE_KEY_TARGETS = [
	"title",
	"slug",
	"seo.title",
	"seo.description",
	"seo.canonical",
	"seo.noindex",
	"seo.image",
] as const;

export type SourceKeyPlace = (typeof SOURCE_KEY_TARGETS)[number];

/** The Field types a run can add for a key. */
export const NEW_FIELD_TYPES = [
	"text",
	"richText",
	"body",
	"date",
	"media",
	"relationship",
	"number",
	"boolean",
	"email",
	"link",
] as const;

export type NewFieldType = (typeof NEW_FIELD_TYPES)[number];

/** What kinds of value each place (a key target, or a Field type) takes. */
const TAKES: Readonly<Record<string, readonly SourceValueKind[]>> = {
	title: ["title", "slug", "text", "html", "date"],
	slug: ["slug", "text"],
	"seo.title": ["title", "text", "html"],
	"seo.description": ["title", "text", "html"],
	"seo.canonical": ["text"],
	"seo.noindex": ["text"],
	"seo.image": ["file"],
	text: ["title", "slug", "text", "html", "date"],
	richText: ["title", "text", "html"],
	body: ["html", "text"],
	date: ["date", "text"],
	media: ["file", "text"],
	relationship: ["items"],
	number: ["text"],
	boolean: ["text"],
	email: ["text"],
	link: ["text"],
	select: ["text"],
};

/** Whether a key whose values are `kind` can go into `place` (a key target or a Field type). */
export function takes(place: string, kind: SourceValueKind): boolean {
	return (TAKES[place] ?? []).includes(kind);
}

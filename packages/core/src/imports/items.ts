/**
 * What a source hands the Import pipeline: items read from it, each to become one Entry (later also
 * Media items and Redirect rules, which the WordPress import (#112) and the Redirects Module (#94)
 * add). A source reads its own format; from here on every source's items are written the same way.
 */
import type { Json, LeafField } from "../content/field-types.ts";
import type { Languages } from "../content/field-values.ts";
import type { PostType } from "../content/post-types.ts";

/**
 * Where a source's Entry items go: one Post Type, values in one of the Site's languages, matched to
 * existing Entries by one value (`title`, `slug` or `fields.<key>`). A source works this out from its
 * own settings (the CSV source from its mapping).
 */
export type ItemDestination = { postType: PostType; languages: Languages; match: { to: string } };

/**
 * A problem with an item, at its column (a CSV column; null for the whole item) with its rule and
 * what fills in its wording. `row`: the item can't be written at all (it matches several Entries,
 * has no matching value…); otherwise only the value at `column` is left out.
 */
export type ItemProblem = {
	column: string | null;
	rule: string;
	params?: Record<string, string | number>;
	row?: boolean;
};

/**
 * A value an item can only give once something is found: Entries by slug or title (a Relationship),
 * a file fetched by its `https` address, or a Media library file by its id (a media Field).
 */
export type ItemFind = {
	column: string;
	/** Where the value goes: a Field's key, inside its Groups. */
	path: string[];
	field: LeafField;
	reading: { entries: string[] } | { file: string } | { media: string };
};

/** One Entry an item becomes, before the run writes it as a Draft. */
export type EntryItem = {
	/** Where it is in the source: a CSV file's row number (the header is row 1). */
	position: number;
	/** The identifier it has in the source; null when it has none (a row problem says why). */
	sourceId: string | null;
	/** The value it matches existing Entries by (`title`, `slug` or `fields.<key>`). */
	match: { to: string; value: Json } | null;
	/** Its values, as saving a Draft takes them; empty values are left out (they change nothing). */
	values: { title?: string; slug?: string; fields: Record<string, unknown> };
	finds: ItemFind[];
	problems: ItemProblem[];
};

/**
 * A piece of source content no Block type matches (a shortcode, page-builder markup), kept as plain
 * text in the Entry and listed in the Import report for someone to fix. CSV files have none; the
 * WordPress import (#112) records them.
 */
export type ImportLeftover = { row: number; entryId: string | null; title: string | null; text: string };

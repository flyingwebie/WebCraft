import type { ModuleContext } from "./context.ts";
import type { Label } from "./manifest.ts";

/**
 * Import sources (SDK 1.7): how a Module brings outside content into a Site through WebCraft's one
 * Import pipeline (GLOSSARY.md › Importing). The Module only reads its source's format into items;
 * WebCraft does everything after that, the same way for every source: it surveys the items (their
 * types, keys and a few samples), lets Staff map each type to a Post Type and each key to a Field,
 * previews a run without writing or fetching anything, writes every item as a Draft with its Source
 * id, fetches files into the Media library through the guarded fetcher, makes Redirect rules where
 * paths changed, and keeps the Import report and Undo.
 *
 * A source reads a file someone uploads: WebCraft takes it in parts (up to `IMPORT_FILE_MAX_BYTES`),
 * keeps it privately (never in the Media library, never served) and hands the Module its text as a
 * stream, as many times as the Module reads it, in the worker. A source must stream: hold what it
 * needs to know across items (a list of addresses, say), never the whole file.
 */
export type ImportSource = {
	/** Names the source within the Module: lower-case letters and dashes, such as `export`. */
	key: string;
	/** What people choose on the Import's Source step: "WordPress export file". */
	label: Label;
	/** One line under the label: "Upload the .xml file". */
	description: Label;
	/**
	 * The Permission a person needs to import from it, besides WebCraft's `import.run`: one of the
	 * Module's own, or a WebCraft one checked on Sites (`structure.edit` keeps it to Staff, as a run
	 * may create Post Types).
	 */
	permission: string;
	/** The file it reads: its largest size and the file name endings the admin offers. */
	file: { maxBytes: number; extensions: readonly string[] };
	live?: never;
	/**
	 * Reads the file into items, in the order they are to be written: a `type` before the first item
	 * of that type, and an item another item points at (a parent Page, a term) before it where the
	 * source allows. Throw a `ModuleError` to refuse a file that isn't one the source reads (its code
	 * and message are shown to the person); anything else that goes wrong is a failure.
	 *
	 * It must give the same items in the same order every time it reads the same file: a long run is
	 * gone through by several jobs, each reading from the start and skipping what was written.
	 */
	read(file: SourceFile, context: ModuleContext): AsyncIterable<SourceItem>;
};

/** A live declaration (SDK 1.13), using only Core's source-bound, secret-backed GET port. */
export type LiveImportSourceDefinition = Pick<ImportSource, "key" | "label" | "description" | "permission"> & {
	file?: never;
	read?: never;
	live: LiveImportSource;
};

/** The file and live declarations a Module may offer in its source catalogue. */
export type ModuleImportSource = ImportSource | LiveImportSourceDefinition;

/** Declares an import source. */
export function importSource(source: ImportSource): ImportSource;
export function importSource(source: LiveImportSourceDefinition): LiveImportSourceDefinition;
export function importSource(source: ModuleImportSource): ModuleImportSource;
export function importSource(source: ModuleImportSource): ModuleImportSource {
	return source;
}

/** The largest file an import source may take: 1 GiB. */
export const IMPORT_FILE_MAX_BYTES = 1024 ** 3;

/** The file an import source reads. */
export type SourceFile = {
	/** Its name as uploaded, without folders. */
	readonly name: string;
	readonly size: number;
	/**
	 * Its text as UTF-8, in pieces, from the start; each call reads it again. Bytes that aren't UTF-8
	 * stop the reading with WebCraft's own refusal.
	 */
	text(): AsyncIterable<string>;
};

/** What a source reads: the types its items have, Entries (and terms), and Media files. */
export type SourceItem = SourceType | SourceEntry | SourceMedia;

/**
 * A type of item in the source, given before its first item: what Staff map onto a Post Type (or,
 * for files, the Media library).
 */
export type SourceType = {
	kind: "type";
	/** Its key in the source, such as `post`, `page`, `product` or `category`. */
	key: string;
	/** Its name for people: "Posts". */
	label: string;
	/** Entries (posts, pages, terms…) or Media files. */
	holds: "entries" | "media";
};

/** An item that becomes an Entry: a post, a page, a term. */
export type SourceEntry = {
	kind: "entry";
	/** Its type's key. */
	type: string;
	/**
	 * Its identifier in the source, unique among the source's items (`wp:post:12`): kept as the
	 * Entry's Source id, so a later run updates the same Entry.
	 */
	sourceId: string;
	title: string;
	/** Its slug in the source, if it has one; WebCraft makes one from the title otherwise. */
	slug: string | null;
	/** The Source id of its parent, for nested items (Pages); null at the top level. */
	parent: string | null;
	/**
	 * Where it was on the old site, as a path (`/2024/03/spring-hours/`), for a Redirect rule to its
	 * new path; null when it had none a visitor could follow.
	 */
	path: string | null;
	/** Its values by key: built-in ones such as `content`, `excerpt`, `date`, and the source's own. */
	values: Readonly<Record<string, SourceValue>>;
	/**
	 * What the source knows of files its HTML values name, by the address written there: the file to
	 * fetch instead (the full-size original of a resized copy), and its texts.
	 */
	files?: Readonly<Record<string, SourceFileRef>>;
};

/** A file that becomes a Media library item. */
export type SourceMedia = {
	kind: "media";
	type: string;
	sourceId: string;
	file: SourceFileRef;
	/** Where it was on the old site, as a path, for a Redirect rule to the Media file. */
	path: string | null;
};

/**
 * A file to fetch into the Media library, by its address, with the texts it comes with, and where it
 * was on the old site as a path (for a Redirect rule from its old address to the Media file).
 */
export type SourceFileRef = { address: string; title?: string; alt?: string; caption?: string; path?: string };

/**
 * One value of an item:
 * - `text`: plain text;
 * - `html`: HTML (a body, an excerpt), which WebCraft turns into Blocks or cleaned rich text;
 * - `date`: a moment in time, `2024-03-12T09:30:00Z`;
 * - `file`: a file to fetch into the Media library (a featured image);
 * - `items`: other items of the source, by Source id (the terms a post has), which become Relationships.
 */
export type SourceValue =
	| { kind: "text"; text: string }
	| { kind: "html"; html: string }
	| { kind: "date"; date: string }
	| { kind: "file"; file: SourceFileRef }
	| { kind: "items"; sourceIds: readonly string[] };

/** Live Import sources (SDK 1.13). No raw credentials, arbitrary URLs or request headers. */
export type LiveConnection = {
	readonly includeHidden: boolean;
	/** A relative route under the chosen Site's discovered REST root. GET only; redirects refused. */
	http(path: string, options?: { anonymous?: boolean }): Promise<Response>;
};
export type LiveSurvey = {
	roles: string[];
	types: { key: string; label: string; route: string; holds: "entries" | "media"; taxonomy: boolean; count: number }[];
};
export type LiveImportSource = {
	test(connection: LiveConnection): Promise<LiveSurvey>;
	read(connection: LiveConnection, survey: LiveSurvey): AsyncIterable<SourceItem>;
};

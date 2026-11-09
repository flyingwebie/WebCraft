import { ModuleError } from "@webcraft/module-sdk";
import { SaxesParser, type SaxesTagNS } from "saxes";

/**
 * Reading a WordPress export file (WXR: RSS 2.0 with WordPress's own namespace) as a stream. The
 * file can be 1 GB, so nothing holds it whole: the parser takes it a piece at a time and hands back
 * each record of the channel (the site, an author, a term, an item) as soon as it closes, as a
 * small tree of its own, which is dropped once read.
 *
 * Safety: the file comes from outside. A document type declaration is refused outright, so no
 * entity can be declared (no "billion laughs", no external entities reaching files or addresses);
 * the parser knows only XML's five predefined entities and character references, and refuses any
 * other. Text that keeps coming without a tag (a single value of hundreds of megabytes) is refused
 * before it fills the memory, and so is an item larger than `MAX_RECORD_CHARACTERS`.
 */

/** An element of a record: its name (`wp:post_id`, `title`), attributes, text and child elements. */
export type XmlElement = {
	name: string;
	attributes: Readonly<Record<string, string>>;
	text: string;
	children: XmlElement[];
};

/** A record of the export's channel, as it closes. */
export type XmlRecord =
	| { kind: "site"; title: string; link: string; baseSite: string }
	| { kind: "author" | "category" | "tag" | "term" | "item"; element: XmlElement };

/** The most characters a value may run without a tag, and the most one record (an item) may hold. */
export const MAX_TEXT_RUN = 64 * 1024 * 1024;
export const MAX_RECORD_CHARACTERS = 96 * 1024 * 1024;

/** How deep elements nest inside a record before the file is refused. */
const MAX_DEPTH = 32;

/** The prefix each namespace's names are written with here, whatever prefix the file chose. */
function prefixOf(uri: string): string | null {
	if (uri === "") return "";
	if (/^http:\/\/wordpress\.org\/export\/\d+\.\d+\/excerpt\/$/.test(uri)) return "excerpt";
	if (/^http:\/\/wordpress\.org\/export\/\d+\.\d+\/$/.test(uri)) return "wp";
	if (uri === "http://purl.org/rss/1.0/modules/content/") return "content";
	if (uri === "http://purl.org/dc/elements/1.1/") return "dc";
	return null;
}

function nameOf(tag: { uri: string; local: string }): string {
	const prefix = prefixOf(tag.uri);
	if (prefix === null) return `other:${tag.local}`;
	return prefix === "" ? tag.local : `${prefix}:${tag.local}`;
}

/** The records a channel holds, by element name. */
const RECORDS: Readonly<Record<string, Exclude<XmlRecord["kind"], "site">>> = {
	"wp:author": "author",
	"wp:category": "category",
	"wp:tag": "tag",
	"wp:term": "term",
	item: "item",
};

/** Elements dropped with what they hold: comments on posts are never imported. */
const DROPPED: ReadonlySet<string> = new Set(["wp:comment"]);

function refuse(code: string, message: string): never {
	throw new ModuleError(code, message, 400);
}

/**
 * The records of an export file, in order, read from its text as it streams. Refuses (a
 * `ModuleError` the person sees) a file that isn't XML, holds a document type declaration, or isn't a
 * WordPress export.
 */
export async function* exportRecords(text: AsyncIterable<string>): AsyncGenerator<XmlRecord> {
	const parser = new SaxesParser({ xmlns: true, position: false });
	const ready: XmlRecord[] = [];
	let failure: Error | null = null;
	let sinceEvent = 0;
	let depth = 0;
	let sawRoot = false;
	let isExport = false;
	const site = { title: "", link: "", baseSite: "" };
	/** The element path from the root while outside a record (`rss`, `channel`, `title`). */
	const outside: string[] = [];
	/** The record being built, its elements open from it inward, and how many characters it holds. */
	let open: XmlElement[] = [];
	let recordKind: Exclude<XmlRecord["kind"], "site"> | null = null;
	let recordCharacters = 0;
	/** Inside a dropped element: how deep. */
	let dropping = 0;

	const seen = () => {
		sinceEvent = 0;
	};
	parser.on("error", (error) => {
		failure ??= error;
	});
	parser.on("doctype", () => {
		failure ??= new ModuleError(
			"doctype",
			"The file declares a document type, which a WordPress export never does: it was refused.",
			400,
		);
	});
	parser.on("opentag", (tag) => {
		seen();
		const name = nameOf(tag as SaxesTagNS);
		if (!sawRoot) {
			sawRoot = true;
			if (name !== "rss") failure ??= new ModuleError("notExport", "This file isn't a WordPress export file.", 400);
		}
		if (dropping > 0 || (recordKind && DROPPED.has(name))) {
			dropping++;
			return;
		}
		if (recordKind) {
			depth++;
			if (depth > MAX_DEPTH) failure ??= new ModuleError("xml", "The file nests elements too deeply.", 400);
			const element: XmlElement = { name, attributes: attributesOf(tag as SaxesTagNS), text: "", children: [] };
			open.at(-1)?.children.push(element);
			open.push(element);
			return;
		}
		const record = outside.length === 2 && outside[1] === "channel" ? RECORDS[name] : undefined;
		if (record) {
			recordKind = record;
			recordCharacters = 0;
			depth = 1;
			open = [{ name, attributes: attributesOf(tag as SaxesTagNS), text: "", children: [] }];
			return;
		}
		outside.push(name);
		if (name === "wp:wxr_version") isExport = true;
	});
	const addText = (value: string) => {
		seen();
		if (dropping > 0) return;
		const element = open.at(-1);
		if (recordKind && element) {
			recordCharacters += value.length;
			if (recordCharacters > MAX_RECORD_CHARACTERS) {
				failure ??= new ModuleError("itemTooLarge", "An item of the file is too large to import.", 400);
				return;
			}
			element.text += value;
			return;
		}
		if (outside.length === 3 && outside[1] === "channel") {
			const name = outside[2];
			if (name === "title") site.title += value;
			else if (name === "link") site.link += value;
			else if (name === "wp:base_site_url") site.baseSite += value;
		}
	};
	parser.on("text", addText);
	parser.on("cdata", addText);
	parser.on("closetag", () => {
		seen();
		if (dropping > 0) {
			dropping--;
			return;
		}
		if (recordKind) {
			const element = open.pop();
			depth--;
			if (open.length === 0 && element) {
				ready.push({ kind: recordKind, element });
				recordKind = null;
			}
			return;
		}
		const closed = outside.pop();
		if (closed === "channel") ready.unshift({ kind: "site", ...trimmed(site) });
	});

	let announced = false;
	const flush = function* (): Generator<XmlRecord> {
		if (failure) throw asRefusal(failure);
		while (ready.length > 0) {
			const record = ready.shift() as XmlRecord;
			// The site's own details come first, before any record that needs its address.
			if (!announced && record.kind !== "site") {
				announced = true;
				yield { kind: "site", ...trimmed(site) };
			}
			if (record.kind === "site") {
				if (announced) continue;
				announced = true;
			}
			if (!isExport && record.kind !== "site") {
				refuse("notExport", "This file isn't a WordPress export file.");
			}
			yield record;
		}
	};

	for await (const piece of text) {
		for (let start = 0; start < piece.length; start += 65_536) {
			const part = piece.slice(start, start + 65_536);
			sinceEvent += part.length;
			if (sinceEvent > MAX_TEXT_RUN) {
				refuse("valueTooLarge", "A value in the file is too large to import.");
			}
			parser.write(part);
			yield* flush();
		}
	}
	parser.close();
	yield* flush();
	if (!sawRoot) refuse("notExport", "This file isn't a WordPress export file.");
	if (!isExport) refuse("notExport", "This file isn't a WordPress export file.");
}

function trimmed(site: { title: string; link: string; baseSite: string }) {
	return { title: site.title.trim(), link: site.link.trim(), baseSite: site.baseSite.trim() };
}

function attributesOf(tag: SaxesTagNS): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const attribute of Object.values(tag.attributes)) {
		if (attribute.prefix === "xmlns" || attribute.name === "xmlns") continue;
		attributes[attribute.local] = attribute.value;
	}
	return attributes;
}

function asRefusal(error: Error): Error {
	if (error instanceof ModuleError) return error;
	return new ModuleError("xml", `The file isn't well-formed XML: ${error.message}`, 400);
}

/** The text of a record's child element by name (`wp:post_id`), trimmed; "" when it has none. */
export function childText(element: XmlElement, name: string): string {
	return element.children.find((child) => child.name === name)?.text.trim() ?? "";
}

/** The text of a child element as written (a body keeps its own spacing). */
export function childRaw(element: XmlElement, name: string): string {
	return element.children.find((child) => child.name === name)?.text ?? "";
}

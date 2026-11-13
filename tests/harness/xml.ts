// Reads XML as a crawler does, strictly: a document that isn't well-formed (an unclosed or
// mismatched tag, an attribute without quotes, a stray `<` or `&`, an unknown entity, text outside the
// root element) throws. Used to check sitemaps; it reads elements, attributes and text, nothing more
// (no DTDs, no processing instructions but the XML declaration, no CDATA).
import { expect } from "bun:test";

/** An element: its qualified name, its attributes and what it holds, in order. */
export type XmlElement = {
	name: string;
	attributes: Record<string, string>;
	children: XmlElement[];
	/** Its text, entities read, child elements left out. */
	text: string;
};

const NAME = /^[A-Za-z_][\w.:-]*/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Parses an XML document strictly; throws on anything that isn't well-formed. Answers its root element. */
export function parseXml(xml: string): XmlElement {
	let at = 0;
	const fail = (what: string): never => {
		throw new Error(`Not well-formed XML at ${at}: ${what} (…${xml.slice(Math.max(0, at - 30), at + 30)}…)`);
	};
	const skipSpace = () => {
		while (at < xml.length && /\s/.test(xml[at] as string)) at++;
	};
	const readName = () => {
		const match = NAME.exec(xml.slice(at));
		if (!match) fail("a name expected");
		at += (match as RegExpExecArray)[0].length;
		return (match as RegExpExecArray)[0];
	};
	const decode = (text: string) =>
		text.replace(/&([^;\s&<]*);?/g, (whole, name: string) => {
			if (!whole.endsWith(";")) fail("an & that starts no entity");
			if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
			if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
			const known = ENTITIES[name];
			if (known === undefined) fail(`an unknown entity &${name};`);
			return known as string;
		});
	if (xml.startsWith("<?xml")) {
		const end = xml.indexOf("?>");
		if (end < 0) fail("an unclosed XML declaration");
		at = end + 2;
	}
	const readElement = (): XmlElement => {
		if (xml[at] !== "<") fail("an element expected");
		at++;
		const name = readName();
		const attributes: Record<string, string> = {};
		for (;;) {
			skipSpace();
			if (xml.startsWith("/>", at)) {
				at += 2;
				return { name, attributes, children: [], text: "" };
			}
			if (xml[at] === ">") {
				at++;
				break;
			}
			const attribute = readName();
			skipSpace();
			if (xml[at] !== "=") fail("= expected after an attribute's name");
			at++;
			skipSpace();
			const quote = xml[at];
			if (quote !== '"' && quote !== "'") fail("an attribute's value must be quoted");
			const end = xml.indexOf(quote as string, at + 1);
			if (end < 0) fail("an unclosed attribute value");
			const raw = xml.slice(at + 1, end);
			if (raw.includes("<")) fail("a < in an attribute value");
			if (attribute in attributes) fail(`the attribute ${attribute} twice`);
			attributes[attribute] = decode(raw);
			at = end + 1;
		}
		const children: XmlElement[] = [];
		let text = "";
		for (;;) {
			if (at >= xml.length) fail(`<${name}> isn't closed`);
			if (xml.startsWith("</", at)) {
				at += 2;
				const closing = readName();
				if (closing !== name) fail(`</${closing}> closes <${name}>`);
				skipSpace();
				if (xml[at] !== ">") fail("> expected");
				at++;
				return { name, attributes, children, text };
			}
			if (xml.startsWith("<!--", at)) {
				const end = xml.indexOf("-->", at);
				if (end < 0) fail("an unclosed comment");
				at = end + 3;
				continue;
			}
			if (xml[at] === "<") {
				children.push(readElement());
				continue;
			}
			const next = xml.indexOf("<", at);
			const raw = xml.slice(at, next < 0 ? xml.length : next);
			if (raw.includes(">") && raw.includes("]]>")) fail("]]> in text");
			text += decode(raw);
			at += raw.length;
		}
	};
	skipSpace();
	const root = readElement();
	skipSpace();
	if (at !== xml.length) fail("something after the root element");
	return root;
}

/** The child elements with this name. */
export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
	return element.children.filter((child) => child.name === name);
}

/** The text of the one child element with this name. */
export function childText(element: XmlElement, name: string): string | undefined {
	return childrenNamed(element, name)[0]?.text;
}

/** The sitemaps protocol's namespace, which every sitemap and sitemap index uses. */
export const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";

/** A W3C datetime, as `lastmod` must be: a date, or a date and time with its offset. */
const W3C_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** One `<url>` of a sitemap: its address, when it last changed and its language alternates. */
export type SitemapUrl = { loc: string; lastmod?: string; alternates: [string, string][] };

/**
 * Reads a sitemap (`<urlset>`) as a search engine does, checking it against the protocol: the
 * namespace, absolute http(s) addresses under 2,048 characters, W3C datetimes, at most 50,000 URLs,
 * and `hreflang` alternates as `xhtml:link rel="alternate"`.
 */
export function readSitemap(xml: string): SitemapUrl[] {
	const root = parseXml(xml);
	expect(root.name).toBe("urlset");
	expect(root.attributes.xmlns).toBe(SITEMAP_NAMESPACE);
	const urls = childrenNamed(root, "url");
	expect(urls.length).toBeLessThanOrEqual(50_000);
	expect(root.children.every((child) => child.name === "url")).toBe(true);
	return urls.map((url) => {
		const loc = childText(url, "loc") ?? "";
		expectAddress(loc);
		const lastmod = childText(url, "lastmod");
		if (lastmod !== undefined) expect(lastmod).toMatch(W3C_DATETIME);
		const alternates = childrenNamed(url, "xhtml:link").map((link): [string, string] => {
			expect(root.attributes["xmlns:xhtml"]).toBe("http://www.w3.org/1999/xhtml");
			expect(link.attributes.rel).toBe("alternate");
			expectAddress(link.attributes.href ?? "");
			return [link.attributes.hreflang ?? "", link.attributes.href ?? ""];
		});
		return { loc, ...(lastmod === undefined ? {} : { lastmod }), alternates };
	});
}

/** One `<sitemap>` of a sitemap index. */
export type SitemapEntry = { loc: string; lastmod?: string };

/** Reads a sitemap index (`<sitemapindex>`), checking it against the protocol. */
export function readSitemapIndex(xml: string): SitemapEntry[] {
	const root = parseXml(xml);
	expect(root.name).toBe("sitemapindex");
	expect(root.attributes.xmlns).toBe(SITEMAP_NAMESPACE);
	expect(root.children.every((child) => child.name === "sitemap")).toBe(true);
	return childrenNamed(root, "sitemap").map((sitemap) => {
		const loc = childText(sitemap, "loc") ?? "";
		expectAddress(loc);
		const lastmod = childText(sitemap, "lastmod");
		if (lastmod !== undefined) expect(lastmod).toMatch(W3C_DATETIME);
		return { loc, ...(lastmod === undefined ? {} : { lastmod }) };
	});
}

function expectAddress(address: string): void {
	expect(address).toMatch(/^https?:\/\//);
	expect(address.length).toBeLessThan(2_048);
	expect(() => new URL(address)).not.toThrow();
}

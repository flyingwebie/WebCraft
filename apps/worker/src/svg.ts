// SVG cleaning for the Media library, in the worker on Node (spec › Media pipeline). An uploaded SVG
// is read as XML, checked for what could run code or reach outside, stripped of what only a drawing
// program reads, then passed through DOMPurify (on jsdom, as its authors advise for servers). A file
// is refused rather than changed: when DOMPurify would remove anything that shows, or the file holds
// scripts, event handlers, foreignObject, outside references or entities, it is never served.
import { type CleanedSvg, type SvgFinding, SvgRefusedError } from "@webcraft/core";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const SVG = "http://www.w3.org/2000/svg";
const XLINK = "http://www.w3.org/1999/xlink";
const XML = "http://www.w3.org/XML/1998/namespace";
const XMLNS = "http://www.w3.org/2000/xmlns/";

/**
 * Namespaces drawing programs write their own state in (layers, guides, document settings): left
 * out, since no browser shows them.
 */
const EDITOR_NAMESPACES = new Set([
	"http://www.inkscape.org/namespaces/inkscape",
	"http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
	"http://www.bohemiancoding.com/sketch/ns",
	"http://ns.adobe.com/AdobeIllustrator/10.0/",
	"http://ns.adobe.com/Graphs/1.0/",
	"http://ns.adobe.com/AdobeSVGViewerExtensions/3.0/",
	"http://ns.adobe.com/Extensibility/1.0/",
	"http://ns.adobe.com/Flows/1.0/",
	"http://ns.adobe.com/ImageReplacement/1.0/",
	"http://ns.adobe.com/SaveForWeb/1.0/",
	"http://ns.adobe.com/Variables/1.0/",
	"http://ns.adobe.com/xap/1.0/",
	"http://www.serif.com/",
	"http://www.w3.org/1999/02/22-rdf-syntax-ns#",
	"http://purl.org/dc/elements/1.1/",
	"http://creativecommons.org/ns#",
]);

/** The document DOMPurify parses into, which it reports as removed. */
const WRAPPERS = new Set(["html", "head", "body"]);

/** The largest SVG cleaned: a drawing, not a data dump. */
const MAX_SVG_BYTES = 10 * 1024 * 1024;

/** Images an SVG may hold inline: raster pictures only (an SVG inside could hold its own script). */
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;

const window = new JSDOM("").window;
const purify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

/** Cleans an uploaded SVG, or throws `SvgRefusedError`. */
export function cleanSvg(input: Uint8Array): CleanedSvg {
	if (input.length > MAX_SVG_BYTES) throw new SvgRefusedError("svgInvalid", [], "it is too large");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input).replace(/^\uFEFF/, "");
	} catch {
		throw new SvgRefusedError("svgInvalid", [], "it isn't UTF-8 text");
	}
	const found = new Set<SvgFinding>();
	// Entities could make the file read anything (or grow without end): a document type with
	// declarations of its own is refused before the file is parsed.
	if (/<!DOCTYPE[^>[]*\[/i.test(text) || /<!ENTITY/i.test(text)) found.add("entity");
	// A style sheet processing instruction loads CSS from elsewhere.
	if (/<\?xml-stylesheet/i.test(text)) found.add("outsideReference");
	if (found.size > 0) throw new SvgRefusedError("svgUnsafe", [...found]);

	const document = new window.DOMParser().parseFromString(text, "image/svg+xml");
	const root = document.documentElement;
	if (document.getElementsByTagName("parsererror").length > 0 || !root) {
		throw new SvgRefusedError("svgInvalid", [], "it isn't well-formed XML");
	}
	if (root.namespaceURI !== SVG || root.localName !== "svg") {
		throw new SvgRefusedError("svgInvalid", [], "it isn't an SVG document");
	}

	inspect(root, found);
	if (found.size > 0) throw new SvgRefusedError("svgUnsafe", [...found]);

	// DOMPurify, as its authors advise, on the file as text: whatever it removes beyond what is left
	// out above would change what the file shows, so the file is refused instead.
	const kept = new window.XMLSerializer().serializeToString(root);
	const fragment = purify.sanitize(kept, {
		USE_PROFILES: { svg: true, svgFilters: true },
		// Reuse within the file (`<use href="#id">`); `inspect` refused any reference to another file.
		ADD_TAGS: ["use"],
		RETURN_DOM_FRAGMENT: true,
	}) as unknown as DocumentFragment;
	for (const removed of purify.removed as { element?: Element; attribute?: Attr | null }[]) {
		// DOMPurify reads the text into a document of its own and reports leaving out that document's
		// <body>; nothing of the file is in it.
		if (!removed.attribute && WRAPPERS.has(removed.element?.nodeName.toLowerCase() ?? "")) continue;
		found.add(removed.attribute ? "attribute" : "element");
	}
	const cleaned = fragment.firstElementChild;
	if (found.size > 0 || !cleaned || cleaned.localName !== "svg") {
		throw new SvgRefusedError("svgUnsafe", found.size > 0 ? [...found] : ["element"]);
	}
	const data = new TextEncoder().encode(`${new window.XMLSerializer().serializeToString(cleaned)}\n`);
	return { data, ...sizeOf(cleaned) };
}

/**
 * Walks the SVG: records what makes it unsafe in `found`, and leaves out comments, processing
 * instructions, `<metadata>` and what drawing programs write in their own namespaces.
 */
function inspect(element: Element, found: Set<SvgFinding>): void {
	for (const attribute of [...element.attributes]) {
		const name = attribute.localName.toLowerCase();
		if (attribute.namespaceURI === XMLNS) {
			if (EDITOR_NAMESPACES.has(attribute.value)) element.removeAttributeNode(attribute);
			continue;
		}
		if (attribute.namespaceURI && EDITOR_NAMESPACES.has(attribute.namespaceURI)) {
			element.removeAttributeNode(attribute);
			continue;
		}
		if (attribute.namespaceURI && attribute.namespaceURI !== XLINK && attribute.namespaceURI !== XML) {
			found.add("attribute");
			continue;
		}
		if (name.startsWith("on")) found.add("eventHandler");
		if (name === "href") {
			const value = attribute.value.trim();
			const inline = element.localName === "image" && INLINE_IMAGE.test(value);
			if (!value.startsWith("#") && !inline) found.add("outsideReference");
		}
		if (refersOutside(attribute.value)) found.add("outsideReference");
	}
	if (element.localName === "style" && element.namespaceURI === SVG) {
		const css = element.textContent ?? "";
		if (/@import/i.test(css) || refersOutside(css)) found.add("outsideReference");
	}
	for (const child of [...element.childNodes]) {
		if (child.nodeType === child.COMMENT_NODE || child.nodeType === child.PROCESSING_INSTRUCTION_NODE) {
			child.remove();
			continue;
		}
		if (child.nodeType !== child.ELEMENT_NODE) continue;
		const node = child as Element;
		if (node.namespaceURI && EDITOR_NAMESPACES.has(node.namespaceURI)) {
			node.remove();
			continue;
		}
		if (node.namespaceURI !== SVG) {
			found.add(node.localName.toLowerCase() === "script" ? "script" : "element");
			continue;
		}
		const name = node.localName.toLowerCase();
		if (name === "metadata") {
			node.remove();
			continue;
		}
		if (name === "script") found.add("script");
		if (name === "foreignobject") found.add("foreignObject");
		inspect(node, found);
	}
}

/**
 * Whether CSS or an attribute value names anything but this file: a `url()` that isn't `url(#id)`,
 * or an `image-set()`. CSS escapes are read as CSS reads them first (`u\72 l(` is `url(`).
 */
function refersOutside(value: string): boolean {
	const css = value.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex: string | undefined, char: string | undefined) =>
		hex ? String.fromCodePoint(Math.min(Number.parseInt(hex, 16), 0x10ffff)) : (char ?? ""),
	);
	if (/image-set\s*\(/i.test(css)) return true;
	for (const match of css.matchAll(/url\s*\(/gi)) {
		const argument = css
			.slice((match.index ?? 0) + match[0].length)
			.trimStart()
			.replace(/^['"]/, "")
			.trimStart();
		if (!argument.startsWith("#")) return true;
	}
	return false;
}

/** An SVG's size in CSS pixels: its `width` and `height` in pixels, else its `viewBox`'s. */
function sizeOf(svg: Element): { width: number | null; height: number | null } {
	const pixels = (value: string | null) => {
		const match = value ? /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value) : null;
		return match ? Math.round(Number(match[1])) : null;
	};
	const box = (svg.getAttribute("viewBox") ?? "")
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const boxWidth = box.length === 4 && box.every(Number.isFinite) ? Math.round(box[2] ?? 0) : null;
	const boxHeight = box.length === 4 && box.every(Number.isFinite) ? Math.round(box[3] ?? 0) : null;
	const width = pixels(svg.getAttribute("width")) ?? boxWidth;
	const height = pixels(svg.getAttribute("height")) ?? boxHeight;
	return { width: width && width > 0 ? width : null, height: height && height > 0 ? height : null };
}

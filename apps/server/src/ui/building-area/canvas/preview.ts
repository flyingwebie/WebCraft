/**
 * A page drawn with changes not saved yet (BA-11, the HTML pane): the server renders the page as the
 * frame would load it with the markup being typed in place of its source's Draft (`code/preview`), and
 * the frame shows that body and its stylesheet in place, as `editing/rerender.ts` does for a saved
 * change. The stylesheet comes as text: it is adopted as a constructed stylesheet (the page's policy
 * allows those, not inline styles) and the Site's own stylesheet is switched off meanwhile. Drawing the
 * page again from its Drafts (`endPreview`, then `swapPage`) takes the preview away.
 */

/** Where the Site's stylesheet is served: published, or Edit mode's from the Design system's Draft. */
const SITE_STYLESHEETS = ["/_wc/css/", "/_webcraft/edit/css/"];

/** The constructed stylesheet a preview adopted, per page document. */
const sheets = new WeakMap<Document, CSSStyleSheet>();

let previewing = 0;

/** Shows a previewed page in the frame in place: its body (no scripts) and its stylesheet. Answers the document, or null. */
export function showPreview(frame: HTMLIFrameElement, html: string, css: string): Document | null {
	const run = ++previewing;
	const doc = frame.contentDocument;
	const win = frame.contentWindow as (Window & typeof globalThis) | null;
	if (!doc || !win || !doc.body || run !== previewing) return null;
	const parsed = new DOMParser().parseFromString(html, "text/html");
	try {
		const sheet = sheets.get(doc) ?? new win.CSSStyleSheet();
		sheet.replaceSync(css);
		if (!doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
		sheets.set(doc, sheet);
		for (const link of siteLinks(doc)) link.disabled = true;
	} catch {
		// A browser without constructed stylesheets keeps the page's stylesheet as loaded.
	}
	const scroll = { x: win.scrollX, y: win.scrollY };
	const nodes = [...parsed.body.childNodes].map((node) => doc.importNode(node, true));
	const kept = nodes.filter((node) => !(node instanceof win.Element && node.localName === "script"));
	for (const node of kept)
		if (node instanceof win.Element) for (const script of node.querySelectorAll("script")) script.remove();
	doc.body.replaceChildren(...kept);
	win.scrollTo(scroll.x, scroll.y);
	return doc;
}

/** Takes a preview's stylesheet away: the Site's own applies again. Answers whether there was one. */
export function endPreview(frame: HTMLIFrameElement): boolean {
	previewing++;
	const doc = frame.contentDocument;
	const sheet = doc ? sheets.get(doc) : undefined;
	if (!doc || !sheet) return false;
	doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((each) => each !== sheet);
	sheets.delete(doc);
	for (const link of siteLinks(doc)) link.disabled = false;
	return true;
}

function siteLinks(doc: Document): HTMLLinkElement[] {
	return [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter((link) =>
		SITE_STYLESHEETS.some((path) => link.getAttribute("href")?.startsWith(path)),
	);
}

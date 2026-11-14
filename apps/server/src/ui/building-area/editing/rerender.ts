/**
 * Draws the page in the frame again in place (ADR 0037 › 1.5, BA-08): after a change to its Structure
 * (a Template's or Component's Draft, a Class), the shell asks the Site for the page as the frame would
 * load it and swaps the frame document's body and the Site's stylesheet for the new ones. The frame is
 * not reloaded: scroll stays where it was, the agent's listeners stay, and the shell selects again what
 * was selected.
 *
 * What it doesn't do (risk R4 of the plan): none of the page's scripts runs again. The Site script, the
 * page script and Component scripts ran once, on the page as it loaded; parts they draw keep showing
 * what they drew. A full reload (the frame navigating) runs them again.
 *
 * Answers whether the page was drawn again: false when the frame shows another page by then, when the
 * answer isn't the page, or when a newer drawing started meanwhile (the newest wins).
 */

/** Where the Site's stylesheet is served: published, or Edit mode's from the Design system's Draft. */
const SITE_STYLESHEETS = ["/_wc/css/", "/_webcraft/edit/css/"];

/** How long a new stylesheet may take to load before it is swapped in anyway, in milliseconds. */
const STYLESHEET_WAIT_MS = 3000;

let drawing = 0;

export async function swapPage(frame: HTMLIFrameElement): Promise<Document | null> {
	const run = ++drawing;
	const doc = frame.contentDocument;
	const win = frame.contentWindow;
	if (!doc || !win || !doc.body) return null;
	const address = `${win.location.pathname}${win.location.search}`;
	let text: string;
	try {
		const answer = await fetch(address, { credentials: "same-origin", cache: "no-store" });
		if (!(answer.headers.get("content-type") ?? "").startsWith("text/html")) return null;
		text = await answer.text();
	} catch {
		return null;
	}
	// The frame went elsewhere meanwhile, or a newer drawing started: this one is out of date.
	if (run !== drawing || frame.contentDocument !== doc || `${win.location.pathname}${win.location.search}` !== address)
		return null;
	const parsed = new DOMParser().parseFromString(text, "text/html");

	await swapStylesheets(doc, parsed);
	if (run !== drawing || frame.contentDocument !== doc) return null;

	const scroll = { x: win.scrollX, y: win.scrollY };
	// The new body's nodes, made in the frame's document, without their scripts: nothing runs again.
	const elementOf = (node: Node): Element | null => (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : null);
	const nodes = [...parsed.body.childNodes].map((node) => doc.importNode(node, true));
	for (const node of nodes) for (const script of elementOf(node)?.querySelectorAll("script") ?? []) script.remove();
	const kept = nodes.filter((node) => elementOf(node)?.localName !== "script");
	for (const name of doc.body.getAttributeNames()) {
		if (!parsed.body.hasAttribute(name)) doc.body.removeAttribute(name);
	}
	for (const name of parsed.body.getAttributeNames()) {
		doc.body.setAttribute(name, parsed.body.getAttribute(name) ?? "");
	}
	doc.body.replaceChildren(...kept);
	win.scrollTo(scroll.x, scroll.y);
	return doc;
}

/** Links the new page's Site stylesheet in place of the old one, once it has loaded (no flash of unstyled page). */
async function swapStylesheets(doc: Document, parsed: Document): Promise<void> {
	const isSite = (link: HTMLLinkElement) =>
		SITE_STYLESHEETS.some((path) => link.getAttribute("href")?.startsWith(path));
	const now = [...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(isSite);
	const wanted = [...parsed.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(isSite);
	const hrefs = (links: HTMLLinkElement[]) => links.map((link) => link.getAttribute("href") ?? "");
	if (JSON.stringify(hrefs(now)) === JSON.stringify(hrefs(wanted))) return;
	const added = wanted.map((link) => {
		const made = doc.createElement("link");
		made.rel = "stylesheet";
		made.href = link.getAttribute("href") ?? "";
		return made;
	});
	const anchor = now[now.length - 1];
	if (anchor) anchor.after(...added);
	else doc.head.append(...added);
	await Promise.all(
		added.map(
			(link) =>
				new Promise<void>((resolve) => {
					const done = () => resolve();
					link.addEventListener("load", done, { once: true });
					link.addEventListener("error", done, { once: true });
					setTimeout(done, STYLESHEET_WAIT_MS);
				}),
		),
	);
	for (const link of now) link.remove();
}

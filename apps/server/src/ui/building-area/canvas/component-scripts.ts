/**
 * Component scripts for Placements added to the page in the frame later (BA-32; "Component scripts" in
 * docs/development.md). A Component script runs once per Placement root: WebCraft's runtime calls it
 * for each root as its loader runs, and in Edit mode (`data-wc-watch`) for every root added to the page
 * afterwards, so a Placement the page shows again in place (the page drawn again after a change, a
 * section added) gets its call.
 *
 * What the runtime can't do is run a script the page never loaded: a Component placed on this page
 * for the first time (inserted, a section added, a Placement duplicated). The page as it first loaded
 * has no loader for it. This watches the page for Placement roots (`data-wc-component`) of a Component
 * whose loader it lacks, reads the page again as the frame loads it, and adds that page's loaders for
 * them (and the runtime, if the page had none), each once: the runtime then calls the script on them.
 *
 * Nothing is added in Safe mode (the page runs none of the Site's scripts) or on a stand-in.
 */

/** A Placement root, its Components' ids space-separated. */
const ROOT = "[data-wc-component]";

/** How long added roots are gathered before the page is read again, in milliseconds. */
const GATHER_MS = 60;

export function watchComponentScripts(frame: HTMLIFrameElement, page: Document): () => void {
	const win = page.defaultView;
	if (!win || page.querySelector('meta[name="webcraft-safe-mode"][content="on"]')) return () => {};
	/** Components whose loader was asked for already (found or not): never asked twice on this page. */
	const asked = new Set<string>();
	let timer: number | undefined;
	let stopped = false;

	const loaded = (): Set<string> =>
		new Set(
			[...page.querySelectorAll("script[data-wc-component-script]")].map(
				(script) => script.getAttribute("data-wc-component-script") ?? "",
			),
		);

	const missing = (): string[] => {
		const have = loaded();
		const ids = new Set<string>();
		for (const root of page.querySelectorAll(ROOT)) {
			// The runtime never calls a script on a Placement that is hidden.
			if (root.closest("[data-wc-hidden]")) continue;
			for (const id of (root.getAttribute("data-wc-component") ?? "").split(/\s+/)) {
				if (id && !have.has(id) && !asked.has(id)) ids.add(id);
			}
		}
		return [...ids];
	};

	const add = async () => {
		const wanted = missing();
		if (wanted.length === 0 || stopped || frame.contentDocument !== page) return;
		for (const id of wanted) asked.add(id);
		let fresh: Document;
		try {
			const answer = await fetch(`${win.location.pathname}${win.location.search}`, {
				credentials: "same-origin",
				cache: "no-store",
			});
			if (!(answer.headers.get("content-type") ?? "").startsWith("text/html")) return;
			fresh = new DOMParser().parseFromString(await answer.text(), "text/html");
		} catch {
			return;
		}
		if (stopped || frame.contentDocument !== page) return;
		const tags: HTMLScriptElement[] = [];
		const runtime = fresh.querySelector<HTMLScriptElement>("script[data-wc-watch]");
		const runtimeSrc = runtime?.getAttribute("src");
		if (runtimeSrc && !page.querySelector(`script[src="${CSS.escape(runtimeSrc)}"]`)) {
			const made = page.createElement("script");
			made.src = runtimeSrc;
			made.async = false;
			made.setAttribute("data-wc-watch", "");
			tags.push(made);
		}
		for (const id of wanted) {
			const loader = fresh.querySelector<HTMLScriptElement>(
				`script[data-wc-component-script="${CSS.escape(id)}"][type="module"]`,
			);
			const src = loader?.getAttribute("src");
			if (!loader || !src || page.querySelector(`script[data-wc-component-script="${CSS.escape(id)}"]`)) continue;
			const made = page.createElement("script");
			made.type = "module";
			made.async = false;
			made.src = src;
			made.setAttribute("data-wc-component-script", id);
			made.setAttribute("data-wc-component-name", loader.getAttribute("data-wc-component-name") ?? "");
			made.setAttribute("data-wc-added", "");
			tags.push(made);
		}
		if (tags.length > 0) page.head.append(...tags);
	};

	const schedule = () => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => void add(), GATHER_MS);
	};

	const observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== Node.ELEMENT_NODE) continue;
				const element = node as Element;
				if (element.matches(ROOT) || element.querySelector(ROOT)) {
					schedule();
					return;
				}
			}
		}
	});
	observer.observe(page.documentElement, { childList: true, subtree: true });
	// Roots already on the page whose script it didn't load (a Component the person placed meanwhile).
	schedule();
	return () => {
		stopped = true;
		window.clearTimeout(timer);
		observer.disconnect();
	};
}

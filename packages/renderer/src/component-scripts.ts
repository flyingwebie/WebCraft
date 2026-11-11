/**
 * Component scripts (GLOSSARY.md): the script Staff write for one Component, loaded once on each page
 * that shows it and run for each of its Placements. Pages never carry scripts inline (ADR 0023), so a
 * Component script is its own file named by its hash, `/_wc/js/<hash>.js`, an ES module whose default
 * export is the function WebCraft calls with each Placement's root element.
 *
 * Getting at a module's export needs an `import`, and a page may not hold code, so each Component on a
 * page gets a tiny loader of its own, `/_wc/js/component/<component id>/<hash>.js`: it imports the
 * script's file and hands its exports to WebCraft's runtime. The loader's name holds the script's hash
 * and the Component's id and its text follows from them alone, so it is kept like any hashed file.
 * Loaders are module scripts, which run in the page's order with the deferred ones: the Site script
 * first, then the Component scripts in the order of their first Placement on the page, then the page
 * script.
 *
 * The runtime (`COMPONENT_SCRIPT_RUNTIME`, deferred right before the loaders) finds every Placement
 * root of the Component (`data-wc-component`, a space-separated list when a Component's root is also
 * the root of a Component placed inside it), skips one inside a Hidden placement (`data-wc-hidden`),
 * and calls the function once per root, each call on its own: an error (thrown, or a rejected promise
 * it returns) is reported and the next root still runs. A report is `console.error` and a
 * `webcraft:component-error` event that bubbles from the root, `detail: { component, name, message }`,
 * which Code mode shows against that Placement. In Edit mode (`data-wc-watch` on the runtime's tag) it
 * also calls the function for Placements added to the page later.
 */
import { createHash } from "node:crypto";

import { SCRIPT_PATH } from "./design-system/theme-toggle.ts";
import { textOf, type ValueReader } from "./values.ts";

/** The attribute naming the Components whose script runs on an element: their ids, space-separated. */
export const COMPONENT_ROOT_ATTRIBUTE = "data-wc-component";

/** Where a Component script's loader is, under a scripts path: `component/<component id>/<hash>.js`. */
export const COMPONENT_LOADER_FOLDER = "component/";

const RUNTIME = `(() => {
	const root = window;
	const webcraft = (root.webcraft = root.webcraft || {});
	if (webcraft.componentScript) return;
	const watching = Boolean(document.currentScript && document.currentScript.hasAttribute("data-wc-watch"));
	const ran = new WeakMap();
	const known = new Map();
	const nameOf = (id) => {
		for (const tag of document.querySelectorAll("script[data-wc-component-script]")) {
			if (tag.getAttribute("data-wc-component-script") === id) return tag.getAttribute("data-wc-component-name") || "";
		}
		return "";
	};
	const report = (id, element, error) => {
		console.error(error);
		const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
		element.dispatchEvent(
			new CustomEvent("webcraft:component-error", { bubbles: true, detail: { component: id, name: nameOf(id), message } }),
		);
	};
	const call = (id, run, element) => {
		if (element.closest("[data-wc-hidden]")) return;
		let done = ran.get(element);
		if (!done) ran.set(element, (done = new Set()));
		if (done.has(id)) return;
		done.add(id);
		try {
			const result = run(element);
			if (result && typeof result.then === "function") result.then(undefined, (error) => report(id, element, error));
		} catch (error) {
			report(id, element, error);
		}
	};
	const rootsIn = (id, within) => {
		const selector = '[${COMPONENT_ROOT_ATTRIBUTE}~="' + CSS.escape(id) + '"]';
		const found = [...within.querySelectorAll(selector)];
		if (within.matches && within.matches(selector)) found.unshift(within);
		return found;
	};
	webcraft.componentScript = (id, exports) => {
		const run = exports && exports.default;
		if (typeof run !== "function") {
			report(id, document.documentElement, new TypeError("This Component script exports no function."));
			return;
		}
		known.set(id, run);
		for (const element of rootsIn(id, document)) call(id, run, element);
	};
	if (watching) {
		new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (node.nodeType !== 1) continue;
					for (const [id, run] of known) for (const element of rootsIn(id, node)) call(id, run, element);
				}
			}
		}).observe(document.documentElement, { childList: true, subtree: true });
	}
})();
`;

/** WebCraft's runtime for Component scripts: its file name (`<hash>.js`), address and text. */
export const COMPONENT_SCRIPT_RUNTIME = (() => {
	const name = `${createHash("sha256").update(RUNTIME).digest("hex").slice(0, 16)}.js`;
	return { name, href: `${SCRIPT_PATH}${name}`, text: RUNTIME };
})();

/** A Component script loader's name under a scripts path, from the Component and its script's hash. */
export function componentLoaderName(componentId: string, hash: string): string {
	return `${COMPONENT_LOADER_FOLDER}${componentId}/${hash}.js`;
}

const LOADER_NAME = /^component\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{16})\.js$/;

/** The Component and script hash a loader's name holds; null when the name isn't a loader's. */
export function readComponentLoaderName(name: string): { componentId: string; hash: string } | null {
	const match = LOADER_NAME.exec(name);
	return match ? { componentId: match[1] as string, hash: match[2] as string } : null;
}

/** A loader's text: it imports the script's file, beside the loaders' folder, and hands it to the runtime. */
export function componentLoaderText(componentId: string, hash: string): string {
	return `import * as script from "../../${hash}.js";\nglobalThis.webcraft?.componentScript?.(${JSON.stringify(componentId)}, script);\n`;
}

/**
 * The attributes of a Placement's root when its Component has a script on the page: the Component's
 * id in `data-wc-component`, then each Prop the author marked `exposed`, in order, as `data-<key>` (a
 * capital in the key becomes a hyphen and the letter, so `dataset` reads it back by its key), its
 * value as text. Other Props stay out of the HTML. A Prop with no value is left out, and so is one
 * whose name would be WebCraft's own (`data-wc-…`).
 */
export function componentRootAttributes(
	componentId: string,
	props: readonly { key: string; exposed?: boolean }[],
	values: ValueReader,
): [string, string][] {
	const attributes: [string, string][] = [[COMPONENT_ROOT_ATTRIBUTE, componentId]];
	for (const prop of props) {
		if (!prop.exposed) continue;
		const name = `data-${prop.key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
		if (name.startsWith("data-wc-") || !/^data-[a-z][a-z0-9_-]*$/.test(name)) continue;
		const value = values(`props.${prop.key}`);
		if (value === null || value === undefined) continue;
		attributes.push([name, textOf(value)]);
	}
	return attributes;
}

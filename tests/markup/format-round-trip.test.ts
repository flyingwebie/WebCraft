// Format never changes what Template markup means (SPEC 5.1): for every Template markup sample the
// test suite and docs/development.md hold, formatting it and rendering the result gives the same page
// as rendering it as written, and formatting twice gives the same text as formatting once. The pages
// are compared as a browser shows them: white space collapsed, and none beside a block's edges.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
	type ComponentInfo,
	type ElementTree,
	type LoopRun,
	parseTemplateMarkup,
	renderTree,
	type TemplateValue,
} from "@webcraft/renderer";
import { format } from "@webcraft/server/code-format";

const ROOT = new URL("../../", import.meta.url).pathname;

// ---------------------------------------------------------------------------------------------
// The samples: string literals of the test suite and the docs' code that read as Template markup

/** Reads the text of a JavaScript string literal's body (no `${…}`), its escapes resolved. */
function literalText(body: string): string {
	return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/g, (_, written: string) => {
		if (written.startsWith("u{")) return String.fromCodePoint(Number.parseInt(written.slice(2, -1), 16));
		if (written.startsWith("u") && written.length === 5)
			return String.fromCharCode(Number.parseInt(written.slice(1), 16));
		if (written.startsWith("x") && written.length === 3)
			return String.fromCharCode(Number.parseInt(written.slice(1), 16));
		if (written === "\n" || written === "\r\n") return "";
		return { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" }[written] ?? written;
	});
}

/** Every string literal of a source file, skipping comments and template literals with `${…}`. */
function literalsOf(source: string): string[] {
	const found: string[] = [];
	let at = 0;
	while (at < source.length) {
		const char = source[at];
		if (char === "/" && source[at + 1] === "/") {
			at = source.indexOf("\n", at);
			if (at < 0) break;
			continue;
		}
		if (char === "/" && source[at + 1] === "*") {
			at = source.indexOf("*/", at + 2);
			if (at < 0) break;
			at += 2;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			let end = at + 1;
			let interpolated = false;
			while (end < source.length && source[end] !== char) {
				if (source[end] === "\\") end++;
				else if (char === "`" && source[end] === "$" && source[end + 1] === "{") interpolated = true;
				else if (char !== "`" && source[end] === "\n") break;
				end++;
			}
			if (!interpolated && source[end] === char) found.push(literalText(source.slice(at + 1, end)));
			at = end + 1;
			continue;
		}
		at++;
	}
	return found;
}

/** Whether a text reads as Template markup: an element or a value, command or Component in it. */
function looksLikeMarkup(text: string): boolean {
	return /<[A-Za-z][\w-]*[\s/>]/.test(text) || /\{\{[\s\S]*\}\}/.test(text);
}

function testFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules") return [];
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return testFiles(path);
		return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
	});
}

/** The docs' code: fenced blocks and inline code. */
function docsCode(markdown: string): string[] {
	const fenced = [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
	const inline = [...markdown.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? "");
	return [...fenced, ...inline];
}

const candidates = new Map<string, string>();
for (const file of testFiles(join(ROOT, "tests"))) {
	for (const literal of literalsOf(readFileSync(file, "utf8"))) {
		if (looksLikeMarkup(literal) && !candidates.has(literal)) candidates.set(literal, relative(ROOT, file));
	}
}
for (const code of docsCode(readFileSync(join(ROOT, "docs/development.md"), "utf8"))) {
	if (looksLikeMarkup(code) && !candidates.has(code)) candidates.set(code, "docs/development.md");
}

// ---------------------------------------------------------------------------------------------
// Reading a sample as any Site would let it: every Class, Form, Popup, Filter, Loop and Component

/** The Components a sample places, each taking the Props its tags write. */
function componentsOf(markup: string): Map<string, ComponentInfo> {
	const components = new Map<string, ComponentInfo>();
	for (const [, name = "", attributes = ""] of markup.matchAll(/<([A-Z][A-Za-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
		const info = components.get(name) ?? {
			id: `component-${name}`,
			name,
			props: [],
			tree: { version: 1, nodes: [] },
		};
		const keys = new Set(info.props.map((prop) => prop.key));
		for (const [, key = ""] of attributes.matchAll(/([A-Za-z_][\w.:-]*)\s*=/g)) {
			if (!key.startsWith("data-wc-")) keys.add(key);
		}
		components.set(name, {
			...info,
			props: [...keys].map((key) => ({ key, required: false, check: () => undefined })),
		});
	}
	return components;
}

/** The sample read into a tree, ids given in order (so two readings name the same elements alike); null when no Site could take it. */
function read(markup: string): ElementTree | null {
	const components = componentsOf(markup);
	const byId = new Map([...components.values()].map((info) => [info.id, info]));
	const keyed = (key: string) => ({ id: `id-${key}`, key });
	const fromId = (id: string) => ({ id, key: id.replace(/^id-/, "") });
	let next = 0;
	try {
		return parseTemplateMarkup(markup, {
			classNamed: (name) => `class-${name}`,
			classForStyle: (declarations) => ({ id: `style-${declarations}`, name: "style-generated" }),
			components: { named: (name) => components.get(name), byId: (id) => byId.get(id) },
			forms: { keyed, byId: fromId },
			popups: { keyed, byId: fromId },
			filters: {
				named: (name) => ({ id: `filter-${name}`, name, loop: "latest-posts", controls: ["search", "category"] }),
				byId: (id) => ({
					id,
					name: id.replace(/^filter-/, ""),
					loop: "latest-posts",
					controls: ["search", "category"],
				}),
			},
			loops: { byName: () => ({ isKnownValue: () => true }) },
			newId: () => `id${String(next++).padStart(10, "0")}`,
		}).tree;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------
// Rendering, with every value there and then with none (so each branch of a Condition shows)

function render(tree: ElementTree, filled: boolean): string {
	const value = (path: string): TemplateValue => (filled ? `«${path}»` : "");
	const item = (index: number) => ({ read: (path: string): TemplateValue => (filled ? `«${path} ${index}»` : "") });
	const loop = (): LoopRun => (filled ? { items: [item(1), item(2)], total: 2 } : { items: [], total: 0 });
	return renderTree(tree, {
		values: value,
		className: (id) => id,
		outlet: () => "<p>the content</p>",
		themeToggle: () => "<button>theme</button>",
		languageSwitcher: () => "<nav>languages</nav>",
		form: (id) => `<form data-form="${id}"></form>`,
		popup: (id) => `<a href="#${id}">popup</a>`,
		search: () => "<form data-search></form>",
		consentSettings: () => "<button>cookies</button>",
		filter: (node) => `<form data-filter="${JSON.stringify(node)}"></form>`,
		loop,
		component: (componentId, props) => ({
			tree: { version: 1, nodes: [{ type: "text", text: `[${componentId} ${JSON.stringify([...props])}]` }] },
			values: value,
		}),
	});
}

/** Elements a browser lays out as blocks: white space beside their edges never shows. */
const BLOCK = new Set(
	"address article aside blockquote br caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr legend li main menu nav ol p pre search section summary table tbody td tfoot th thead tr ul".split(
		" ",
	),
);

/** A rendered page as a browser shows it: white space collapsed, none at a block's edges, and `<pre>` kept. */
function shown(html: string): string {
	const tokens = html.split(/(<[^>]*>)/).filter(Boolean);
	const out: string[] = [];
	let pre = 0;
	let afterPreOpen = false;
	for (const token of tokens) {
		if (token.startsWith("<")) {
			const name = /^<\/?([a-zA-Z][\w-]*)/.exec(token)?.[1]?.toLowerCase() ?? "";
			if (name === "pre" || name === "textarea") {
				if (token.startsWith("</")) pre--;
				else {
					pre++;
					afterPreOpen = true;
					out.push(token);
					continue;
				}
			}
			out.push(BLOCK.has(name) && pre === 0 ? `${token}\uE000` : token);
			afterPreOpen = false;
			continue;
		}
		if (pre > 0) {
			// A browser drops a line break right after <pre>'s start tag.
			out.push(afterPreOpen ? token.replace(/^\r?\n/, "") : token);
		} else out.push(token.replace(/\s+/g, " "));
		afterPreOpen = false;
	}
	// Block tags are marked; white space beside one, and at the start and end, never shows.
	return out
		.join("")
		.replace(/ ?(<\/?(?:[a-zA-Z][\w-]*)[^>]*>)\uE000 ?/g, "$1")
		.replace(
			/ (<\/?(?:address|article|aside|blockquote|br|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|hr|legend|li|main|menu|nav|ol|p|pre|search|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)[\s>/])/g,
			"$1",
		)
		.trim();
}

// ---------------------------------------------------------------------------------------------

const samples = [...candidates].flatMap(([markup, from]) => {
	const tree = read(markup);
	return tree ? [{ markup, from, tree }] : [];
});

describe("Format keeps what Template markup means", () => {
	test("the suite and the docs hold many Template markup samples, Components and commands among them", () => {
		expect(samples.length).toBeGreaterThan(200);
		expect(samples.some((sample) => /<[A-Z]/.test(sample.markup))).toBe(true);
		expect(samples.some((sample) => sample.markup.includes("{{@loop"))).toBe(true);
		expect(samples.some((sample) => sample.markup.includes("{{@empty}}"))).toBe(true);
		expect(samples.some((sample) => sample.markup.includes("{{@else"))).toBe(true);
		expect(samples.some((sample) => sample.markup.includes("{{@outlet}}"))).toBe(true);
		expect(samples.some((sample) => sample.markup.includes("{{@form"))).toBe(true);
		expect(samples.some((sample) => sample.from === "docs/development.md")).toBe(true);
	});

	test("formatting then rendering gives the same page as rendering the markup as written; twice is once", async () => {
		const failures: string[] = [];
		for (const sample of samples) {
			const formatted = await format(sample.markup, "html");
			const where = `${sample.from}: ${JSON.stringify(sample.markup).slice(0, 160)}`;
			if (!formatted.ok) {
				failures.push(`${where}\n  can't format: ${formatted.reason} on line ${formatted.line}`);
				continue;
			}
			const tree = read(formatted.text);
			if (!tree) {
				failures.push(`${where}\n  the formatted markup doesn't read:\n${formatted.text}`);
				continue;
			}
			for (const filled of [true, false]) {
				const before = shown(render(sample.tree, filled));
				const after = shown(render(tree, filled));
				if (before !== after)
					failures.push(`${where}\n  formatted:\n${formatted.text}\n  page before: ${before}\n  page after:  ${after}`);
			}
			const again = await format(formatted.text, "html");
			if (!again.ok || again.text !== formatted.text || again.changedLines !== 0)
				failures.push(
					`${where}\n  formatting twice changed it:\n${formatted.text}\n---\n${again.ok ? again.text : again.reason}`,
				);
		}
		expect(failures).toEqual([]);
	});
});

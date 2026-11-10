/** Quality warnings over the renderer's resolved output, never save/publish validation. */
import { type DefaultTreeAdapterMap, parse, parseFragment } from "parse5";
import { type BodyCheckKind, vagueText } from "./body/checks.ts";
import { canonicalLanguage } from "./languages.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
export type QualityCheckKind =
	| BodyCheckKind
	| "missingH1"
	| "multipleH1"
	| "missingMain"
	| "multipleMain"
	| "missingLanguage"
	| "emptyButton"
	| "vagueButton";
export type QualityCheck = { check: QualityCheckKind; at: string; detail?: string; componentId?: string };
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
const children = (node: Node): Node[] => ("childNodes" in node ? node.childNodes : []);
const element = (node: Node): node is Element => "tagName" in node;

/** `complete` applies document rules only to a composed page, never a reusable fragment. */
export function renderedChecks(html: string, options: { language: string; complete?: boolean }): QualityCheck[] {
	return renderedCheckReport(html, options).checks;
}

export function renderedCheckReport(
	html: string,
	options: { language: string; complete?: boolean },
): { checks: QualityCheck[]; bodies: string[] } {
	const root = options.complete ? parse(html) : parseFragment(html);
	const checks: QualityCheck[] = [];
	const bodies = new Set<string>();
	const ids = new Map<string, Element>();
	const index = (node: Node) => {
		if (element(node) && attr(node, "id")) ids.set(attr(node, "id") ?? "", node);
		for (const child of children(node)) index(child);
	};
	index(root);
	const text = (node: Node, includeHidden = false): string => {
		if (node.nodeName === "#text" && "value" in node) return node.value;
		if (element(node)) {
			if (!includeHidden && (attr(node, "aria-hidden") === "true" || attr(node, "hidden") !== undefined)) return "";
			if (node.tagName === "img") return attr(node, "alt") ?? "";
		}
		return children(node)
			.map((child) => text(child, includeHidden))
			.join("");
	};
	const labelledBy = (node: Element): string => {
		const labelled = (attr(node, "aria-labelledby") ?? "")
			.split(/\s+/)
			.map((id) => ids.get(id))
			.filter((n): n is Element => !!n)
			.map((label) => text(label, true))
			.join(" ")
			.trim();
		return labelled;
	};
	const name = (node: Element): string => {
		const input =
			node.tagName === "input"
				? (attr(node, "value") ??
					(attr(node, "type") === "submit" ? "Submit" : attr(node, "type") === "reset" ? "Reset" : ""))
				: undefined;
		return (
			labelledBy(node) ||
			attr(node, "aria-label")?.trim() ||
			input?.trim() ||
			text(node).trim() ||
			attr(node, "title")?.trim() ||
			""
		);
	};
	let h1 = 0;
	let main = 0;
	let previous = options.complete ? 1 : 0;
	const visit = (node: Node, path: string, body = false, component?: string, inheritedLanguage = options.language) => {
		if (!element(node)) {
			children(node).forEach((child, i) => {
				visit(child, `${path}.${i}`, body, component, inheritedLanguage);
			});
			return;
		}
		if (
			attr(node, "hidden") !== undefined ||
			attr(node, "aria-hidden") === "true" ||
			["script", "style"].includes(node.tagName)
		)
			return;
		const code = attr(node, "data-wc-code");
		const at = attr(node, "data-wc-check-at") ?? code ?? path;
		const componentBoundary = attr(node, "data-wc-check-component");
		const componentId = componentBoundary ?? component;
		const raise = (check: QualityCheckKind, detail?: string) =>
			checks.push({ check, at, ...(componentId ? { componentId } : {}), ...(detail === undefined ? {} : { detail }) });
		const hint = attr(node, "data-wc-check");
		if (hint) {
			raise(hint as QualityCheckKind, attr(node, "data-wc-check-detail"));
			return;
		}
		if (node.tagName === "template") return;
		const bodyPath = attr(node, "data-wc-body");
		if (bodyPath) bodies.add(bodyPath);
		const inBody = bodyPath !== undefined || (body && !code && componentBoundary === undefined);
		const level = /^h([1-6])$/.exec(node.tagName)?.[1];
		if (level) {
			const n = Number(level);
			if (n === 1 && ++h1 === 2) raise("multipleH1");
			if (previous > 0 && n > previous + 1) raise("skippedHeading", `H${previous} → H${n}`);
			previous = n;
		}
		if ((node.tagName === "main" || attr(node, "role") === "main") && ++main === 2) raise("multipleMain");
		const lang = attr(node, "lang");
		if ((lang !== undefined || (options.complete && node.tagName === "html")) && !canonicalLanguage(lang ?? ""))
			raise("missingLanguage");
		const language = lang && canonicalLanguage(lang) ? lang : inheritedLanguage;
		if (!inBody) {
			if (node.tagName === "img" && !attr(node, "alt")?.trim() && attr(node, "data-wc-decorative") !== "true")
				raise("missingAlt");
			if (
				((node.tagName === "a" && attr(node, "href") !== undefined) || attr(node, "role") === "link") &&
				vagueText(name(node), language)
			)
				raise("vagueLink", name(node));
			if (
				node.tagName === "button" ||
				attr(node, "role") === "button" ||
				(node.tagName === "input" && ["button", "submit", "reset"].includes(attr(node, "type") ?? ""))
			) {
				const label = name(node);
				if (!label) raise("emptyButton");
				else if (vagueText(label, language)) raise("vagueButton", label);
			}
			if (node.tagName === "table" && attr(node, "role") !== "presentation") {
				const hasHeader = (n: Node): boolean => (element(n) && n.tagName === "th") || children(n).some(hasHeader);
				if (!hasHeader(node)) raise("tableHeader");
			}
			if (
				["video", "iframe"].includes(node.tagName) &&
				!attr(node, "title")?.trim() &&
				!attr(node, "aria-label")?.trim() &&
				!labelledBy(node)
			)
				raise("untitledVideo");
		}
		children(node).forEach((child, i) => {
			visit(child, `${at}.${i}`, inBody, componentId, language);
		});
	};
	visit(root, "page");
	if (options.complete && h1 === 0) checks.push({ check: "missingH1", at: "content" });
	if (options.complete && main === 0) checks.push({ check: "missingMain", at: "site" });
	return {
		checks: checks.filter(
			(check, i) =>
				checks.findIndex(
					(other) =>
						other.check === check.check &&
						other.at === check.at &&
						other.detail === check.detail &&
						other.componentId === check.componentId,
				) === i,
		),
		bodies: [...bodies],
	};
}

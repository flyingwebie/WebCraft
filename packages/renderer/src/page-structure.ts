/**
 * How a page is put together: the Site template around it holds the page's one <main>, at the top
 * level of the page, and inside it the one `{{@outlet}}` where the page's content goes (an Entry
 * through its Entry template, a Page's layout, the 404 page). So every page has exactly one main
 * landmark, the skip link always has somewhere to go, and what goes in the outlet never holds a
 * <main> or an outlet of its own.
 */
import { commandForNode } from "./commands.ts";
import { childListsOf, type TreeCheck, type TreeNode } from "./tree.ts";

/** Why page content (an Entry template, later Archive templates and Components) can't hold the outlet. */
export const OUTLET_ONLY_IN_SITE_TEMPLATE =
	"{{@outlet}} belongs to the Site template: it is where each page's content goes, around this one.";

/** Refuses the commands only the Site template holds, for page content. */
export function refuseSiteTemplateCommands(name: string): string | undefined {
	return name === "outlet" ? OUTLET_ONLY_IN_SITE_TEMPLATE : undefined;
}

/** Attributes WebCraft writes on <main> itself (`PAGE_HOOKS`), so a Site template leaves them out. */
const MAIN_ATTRIBUTES = new Set(["id", "tabindex"]);

/**
 * What the Site template must hold: exactly one <main>, with only <div> elements around it (so it
 * stays a landmark of its own) and no Template command (so every page has it), and inside it exactly
 * one `{{@outlet}}`, not inside a Template command either (so every page shows its content once).
 */
export const checkSiteTemplate: TreeCheck = (nodes, problem) => {
	let mains = 0;
	let outlets = 0;

	const visit = (list: readonly TreeNode[], ancestors: readonly TreeNode[]) => {
		for (const node of list) {
			if (node.type === "element" && node.tag === "main") {
				mains++;
				const around = ancestors.find((ancestor) => !(ancestor.type === "element" && ancestor.tag === "div"));
				if (mains > 1) {
					problem(node, "A page has one <main>: this is a second one.");
				} else if (around?.type === "element") {
					problem(
						node,
						`<main> can't go inside ${nameOf(around)}: only <div> elements may be around it, so it stays a landmark of its own.`,
					);
				} else if (around) {
					problem(node, `<main> can't go inside ${nameOf(around)}: every page has it.`);
				} else if (node.attributes.some((attribute) => MAIN_ATTRIBUTES.has(attribute.name))) {
					problem(node, "WebCraft gives <main> its id and tabindex, for the skip link: leave both out.");
				}
			}
			if (node.type === "outlet") {
				outlets++;
				const main = ancestors.findLastIndex((ancestor) => ancestor.type === "element" && ancestor.tag === "main");
				const command = ancestors.slice(main + 1).find((ancestor) => ancestor.type !== "element");
				if (outlets > 1) {
					problem(node, "The Site template has one {{@outlet}}: this is a second one.");
				} else if (main < 0) {
					problem(node, "{{@outlet}} goes inside <main>: each page's content is its main content.");
				} else if (command) {
					problem(node, `{{@outlet}} can't go inside ${nameOf(command)}: every page shows its content, once.`);
				}
			}
			for (const children of childListsOf(node)) visit(children, [...ancestors, node]);
		}
	};

	visit(nodes, []);
	if (outlets === 0) {
		problem(undefined, "The Site template needs {{@outlet}} inside <main>, where each page's content goes.");
	}
};

/** How a node is named in a problem: `<header>`, `{{@if}}`. */
function nameOf(node: TreeNode): string {
	if (node.type === "element") return `<${node.tag}>`;
	return `{{@${commandForNode(node.type)?.name ?? node.type}}}`;
}

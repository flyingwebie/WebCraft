import { FILTER_HOOKS, FILTER_REGION_MARK } from "@webcraft/renderer";

/**
 * The parts of a rendered page a Filter's script swaps in place (GLOSSARY.md › Filter): its title,
 * each Filter's form and each control shown on its own by its id, and each region of its filtered Loops (`<!--wc-region loop products 1-->`
 * … `<!--/wc-region loop products 1-->`) by name. Only WebCraft writes forms with these classes and
 * comments on a page (Staff's comments are never rendered, every value is escaped, and a Filter's
 * form holds no other form), so reading them from the HTML finds exactly what the renderer wrote.
 */
export type PageParts = {
	title: string;
	filters: { id: string; html: string }[];
	regions: { name: string; html: string }[];
};

export function pageParts(html: string): PageParts {
	const title = decodeText(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "");
	// Each Filter's form, and each of its controls shown on its own (a part ends with its marking comment).
	const filters = [
		...html.matchAll(
			new RegExp(
				`<form class="${FILTER_HOOKS.form}" id="([^"]+)"[\\s\\S]*?</form>|<div class="${FILTER_HOOKS.part}" id="([^"]+)"[\\s\\S]*?<!--/${FILTER_HOOKS.part}--></div>`,
				"g",
			),
		),
	].map(([part = "", form, apart]) => ({ id: form ?? apart ?? "", html: part }));
	const regions: PageParts["regions"] = [];
	const start = new RegExp(`<!--${FILTER_REGION_MARK} ([^>]*?)-->`, "g");
	for (const match of html.matchAll(start)) {
		const [opening = "", name = ""] = match;
		const from = (match.index ?? 0) + opening.length;
		const to = html.indexOf(`<!--/${FILTER_REGION_MARK} ${name}-->`, from);
		if (to >= 0) regions.push({ name, html: html.slice(from, to) });
	}
	return { title, filters, regions };
}

/** Text as the renderer escaped it, read back. */
function decodeText(text: string): string {
	return text
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&");
}

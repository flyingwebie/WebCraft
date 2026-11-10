import type { Connection } from "../remote/connection.ts";
import { call } from "../remote/run.ts";
import { indented } from "./css-blocks.ts";

/**
 * A Site's Structure as `webcraft structure pull` writes it: one file per Template, Component (its
 * markup and its Props), Post Type, Loop, Form and Filter, and the Design system's tokens, Classes,
 * base styles and Site CSS. Each item knows the files that hold it and what saving it needs.
 */
export type StructureItem =
	| {
			kind: "template";
			template: "site" | "search" | "entry" | "archive";
			/** Its Post Type, for an Entry or Archive template. */
			postType: { id: string; key: string } | null;
			path: string;
			/** Its Draft's version (null while it has none), for `basedOn`. */
			version: string | null;
	  }
	| { kind: "component"; name: string; id: string; markup: string; props: string; version: string }
	| { kind: "designSystem"; paths: string[] }
	| { kind: "postType"; key: string; id: string; path: string }
	| { kind: "loop"; name: string; id: string; path: string }
	| { kind: "form"; key: string; id: string; name: string; path: string }
	| { kind: "filter"; name: string; id: string; path: string };

/** What the Install holds now: every file as pull would write it, and the items they belong to. */
export type StructureState = {
	site: { id: string; name: string };
	files: Map<string, string>;
	items: StructureItem[];
	/** The Design system's Draft as read, for saving it again (Class ids, breakpoints). */
	designSystem: DesignSystemDraft;
};

export type DesignSystemDraft = {
	tokens: { breakpoints: { id: string; name: string }[] } & Record<string, unknown>;
	classes: {
		id: string;
		name: string;
		generated: boolean;
		styles: string;
		breakpoints: Record<string, string>;
		css: string;
	}[];
	baseStyles: Record<string, string>;
	customCss: string;
	darkMode: boolean;
};

/** The folders `structure` reads and writes, beside the manifest. */
export const STRUCTURE_FOLDERS = [
	"templates",
	"components",
	"design-system",
	"post-types",
	"loops",
	"forms",
	"filters",
];

/** Names that make safe file names; anything else is left out of the files, with a warning. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** JSON as the files hold it: tabs, keys in the order the Install gave them, a final newline. */
export function jsonFile(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/** A Template's or Component's markup as its file holds it: the markup, then a newline. */
export function markupFile(markup: string): string {
	return `${markup}\n`;
}

/** The markup a file holds: without the final newline the file added. */
export function markupOf(file: string): string {
	return file.endsWith("\n") ? file.slice(0, -1) : file;
}

/** What a Post Type's file holds: everything a save of it takes, its key being the file's name. */
export function postTypeFile(postType: Record<string, unknown>): Record<string, unknown> {
	const { name, urlPattern, fields, searchable, searchedFields, seo, summaryField, sitemap, revisions } = postType;
	return { name, urlPattern, fields, searchable, searchedFields, seo, summaryField, sitemap, revisions };
}

type Draft = Record<string, unknown>;

/** Reads the Site's whole Structure from the Install, as the person may read it (Staff: `structure.edit`). */
export async function readStructure(
	connection: Connection,
	siteId: string,
	warn: (text: string) => void,
): Promise<StructureState> {
	const api = (path: string, input: Record<string, unknown>) =>
		call(connection, { path, files: [] }, { siteId, ...input }) as Promise<Record<string, unknown>>;
	const files = new Map<string, string>();
	const items: StructureItem[] = [];
	const { site } = (await api("sites/get", {})) as { site: { id: string; name: string } };

	const { postTypes } = (await api("postTypes/list", {})) as { postTypes: (Draft & { id: string; key: string })[] };
	const keys = new Map(postTypes.map((postType) => [postType.id, postType.key]));
	for (const postType of postTypes) {
		if (!SAFE_NAME.test(postType.key)) {
			warn(`The Post Type ${postType.key} has a key no file can be named after: it is left out.`);
			continue;
		}
		const path = `post-types/${postType.key}.json`;
		files.set(path, jsonFile(postTypeFile(postType)));
		items.push({ kind: "postType", key: postType.key, id: postType.id, path });
	}

	const { templates } = (await api("templates/list", {})) as {
		templates: {
			kind: "site" | "search" | "entry" | "archive";
			postType: { id: string } | null;
			unavailable: string | null;
		}[];
	};
	for (const listing of templates) {
		if (listing.unavailable) continue;
		const postType = listing.postType ? { id: listing.postType.id, key: keys.get(listing.postType.id) ?? "" } : null;
		if (postType && !SAFE_NAME.test(postType.key)) continue;
		const read =
			listing.kind === "site"
				? await api("templates/getSiteTemplateMarkup", {})
				: listing.kind === "search"
					? await api("templates/getSearchTemplateMarkup", {})
					: listing.kind === "entry"
						? await api("templates/getEntryTemplateMarkup", { postTypeId: postType?.id })
						: await api("templates/getArchiveTemplateMarkup", { postTypeId: postType?.id });
		const { markup, version } = read as { markup: { draft: string } | null; version: string | null };
		const path = postType ? `templates/${listing.kind}/${postType.key}.wc.html` : `templates/${listing.kind}.wc.html`;
		if (markup) files.set(path, markupFile(markup.draft));
		items.push({ kind: "template", template: listing.kind, postType, path, version });
	}

	const { components } = (await api("components/list", {})) as {
		components: { id: string; name: string; module: string | null }[];
	};
	for (const component of components) {
		// A Module's Components belong to the Module: they can't be changed.
		if (component.module || !SAFE_NAME.test(component.name)) continue;
		const read = (await api("components/getMarkup", { componentId: component.id })) as {
			component: { draft: { props: unknown[] } };
			markup: { draft: string };
			version: string;
		};
		const markup = `components/${component.name}.wc.html`;
		const props = `components/${component.name}.json`;
		files.set(markup, markupFile(read.markup.draft));
		files.set(props, jsonFile({ props: read.component.draft.props }));
		items.push({ kind: "component", name: component.name, id: component.id, markup, props, version: read.version });
	}

	const { designSystem } = (await api("designSystem/get", {})) as { designSystem: { draft: DesignSystemDraft } };
	const { tokens } = (await api("designSystem/exportTokens", {})) as { tokens: unknown };
	const draft = designSystem.draft;
	const designFiles = designSystemFiles(draft, tokens, warn);
	for (const [path, content] of designFiles) files.set(path, content);
	items.push({ kind: "designSystem", paths: [...designFiles.keys()] });

	const { loops } = (await api("loops/list", {})) as { loops: { id: string; name: string; draft: Draft }[] };
	for (const loop of loops) {
		if (!SAFE_NAME.test(loop.name)) continue;
		const path = `loops/${loop.name}.json`;
		const { source, query, fields } = loop.draft;
		files.set(path, jsonFile({ source, query, fields }));
		items.push({ kind: "loop", name: loop.name, id: loop.id, path });
	}

	const { forms } = (await api("forms/list", {})) as {
		forms: { id: string; key: string; name: string; draft: Draft }[];
	};
	for (const form of forms) {
		if (!SAFE_NAME.test(form.key)) continue;
		const path = `forms/${form.key}.json`;
		const { fields, submitLabel, success, spam } = form.draft;
		files.set(path, jsonFile({ name: form.name, fields, submitLabel, success, spam }));
		items.push({ kind: "form", key: form.key, id: form.id, name: form.name, path });
	}

	const { filters } = (await api("filters/list", {})) as {
		filters: { id: string; name: string; loop: string; draft: Draft }[];
	};
	for (const filter of filters) {
		if (!SAFE_NAME.test(filter.name)) continue;
		const path = `filters/${filter.name}.json`;
		const { mode, layout, phone, label, applyLabel, controls } = filter.draft;
		files.set(path, jsonFile({ loop: filter.loop, mode, layout, phone, label, applyLabel, controls }));
		items.push({ kind: "filter", name: filter.name, id: filter.id, path });
	}

	return { site: { id: site.id, name: site.name }, files, items, designSystem: draft };
}

/**
 * The Design system as files: its tokens (DTCG), one CSS file per Class (its styles for every width,
 * then each breakpoint's as `@media (--<breakpoint>)`, then its own CSS as a second block), the base
 * styles and the Site CSS, and `design-system.json` (dark mode, and the Classes' order).
 */
export function designSystemFiles(
	draft: DesignSystemDraft,
	tokens: unknown,
	warn: (text: string) => void,
): Map<string, string> {
	const files = new Map<string, string>();
	files.set("design-system/tokens.json", jsonFile(tokens));
	const breakpointNames = new Map(draft.tokens.breakpoints.map((breakpoint) => [breakpoint.id, breakpoint.name]));
	const order: string[] = [];
	for (const each of draft.classes) {
		if (!SAFE_NAME.test(each.name)) {
			warn(`The Class ${each.name} has a name no file can be named after: it is left out.`);
			continue;
		}
		order.push(each.name);
		files.set(`design-system/classes/${each.name}.css`, classFile(each, breakpointNames));
	}
	files.set(
		"design-system/base.css",
		Object.entries(draft.baseStyles)
			.map(([target, css]) => `${target} {\n${indented(css, "")}\n}\n`)
			.join("\n"),
	);
	files.set("design-system/site.css", draft.customCss);
	files.set("design-system/design-system.json", jsonFile({ darkMode: draft.darkMode, classes: order }));
	return files;
}

function classFile(each: DesignSystemDraft["classes"][number], breakpointNames: Map<string, string>): string {
	const selector = `.${each.name}`;
	const parts = [`${selector} {\n${indented(each.styles, "")}\n}\n`];
	for (const [id, css] of Object.entries(each.breakpoints)) {
		const name = breakpointNames.get(id) ?? id;
		parts.push(`@media (--${name}) {\n\t${selector} {\n${indented(css, "\t")}\n\t}\n}\n`);
	}
	if (each.css.trim() !== "") parts.push(`/* Its own CSS: */\n${selector} {\n${indented(each.css, "")}\n}\n`);
	return parts.join("\n");
}

// What the Co-editing tests share: a Site in English and French with a Recipes Post Type, its Staff
// member Ada Staff, the Editor Eve Editor and the Author Al Author, and an Entry they all edit.
import type { DocumentJson } from "@webcraft/core";

import type { TestBrowser, TestInstall } from "../harness/index.ts";

export type CoEditingSite = {
	workspaceId: string;
	siteId: string;
	postTypeId: string;
	staff: TestBrowser;
	editor: TestBrowser;
	author: TestBrowser;
	staffId: string;
	editorId: string;
	authorId: string;
	/** An Entry titled "Fresh bread", with a summary, in English. */
	entryId: string;
};

let sites = 0;

/**
 * A new Workspace and Site in English (the Default language) and French, with a Recipes Post Type
 * (`/recipes/{slug}`) holding a Summary (text), Minutes (a whole number), an Address Group (City) and
 * Steps (a Repeater of Text), and one Entry, "Fresh bread".
 */
export async function coEditingSite(install: TestInstall): Promise<CoEditingSite> {
	const n = ++sites;
	const workspaceId = (await install.createWorkspace(`Co-editing ${n}`)).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `co-editing-${n}` })).id;
	const staff = await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	const editor = await install.createMember({ workspaceId, role: "editor", name: "Eve Editor" });
	const author = await install.createMember({ workspaceId, role: "author", name: "Al Author" });
	await staff.browser.api.languages.add({ siteId, code: "fr" });
	const { postType } = await staff.browser.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "minutes", label: "Minutes", type: "number", integer: true },
			{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
			{ key: "steps", label: "Steps", type: "repeater", fields: [{ key: "text", label: "Text", type: "text" }] },
		],
	});
	const { entry } = await staff.browser.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { summary: "Bake it today." },
	});
	return {
		workspaceId,
		siteId,
		postTypeId: postType.id,
		staff: staff.browser,
		editor: editor.browser,
		author: author.browser,
		staffId: staff.personId,
		editorId: editor.personId,
		authorId: author.personId,
		entryId: entry.id,
	};
}

type Values = Record<string, DocumentJson>;

/** The values an Entry's shared document holds, by key. */
export function valuesIn(draft: DocumentJson): Values {
	const values = (draft as { values?: Values } | null)?.values;
	return values ?? {};
}

/** A leaf value in one language, as the shared document holds it. */
export function valueIn(draft: DocumentJson, key: string, language = "en"): DocumentJson | undefined {
	return (valuesIn(draft)[key] as Record<string, DocumentJson> | undefined)?.[language];
}

/** The Draft with one leaf value set in a language (null removes it), as an editor changes it. */
export function withValue(draft: DocumentJson, key: string, value: DocumentJson, language = "en"): DocumentJson {
	const values = valuesIn(draft);
	const leaf = { ...((values[key] as Record<string, DocumentJson> | undefined) ?? {}) };
	if (value === null) delete leaf[language];
	else leaf[language] = value;
	return { ...(draft as Record<string, DocumentJson>), values: { ...values, [key]: leaf } };
}

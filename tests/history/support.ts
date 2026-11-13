// What the history tests share: a Site with a Blog Post Type in English and French, Staff, an Editor
// and an Author, each with a name the history shows.
import type { TestBrowser, TestInstall } from "../harness/index.ts";

export type HistorySite = {
	workspaceId: string;
	siteId: string;
	postTypeId: string;
	staff: TestBrowser;
	editor: TestBrowser;
	author: TestBrowser;
	staffId: string;
	editorId: string;
	authorId: string;
};

let sites = 0;

/**
 * A new Workspace and Site in English (the Default language) and French, with a Blog Post Type
 * (`/blog/{slug}`) holding a Summary (text), Featured (true/false), Body, Ingredients (a Repeater) and
 * Topic (a select) Field, its Staff member Ada Staff, the Editor Eve Editor and the Author Al Author.
 */
export async function historySite(install: TestInstall): Promise<HistorySite> {
	const n = ++sites;
	const workspaceId = (await install.createWorkspace(`History ${n}`)).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `history-${n}` })).id;
	const staff = await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" });
	const editor = await install.createMember({ workspaceId, role: "editor", name: "Eve Editor" });
	const author = await install.createMember({ workspaceId, role: "author", name: "Al Author" });
	await staff.browser.api.languages.add({ siteId, code: "fr" });
	const { postType } = await staff.browser.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "featured", label: "Featured", type: "boolean" },
			{ key: "body", label: "Body", type: "body" },
			{
				key: "ingredients",
				label: "Ingredients",
				type: "repeater",
				fields: [{ key: "name", label: "Name", type: "text" }],
			},
			{
				key: "topic",
				label: "Topic",
				type: "select",
				options: [
					{ value: "bread", label: "Bread" },
					{ value: "cakes", label: "Cakes" },
				],
			},
		],
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
	};
}

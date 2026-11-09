import { taggedTranslation } from "../harness/fake-ai.ts";
import type { TestBrowser, TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

export const AI_KEY = "sk-translation-test-key-0123456789";

export type TranslatedSite = {
	workspaceId: string;
	siteId: string;
	postTypeId: string;
	origin: string;
	staff: TestBrowser;
	owner: TestBrowser;
	editor: TestBrowser;
	author: TestBrowser;
};

let made = 0;

/**
 * A Site in English with other languages in the modes given, a blog Post Type with every kind of
 * translatable value (text, rich text, a body, a link) and a shared number, an Entry template showing
 * them, the Workspace's own AI key, and the fake provider translating by tagging the language
 * (`[it] Fresh bread`).
 */
export async function translatedSite(
	install: TestInstall,
	modes: Record<string, "automatic" | "review" | "manual">,
): Promise<TranslatedSite> {
	const slug = `translated-${++made}`;
	const workspaceId = (await install.createWorkspace(`Acme ${made}`)).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	// Visitors see what is published on the Site's live domain (the Staging address shows Drafts).
	const origin = await goLive(install, siteId);
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	const editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const author = (await install.createMember({ workspaceId, role: "author" })).browser;
	for (const [code, mode] of Object.entries(modes)) {
		await staff.api.languages.add({ siteId, code });
		await owner.api.translations.setMode({ siteId, language: code, mode });
	}
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "body", label: "Body", type: "body" },
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "cta", label: "Call to action", type: "link" },
			{ key: "price", label: "Price", type: "number" },
		],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			"<article><h1>{{ title }}</h1><p>{{ summary }}</p><div>{{ intro }}</div>{{ body }}<p>{{ price }}</p></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	await owner.api.aiKeys.setOwn({ workspaceId, provider: "openai", model: "gpt-5-mini", endpoint: null, key: AI_KEY });
	install.ai.translateWith(taggedTranslation);
	return {
		workspaceId,
		siteId,
		postTypeId: postType.id,
		origin,
		staff,
		owner,
		editor,
		author,
	};
}

/** A blog Entry with a value of every kind, written by the Owner. */
export async function freshBread(site: TranslatedSite, title = "Fresh bread"): Promise<string> {
	const { entry } = await site.owner.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title,
		fields: {
			summary: "Crusty sourdough",
			intro: '<p>Baked <strong>every</strong> morning, see <a href="https://acme.example/menu">the menu</a>.</p>',
			body: [
				{ id: "p1", type: "paragraph", text: "Our loaves rise overnight." },
				{ id: "p2", type: "paragraph", text: [{ text: "Bake at " }, { text: "220 °C", marks: ["bold"] }] },
			],
			cta: { url: "https://acme.example/order", text: "Order now" },
			price: 4,
		},
	});
	return entry.id;
}

/** A page of the Site, as a visitor gets it: its status and its `<article>`. */
export async function visit(install: TestInstall, site: TranslatedSite, path: string) {
	const response = await install.request(`${site.origin}${path}`);
	const html = await response.text();
	return { status: response.status, article: /<article>(.*?)<\/article>/s.exec(html)?.[1] ?? "" };
}

/** The translation requests sent into one language. */
export function requestsInto(install: TestInstall, language: string) {
	return install.ai
		.translations()
		.filter((request) => request.purpose === "translation" && request.to.code === language);
}

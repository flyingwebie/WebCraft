// SEO settings: each Post Type sets what its Entries' SEO fields fall back to and its Schema type
// (Structure, Staff only); each Site sets its name in titles, the separator, its default social
// image and its organisation (a Site setting: Staff only, applied at once and logged).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { titleIn } from "../harness/seo.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(): Promise<{ siteId: string; origin: string }> {
	const slug = `seo-settings-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	return { siteId, origin: `https://${slug}.live.test` };
}

const FIELDS = [
	{ key: "body", label: "Body", type: "body" },
	{ key: "summary", label: "Summary", type: "richText" },
	{ key: "cover", label: "Cover", type: "media" },
	{ key: "price", label: "Price", type: "number" },
	{
		key: "faqs",
		label: "FAQs",
		type: "repeater",
		fields: [
			{ key: "question", label: "Question", type: "text" },
			{ key: "answer", label: "Answer", type: "text" },
		],
	},
	{ key: "notes", label: "Notes", type: "repeater", fields: [{ key: "text", label: "Text", type: "text" }] },
] as const;

describe("a Post Type's SEO settings", () => {
	test("start from WebCraft's defaults: the title pattern, the body's start, the first media Field, a Web page", async () => {
		const { siteId } = await newSite();
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Products",
			urlPattern: "/products/{slug}",
			fields: [...FIELDS] as never,
		});

		expect(postType.seo).toEqual({
			titlePattern: "{title} {separator} {site}",
			descriptionField: null,
			imageField: "cover",
			schema: {
				type: "webPage",
				properties: {
					name: "title",
					description: "seo.description",
					image: "seo.image",
					datePublished: "publishedAt",
					dateModified: "lastPublishedAt",
				},
			},
		});
	});

	test("each part given replaces that part, and a Field that goes leaves its place empty", async () => {
		const { siteId } = await newSite();
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Products",
			urlPattern: "/products/{slug}",
			fields: [...FIELDS] as never,
		});

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			seo: { titlePattern: "{title} | {postType} | {site}", descriptionField: "summary" },
		});
		expect(changed.seo.titlePattern).toBe("{title} | {postType} | {site}");
		expect(changed.seo.descriptionField).toBe("summary");
		expect(changed.seo.imageField).toBe("cover");

		const { postType: without } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: FIELDS.filter((field) => field.key !== "summary") as never,
		});
		expect(without.seo.descriptionField).toBeNull();
		expect(without.seo.titlePattern).toBe("{title} | {postType} | {site}");
	});

	test("a wrong part is refused where it is, with a rule the admin words", async () => {
		const { siteId } = await newSite();
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Products",
			urlPattern: "/products/{slug}",
			fields: [...FIELDS] as never,
		});
		const refused = (seo: Record<string, unknown>) =>
			staff.api.postTypes.update({ siteId, postTypeId: postType.id, seo }).catch((error: unknown) => error);

		expect(await refused({ titlePattern: "{title} · {sitename}" })).toMatchObject({
			code: "POST_TYPE_INVALID",
			data: { problems: [{ at: "seo.titlePattern", rule: "seoTitleToken", params: { token: "{sitename}" } }] },
		});
		expect(await refused({ titlePattern: " " })).toMatchObject({
			data: { problems: [{ at: "seo.titlePattern", rule: "seoTitlePatternLength" }] },
		});
		expect(await refused({ descriptionField: "price" })).toMatchObject({
			data: { problems: [{ at: "seo.descriptionField", rule: "seoDescriptionField" }] },
		});
		expect(await refused({ imageField: "summary" })).toMatchObject({
			data: { problems: [{ at: "seo.imageField", rule: "seoImageField" }] },
		});
		expect(await refused({ schema: { type: "spaceship" } })).toMatchObject({
			data: { problems: [{ at: "seo.schema.type", rule: "schemaTypeUnknown" }] },
		});
		expect(await refused({ schema: { type: "product", properties: { "offers.price": "summary" } } })).toMatchObject({
			data: { problems: [{ at: "seo.schema.properties.offers.price", rule: "schemaSource" }] },
		});
		expect(await refused({ schema: { type: "product", properties: { colour: "summary" } } })).toMatchObject({
			data: { problems: [{ at: "seo.schema.properties.colour", rule: "schemaPropertyUnknown" }] },
		});
		expect(
			await refused({ schema: { type: "faqPage", properties: { question: "faqs.question", answer: "notes.text" } } }),
		).toMatchObject({ data: { problems: [{ at: "seo.schema.properties.answer", rule: "schemaFaqRepeater" }] } });
	});

	test("only Staff change them", async () => {
		const { siteId } = await newSite();
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Posts", urlPattern: "/posts/{slug}" });

		await expect(
			owner.api.postTypes.update({ siteId, postTypeId: postType.id, seo: { titlePattern: "{title}" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("a Site's SEO settings", () => {
	test("start from the defaults, and everyone who sees the Site reads them", async () => {
		const { siteId } = await newSite();

		expect((await editor.api.seoSettings.get({ siteId })).settings).toEqual({
			siteName: null,
			separator: "·",
			defaultImage: null,
			organization: {
				kind: "organization",
				name: null,
				logo: null,
				sameAs: [],
				telephone: null,
				email: null,
				address: null,
			},
			aiCrawlers: "allowAll",
			robotsLines: "",
		});
	});

	test("Staff change them: they apply to titles at once and are logged", async () => {
		const { siteId, origin } = await newSite();
		const { postTypes } = await staff.api.postTypes.list({ siteId });
		const pagesId = postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "";
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: pagesId, title: "About" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		expect(titleIn(await (await install.request(`${origin}/about`)).text())).toBe("About · Acme Bakery");

		const { settings } = await staff.api.seoSettings.update({ siteId, siteName: "Acme", separator: "|" });

		expect(settings).toMatchObject({ siteName: "Acme", separator: "|" });
		expect(titleIn(await (await install.request(`${origin}/about`)).text())).toBe("About | Acme");
		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((logged) => logged.action === "seoSettings.change")).toMatchObject({
			siteId,
			details: { changed: ["siteName", "separator"] },
		});
		await expect(owner.api.seoSettings.update({ siteId, separator: "-" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("wrong settings are refused where they are", async () => {
		const { siteId } = await newSite();
		const refused = (change: Record<string, unknown>) =>
			staff.api.seoSettings.update({ siteId, ...change }).catch((error: unknown) => error);

		expect(await refused({ separator: "{x}" })).toMatchObject({
			code: "SEO_SETTINGS_INVALID",
			data: { problems: [{ at: "separator", rule: "seoSeparator" }] },
		});
		expect(await refused({ defaultImage: "8f4c1a0e-2b3d-4c5e-8f60-718293a4b5c6" })).toMatchObject({
			data: { problems: [{ at: "defaultImage", rule: "seoImage" }] },
		});
		expect(await refused({ organization: { sameAs: ["http://insecure.example"] } })).toMatchObject({
			data: { problems: [{ at: "organization.sameAs[0]", rule: "seoSameAs" }] },
		});
		expect(await refused({ organization: { telephone: "phone" } })).toMatchObject({
			data: { problems: [{ at: "organization.telephone", rule: "seoGlobal" }] },
		});
	});

	test("the default image is a Media use: Used in names it, and it stops showing once in the Trash", async () => {
		const { siteId } = await newSite();
		const bytes = await photo({ width: 1300, height: 700, format: "jpeg" });
		const { media } = await editor.api.media.upload({ siteId, file: upload(bytes, "shopfront.jpg") });
		await install.drainJobs();
		await staff.api.seoSettings.update({ siteId, defaultImage: media.id });

		const { usedIn } = await editor.api.media.usage({ siteId, mediaId: media.id });
		expect(usedIn).toEqual([{ kind: "seoSettings", settings: ["defaultImage"], versions: ["published"] }]);
		// The warning before it goes to the Trash names it too.
		const asked = await editor.api.media.delete({ siteId, mediaId: media.id });
		expect(asked).toMatchObject({ trashed: false, usedIn: [{ kind: "seoSettings" }] });
	});
});

describe("Entries' social images", () => {
	test("Used in names the Entry whose SEO fields use a file", async () => {
		const { siteId } = await newSite();
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Posts", urlPattern: "/posts/{slug}" });
		const bytes = await photo({ width: 800, height: 600, format: "jpeg" });
		const { media } = await editor.api.media.upload({ siteId, file: upload(bytes, "crumb.jpg") });
		await install.drainJobs();
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Crumb",
			seo: { image: media.id },
		});

		const { usedIn } = await editor.api.media.usage({ siteId, mediaId: media.id });

		expect(usedIn).toEqual([
			{
				kind: "entry",
				id: entry.id,
				title: "Crumb",
				postType: { id: postType.id, name: "Posts" },
				versions: ["draft"],
				fields: ["seo"],
			},
		]);
	});
});

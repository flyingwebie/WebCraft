// Media images on Site pages: a media Field, or a fixed `media:<id>` image in a Template, renders as
// <picture> with AVIF and WebP srcsets, generated sizes, width, height and lazy loading, and the
// first image in <main> loads eagerly with high priority. The original is served until the worker
// has made the variants.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";
import { element, text, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let postTypeId: string;

type MediaView = Awaited<ReturnType<TestBrowser["api"]["media"]["get"]>>["media"];

/** A URL on the Site's Staging address. */
const onSite = (path: string) => `https://bakery.live.test${path}`;

async function uploadImage(name: string, width: number, height: number, alt?: string): Promise<MediaView> {
	const { media } = await editor.api.media.upload({ siteId, file: upload(await photo({ width, height }), name) });
	if (alt) await editor.api.media.update({ siteId, mediaId: media.id, alt });
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await editor.api.media.get({ siteId, mediaId: media.id })).media;
}

/** The <main> of a published page. */
async function mainOf(path: string): Promise<string> {
	const response = await install.request(onSite(path));
	expect(response.status).toBe(200);
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(await expectSafePage(response))?.[1] ?? "";
}

/** The <picture> WebCraft writes for a Media image, as the API describes its files. */
function picture(media: MediaView, img: string): string {
	const srcset = (format: string) =>
		media.variants
			.filter((variant) => variant.format === format)
			.sort((a, b) => a.width - b.width)
			.map((variant) => `${variant.url} ${variant.width}w`)
			.join(", ");
	const sizes = `(min-width: ${media.width}px) ${media.width}px, 100vw`;
	return [
		"<picture>",
		`<source type="image/avif" srcset="${srcset("avif")}" sizes="${sizes}">`,
		`<source type="image/webp" srcset="${srcset("webp")}" sizes="${sizes}">`,
		img,
		"</picture>",
	].join("");
}

async function publishEntry(title: string, fields: Record<string, string | null>) {
	const { entry } = await editor.api.entries.create({ siteId, postTypeId, title, fields });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return entry;
}

let hero: MediaView;
let badge: MediaView;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;

	hero = await uploadImage("sourdough.jpg", 1000, 600, "A round sourdough loaf");
	badge = await uploadImage("badge.jpg", 700, 350, "Award badge");

	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Products",
		urlPattern: "/products/{slug}",
		fields: [
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "leaflet", label: "Leaflet", type: "media", translatable: false },
		],
	});
	postTypeId = postType.id;
	const { template } = await staff.api.templates.saveEntryTemplate({
		siteId,
		postTypeId,
		tree: tree(
			element("article", [
				element("h1", [value("title")]),
				element("img", [], { src: [value("photo")] }),
				element("img", [], { src: `media:${badge.id}`, alt: "" }),
				element("a", [text("Leaflet")], { href: [value("leaflet")] }),
			]),
		),
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
});

afterAll(async () => {
	await install.close();
});

describe("Media images on a page", () => {
	test("render as <picture>; the first in <main> is eager with high priority, the rest lazy", async () => {
		await publishEntry("Sourdough loaf", { photo: hero.id });

		expect(await mainOf("/products/sourdough-loaf")).toBe(
			[
				"<article><h1>Sourdough loaf</h1>",
				picture(
					hero,
					`<img src="${hero.url}" alt="A round sourdough loaf" width="1000" height="600" loading="eager" fetchpriority="high">`,
				),
				// A fixed image with an empty alt in the Template is Decorative.
				picture(badge, `<img src="${badge.url}" alt="" width="700" height="350" loading="lazy">`),
				'<a href="">Leaflet</a></article>',
			].join(""),
		);
	});

	test("a media: link points to the file itself", async () => {
		const leaflet = (await editor.api.media.upload({ siteId, file: upload(pdf(), "leaflet.pdf") })).media;
		await publishEntry("Rye bread", { photo: null, leaflet: leaflet.id });

		const main = await mainOf("/products/rye-bread");
		expect(main).toContain(`<a href="${leaflet.url}">Leaflet</a>`);
		// With no photo, the Field's image renders nothing; the badge is now the first image in <main>.
		expect(main).toContain(
			`<img src="${badge.url}" alt="" width="700" height="350" loading="eager" fetchpriority="high">`,
		);
	});

	test("a Template's own attributes stay: alt, sizes, width and height, loading", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Pages", urlPattern: "/{slug}" });
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(
				element("img", [], {
					src: `media:${hero.id}`,
					alt: "Our loaf",
					sizes: "50vw",
					width: "500",
					loading: "eager",
					title: "Loaf",
				}),
			),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "About" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		const main = await mainOf("/about");
		expect(main).toContain('sizes="50vw"');
		expect(main).toContain(
			`<img src="${hero.url}" alt="Our loaf" width="500" height="300" loading="eager" fetchpriority="high" title="Loaf">`,
		);
	});

	test("a Template that makes its first image lazy keeps it lazy, without high priority", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Notices", urlPattern: "/notices/{slug}" });
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("img", [], { src: `media:${badge.id}`, alt: "", loading: "lazy" })),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Closed Monday" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		expect(await mainOf("/notices/closed-monday")).toContain(
			`<img src="${badge.url}" alt="" width="700" height="350" loading="lazy">`,
		);
	});

	test("alt text changed in the Media library shows on published pages at once", async () => {
		await editor.api.media.update({ siteId, mediaId: hero.id, alt: "A sourdough loaf, fresh from the oven" });

		expect(await mainOf("/products/sourdough-loaf")).toContain('alt="A sourdough loaf, fresh from the oven"');
	});
});

describe("until the worker is done", () => {
	test("an image renders nothing until it is cleaned, then the original alone, then <picture>", async () => {
		const { media } = await editor.api.media.upload({
			siteId,
			file: upload(await photo({ width: 800, height: 400, camera: true }), "croissants.jpg"),
		});
		await publishEntry("Croissants", { photo: media.id });
		const badgeImage = `<img src="${badge.url}" alt="" width="700" height="350" loading="eager" fetchpriority="high">`;

		// The photo isn't there yet, so the badge is the first image in <main>.
		expect(await mainOf("/products/croissants")).toBe(
			`<article><h1>Croissants</h1>${picture(badge, badgeImage)}<a href="">Leaflet</a></article>`,
		);

		await install.drainJobs({ only: ["media.process"] });
		const cleaned = (await editor.api.media.get({ siteId, mediaId: media.id })).media;
		expect(cleaned.variants).toEqual([]);
		const original = await mainOf("/products/croissants");
		expect(original).toContain(
			`<h1>Croissants</h1><img src="${cleaned.url}" alt="" width="800" height="400" loading="eager" fetchpriority="high">`,
		);

		await install.drainJobs();
		const done = (await editor.api.media.get({ siteId, mediaId: media.id })).media;
		expect(await mainOf("/products/croissants")).toContain(
			picture(done, `<img src="${done.url}" alt="" width="800" height="400" loading="eager" fetchpriority="high">`),
		);
	});
});

describe("media Field values", () => {
	test("must be a Media item of the same Site", async () => {
		const otherSiteId = (await install.createSite((await editor.api.sites.get({ siteId })).workspace.id)).id;
		await goLive(install, otherSiteId);
		const admin = await install.superadmin();
		const elsewhere = (await admin.api.media.upload({ siteId: otherSiteId, file: upload(pdf(), "elsewhere.pdf") }))
			.media;

		for (const photo of [elsewhere.id, crypto.randomUUID(), "not-an-id", `media:${hero.id}`]) {
			await expect(
				editor.api.entries.create({ siteId, postTypeId, title: `Bad ${photo}`, fields: { photo } }),
			).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "fields.photo" }] } });
		}
	});

	test("an Entry reads back the id it holds", async () => {
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Bagels",
			fields: { photo: hero.id },
		});
		expect(entry.draft.fields.photo).toBe(hero.id);
	});

	test("a media: image of another Site renders nothing", async () => {
		const otherSiteId = (await install.createSite((await editor.api.sites.get({ siteId })).workspace.id)).id;
		await goLive(install, otherSiteId);
		const admin = await install.superadmin();
		const foreign = (
			await admin.api.media.upload({
				siteId: otherSiteId,
				file: upload(await photo({ width: 50, height: 50 }), "f.jpg"),
			})
		).media;
		await install.drainJobs();
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Notes", urlPattern: "/notes/{slug}" });
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: tree(element("p", [text("Hi")]), element("img", [], { src: `media:${foreign.id}`, alt: "" })),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Note" });
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		expect(await mainOf("/notes/note")).toBe("<p>Hi</p>");
	});
});

describe("Template markup", () => {
	test("media:<id> and a media Field render as Media images, and the markup prints back as written", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			urlPattern: "/recipes/{slug}",
			fields: [{ key: "photo", label: "Photo", type: "media" }],
		});
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: `<figure><img src="{{ photo }}"><img src="media:${badge.id}" alt="Award"></figure>`,
		});
		expect(saved.markup).toContain(`<img src="media:${badge.id}" alt="Award"`);
		expect(saved.markup).toContain('<img src="{{ photo }}"');
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Soda bread",
			fields: { photo: hero.id },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const { media: photo } = await editor.api.media.get({ siteId, mediaId: hero.id });

		expect(await mainOf("/recipes/soda-bread")).toBe(
			[
				"<figure>",
				picture(
					hero,
					`<img src="${hero.url}" alt="${photo.alt}" width="1000" height="600" loading="eager" fetchpriority="high">`,
				),
				picture(badge, `<img src="${badge.url}" alt="Award" width="700" height="350" loading="lazy">`),
				"</figure>",
			].join(""),
		);
	});
});

describe("the Site template", () => {
	test("its own Media images load lazily; the content's first image keeps high priority", async () => {
		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: `<header><img src="media:${badge.id}" alt="Acme Bakery"></header><main>{{@outlet}}</main>`,
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });

		const html = await (await install.request(onSite("/products/sourdough-loaf"))).text();
		expect(html).toContain(
			`<header>${picture(badge, `<img src="${badge.url}" alt="Acme Bakery" width="700" height="350" loading="lazy">`)}</header>`,
		);
		expect(await mainOf("/products/sourdough-loaf")).toContain(
			`<img src="${hero.url}" alt="A sourdough loaf, fresh from the oven" width="1000" height="600" loading="eager" fetchpriority="high">`,
		);
	});
});

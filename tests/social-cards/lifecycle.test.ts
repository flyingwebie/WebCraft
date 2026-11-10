import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { jsonLdNode, metaProperty } from "../harness/seo.ts";
import { goLive, openStaging } from "../harness/staging.ts";
import { freshBread, translatedSite } from "../translation/support.ts";

let install: TestInstall;
let api: ApiClient;
beforeAll(async () => {
	install = await createTestInstall();
	api = (await install.superadmin()).api;
});
afterAll(async () => {
	await install.close();
});
async function setup() {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const siteId = site.id;
	const origin = await goLive(install, siteId);
	const { postType } = await api.postTypes.create({
		siteId,
		name: "News",
		urlPattern: "/news/{slug}",
		fields: [{ key: "cover", label: "Cover", type: "media" }],
		seo: { schema: { type: "article" } },
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Bread", slug: "bread" });
	return { siteId, origin, entryId: entry.id, postTypeId: postType.id, siteSlug: site.slug };
}
async function page(origin: string, path = "/news/bread") {
	return (await install.request(origin + path)).text();
}
async function image(siteId: string, name: string) {
	const { media } = await api.media.upload({
		siteId,
		file: upload(await photo({ width: 120, height: 80, format: "png" }), name),
	});
	await install.drainJobs({ only: ["media.process", "media.variants"] });
	return media.id;
}
const cardText = async (url: string) =>
	JSON.parse(new TextDecoder().decode(new Uint8Array(await (await install.request(url)).arrayBuffer()).slice(8)));
const cardUrl = async (origin: string, path?: string) => metaProperty(await page(origin, path), "og:image") ?? "";
const publish = async (site: { siteId: string; entryId: string }) => api.entries.publish(site);
const drain = () => install.drainJobs({ only: ["socialCards.render"] });

test("fallback order is explicit image, Post Type Field, Social card, Site default; disable applies immediately", async () => {
	const site = await setup();
	const siteImage = await image(site.siteId, "default.png");
	const fieldImage = await image(site.siteId, "field.png");
	const own = await image(site.siteId, "own.png");
	await api.seoSettings.update({ siteId: site.siteId, defaultImage: siteImage });
	await publish(site);
	expect(await cardUrl(site.origin)).toContain("default.png");
	await drain();
	const generated = await cardUrl(site.origin);
	expect(generated).toContain("/_wc/social/");
	expect(jsonLdNode(await page(site.origin), "Article")?.image).toMatchObject({ url: generated });
	await api.entries.saveDraft({ ...site, fields: { cover: fieldImage } });
	await publish(site);
	expect(await cardUrl(site.origin)).toContain("field.png");
	await api.entries.saveDraft({ ...site, seo: { image: own } });
	await publish(site);
	expect(await cardUrl(site.origin)).toContain("own.png");
	await api.entries.saveDraft({ ...site, seo: { image: null }, fields: { cover: null } });
	await publish(site);
	expect(await cardUrl(site.origin)).toBe(generated);
	await api.seoSettings.update({ siteId: site.siteId, socialCards: { enabled: false } });
	expect(await cardUrl(site.origin)).toContain("default.png");
	expect((await install.request(generated)).status).toBe(404);
	const count = install.socialCards.rendered.length;
	await publish(site);
	await drain();
	expect(install.socialCards.rendered.length).toBe(count);
	await api.seoSettings.update({ siteId: site.siteId, socialCards: { enabled: true } });
	await drain();
	expect(await cardUrl(site.origin)).toBe(generated);
	expect(install.socialCards.rendered.length).toBe(count);
});

test("published titles are language-specific, hidden languages have no card and Staging never advertises a published title as its Draft card", async () => {
	const site = await setup();
	await api.languages.add({ siteId: site.siteId, code: "it" });
	await api.entries.saveDraft({ ...site, language: "it", title: "Pane fresco", slug: "pane" });
	await publish(site);
	await drain();
	const english = await cardUrl(site.origin);
	const italian = await cardUrl(site.origin, "/it/news/pane");
	expect((await cardText(english)).title).toBe("Bread");
	expect((await cardText(italian)).title).toBe("Pane fresco");
	expect((await cardText(italian)).language).toBe("it");
	const count = install.socialCards.rendered.length;
	await api.entries.saveDraft({ ...site, language: "it", title: "Segreto" });
	await drain();
	expect(await cardUrl(site.origin, "/it/news/pane")).toBe(italian);
	expect(install.socialCards.rendered.length).toBe(count);
	const browser = await install.superadmin();
	await openStaging(install, browser, site.siteId);
	const preview = await (await browser.request(`https://${site.siteSlug}.sites.test/it/news/pane`)).text();
	expect(metaProperty(preview, "og:image")).toBeUndefined();
	expect((await api.entries.get({ ...site, language: "it" })).entry.seoPreview.image).toMatchObject({
		from: "socialCard",
		state: "onPublish",
	});
	await api.entries.saveDraft({ ...site, hiddenLanguages: ["it"] });
	await publish(site);
	await drain();
	expect((await install.request(italian)).status).toBe(404);
	const other = await setup();
	expect((await install.request(english.replace(site.origin, other.origin))).status).toBe(404);
	expect((await install.request(`${site.origin}/_wc/social/${"-".repeat(36)}/en/${"0".repeat(64)}.png`)).status).toBe(
		404,
	);
});

test("Publish all and a frozen Scheduled publish render exactly what went live, then unpublish and deletion revoke the images", async () => {
	const site = await setup();
	const items = [{ kind: "entry" as const, id: site.entryId }];
	const asked = await api.publishing.publishAll({ siteId: site.siteId, items });
	if (asked.published) throw new Error("Missing confirmation");
	await api.publishing.publishAll({ siteId: site.siteId, items, confirmation: asked.confirmation.id });
	await drain();
	const first = await cardUrl(site.origin);
	expect(first).toContain("/_wc/social/");
	await api.entries.saveDraft({ ...site, title: "Scheduled bread" });
	await api.publishing.schedule({
		siteId: site.siteId,
		item: { kind: "entry", id: site.entryId },
		at: new Date(install.clock.now().getTime() + 60000).toISOString(),
	});
	await api.entries.saveDraft({ ...site, title: "Later Draft" });
	await install.clock.advance(60001);
	expect((await install.drainJobs()).failed).toEqual([]);
	const scheduled = await cardUrl(site.origin);
	expect((await cardText(scheduled)).title).toBe("Scheduled bread");
	expect((await install.request(first)).status).toBe(404);
	await api.publishing.scheduleUnpublish({
		...site,
		at: new Date(install.clock.now().getTime() + 60000).toISOString(),
	});
	await install.clock.advance(60001);
	await install.drainJobs();
	expect((await install.request(scheduled)).status).toBe(404);
	expect((await install.request(`${site.origin}/news/bread`)).status).toBe(410);
	await publish(site);
	await drain();
	const again = await cardUrl(site.origin);
	const deletion = await api.entries.delete(site);
	if (deletion.deleted) throw new Error("Missing deletion confirmation");
	await api.entries.delete({ ...site, confirmation: deletion.confirmation.id });
	expect((await install.request(again)).status).toBe(404);
});

test("unchanged inputs reuse the cache; published colours, layout overrides and replaced logos invalidate it", async () => {
	const site = await setup();
	const logo = await image(site.siteId, "logo.png");
	await api.seoSettings.update({ siteId: site.siteId, organization: { logo } });
	await publish(site);
	await drain();
	const first = await cardUrl(site.origin);
	const count = install.socialCards.rendered.length;
	await publish(site);
	await drain();
	expect(await cardUrl(site.origin)).toBe(first);
	expect(install.socialCards.rendered.length).toBe(count);
	const { designSystem } = await api.designSystem.get({ siteId: site.siteId });
	await api.designSystem.saveDraft({
		siteId: site.siteId,
		tokens: {
			...designSystem.draft.tokens,
			colours: designSystem.draft.tokens.colours.map((c) =>
				c.name === "primary" ? { ...c, light: { ...c.light, base: "#c2410c" } } : c,
			),
		},
	});
	await drain();
	expect(await cardUrl(site.origin)).toBe(first);
	await api.designSystem.publish({ siteId: site.siteId });
	expect(await cardUrl(site.origin)).toBe("");
	await drain();
	const colour = await cardUrl(site.origin);
	expect(colour).not.toBe(first);
	expect((await cardText(colour)).colours.primary).toBe("#c2410c");
	await api.postTypes.update({ siteId: site.siteId, postTypeId: site.postTypeId, seo: { socialCardLayout: "orbit" } });
	await drain();
	const override = await cardUrl(site.origin);
	expect((await cardText(override)).layout).toBe("orbit");
	await api.media.replace({
		siteId: site.siteId,
		mediaId: logo,
		file: upload(await photo({ width: 200, height: 90, format: "png" }), "new-logo.png"),
	});
	await install.drainJobs();
	const replaced = await cardUrl(site.origin);
	expect(replaced).not.toBe(override);
	expect(replaced).toContain("/_wc/social/");
	const asked = await api.media.delete({ siteId: site.siteId, mediaId: logo });
	if (!asked.trashed)
		await api.media.delete({ siteId: site.siteId, mediaId: logo, confirmation: asked.confirmation.id });
	await drain();
	expect((await cardText(await cardUrl(site.origin))).logo).toBeNull();
});

test("an older in-flight render cannot replace a newer card; a failed render keeps the fallback and recovers", async () => {
	const site = await setup();
	await publish(site);
	let entered = false;
	install.socialCards.beforeRender(async () => {
		if (entered) return;
		entered = true;
		await api.entries.saveDraft({ ...site, title: "Newer publication" });
		await publish(site);
		await install.drainJobs({ only: ["socialCards.render"], batchSize: 1 });
	});
	await drain();
	install.socialCards.beforeRender(null);
	const url = await cardUrl(site.origin);
	expect((await cardText(url)).title).toBe("Newer publication");
	const fallback = await image(site.siteId, "fallback.png");
	await api.seoSettings.update({ siteId: site.siteId, defaultImage: fallback });
	await api.entries.saveDraft({ ...site, title: "After failure" });
	await publish(site);
	install.socialCards.fail();
	expect((await drain()).failed.length).toBeGreaterThan(0);
	expect(await cardUrl(site.origin)).toContain("fallback.png");
	install.socialCards.work();
	// The hourly reconciliation also repairs a lost notification or an exhausted retry, without another publish.
	await install.clock.advance(3600000);
	await install.drainJobs();
	expect((await cardText(await cardUrl(site.origin))).title).toBe("After failure");
});

test("a language domain serves the same published Social card under its own origin", async () => {
	const site = await setup();
	await api.languages.add({ siteId: site.siteId, code: "it", domain: "cards-it.example" });
	install.connectDomain("cards-it.example");
	await install.clock.advance(60000);
	await install.drainJobs();
	await api.entries.saveDraft({ ...site, language: "it", title: "Pane", slug: "pane" });
	await publish(site);
	await drain();
	const url = await cardUrl("https://cards-it.example", "/news/pane");
	expect(url).toStartWith("https://cards-it.example/_wc/social/");
	expect((await cardText(url)).title).toBe("Pane");
	expect((await install.request(new Request(url, { method: "HEAD" }))).headers.get("content-type")).toBe("image/png");
	expect((await install.request(url, { method: "POST" })).status).toBe(405);
});

test("Automatic translation and approving a translation refresh Social cards with the newly published title", async () => {
	const site = await translatedSite(install, { de: "automatic", it: "review" });
	const entryId = await freshBread(site);
	await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
	await drain();
	expect((await cardText(await cardUrl(site.origin, "/de/blog/fresh-bread"))).title).toBe("Fresh bread");
	expect((await install.drainJobs()).failed).toEqual([]);
	const automatic = await cardUrl(site.origin, "/de/blog/fresh-bread");
	expect(automatic).toContain("/_wc/social/");
	expect((await cardText(automatic)).title).toBe("[de] Fresh bread");
	expect((await cardText(await cardUrl(site.origin, "/it/blog/fresh-bread"))).title).toBe("Fresh bread");
	await site.editor.api.translations.approve({ siteId: site.siteId, language: "it" });
	await drain();
	expect((await cardText(await cardUrl(site.origin, "/it/blog/fresh-bread"))).title).toBe("[it] Fresh bread");
});

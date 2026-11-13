import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createFakeS3, createTestInstall, type TestInstall } from "../harness/index.ts";
import { metaProperty } from "../harness/seo.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("an unavailable logo bucket warns, keeps the fallback and recovers through reconciliation", async () => {
	const { api } = await install.superadmin();
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const origin = await goLive(install, site.id);
	const { media: fallback } = await api.media.upload({
		siteId: site.id,
		file: upload(await photo({ width: 120, height: 80, format: "png" }), "fallback.png"),
	});
	await install.drainJobs({ only: ["media.process", "media.variants"] });
	const settings = {
		endpoint: "https://s3.storage.test",
		bucket: "social-card-logos",
		region: "eu-west-1",
		accessKeyId: "AKIAWEBCRAFTTEST",
		secretAccessKey: "a-test-key-for-social-cards-0123456789",
	};
	const bucket = createFakeS3(install.http, settings);
	await api.install.storage.update({ kind: "s3", ...settings, prefix: "", pathStyle: true });
	const { media: logo } = await api.media.upload({
		siteId: site.id,
		file: upload(await photo({ width: 100, height: 60, format: "png" }), "logo.png"),
	});
	await install.drainJobs({ only: ["media.process", "media.variants"] });
	await api.seoSettings.update({ siteId: site.id, defaultImage: fallback.id, organization: { logo: logo.id } });
	const { postTypes } = await api.postTypes.list({ siteId: site.id });
	const postTypeId = postTypes.find((item) => item.builtIn === "page")?.id ?? "";
	const { entry } = await api.entries.create({ siteId: site.id, postTypeId, title: "Bread" });
	await api.entries.publish({ siteId: site.id, entryId: entry.id });
	const cardUrl = async () => metaProperty(await expectSafePage(await install.request(`${origin}/bread`)), "og:image");

	bucket.fail("GET", 503);
	const firstLog = install.logs.length;
	expect((await install.drainJobs({ only: ["socialCards.render"] })).failed).toEqual([]);
	expect(await cardUrl()).toContain("fallback.png");
	const logs = install.logs.slice(firstLog).filter((line) => line.job === "socialCards.render");
	expect(logs.some((line) => line.level === "warn")).toBe(true);
	expect(logs.filter((line) => line.level === "error")).toEqual([]);

	bucket.recover();
	await install.clock.advance(3600000);
	expect((await install.drainJobs({ only: ["socialCards.reconcile", "socialCards.render"] })).failed).toEqual([]);
	const url = await cardUrl();
	expect(url).toContain("/_wc/social/");
	const response = await install.request(url ?? "");
	expectSiteHeaders(response);
	expect(response.status).toBe(200);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SOCIAL_CARD_LAYOUTS } from "@webcraft/core";
import { createSocialCardRenderer } from "@webcraft/worker/social-cards";
import { imageInfo, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { metaProperty } from "../harness/seo.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall({ socialCardRenderer: createSocialCardRenderer() });
});
afterAll(async () => {
	await install.close();
});

test("all 20 original layouts serve distinct 1200 × 630 PNGs with a long literal title and a local logo", async () => {
	const { api } = await install.superadmin();
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id, { name: "Bread & Butter" });
	const origin = await goLive(install, site.id);
	const { postTypes } = await api.postTypes.list({ siteId: site.id });
	const postTypeId = postTypes.find((p) => p.builtIn === "page")?.id ?? "";
	const { media } = await api.media.upload({
		siteId: site.id,
		file: upload(await photo({ width: 100, height: 60, format: "png" }), "logo.png"),
	});
	await install.drainJobs();
	await api.seoSettings.update({ siteId: site.id, organization: { logo: media.id } });
	const { entry } = await api.entries.create({
		siteId: site.id,
		postTypeId,
		title: `<span foreground="red">Bread & Butter</span> 世界 — ${"Extraordinary ".repeat(12)}`,
		slug: "bread",
	});
	await api.entries.publish({ siteId: site.id, entryId: entry.id });
	const seen = new Set<string>();
	expect(SOCIAL_CARD_LAYOUTS).toHaveLength(20);
	for (const layout of SOCIAL_CARD_LAYOUTS) {
		await api.seoSettings.update({ siteId: site.id, socialCards: { layout } });
		expect((await install.drainJobs({ only: ["socialCards.render"] })).failed).toEqual([]);
		const html = await (await install.request(`${origin}/bread`)).text();
		const url = metaProperty(html, "og:image");
		expect(url).toBeDefined();
		const served = await install.request(url ?? "");
		const bytes = new Uint8Array(await served.arrayBuffer());
		expect(await imageInfo(bytes)).toMatchObject({ width: 1200, height: 630, format: "png" });
		seen.add(createHash("sha256").update(bytes).digest("hex"));
	}
	expect(seen.size).toBe(20);
	// No logo, a short title, RTL and unbroken words all render without external requests.
	await api.seoSettings.update({ siteId: site.id, organization: { logo: null } });
	for (const title of ["Hi", "مرحبا بالعالم", "W".repeat(240)]) {
		await api.entries.saveDraft({ siteId: site.id, entryId: entry.id, title });
		await api.entries.publish({ siteId: site.id, entryId: entry.id });
		expect((await install.drainJobs({ only: ["socialCards.render"] })).failed).toEqual([]);
		const url = metaProperty(await (await install.request(`${origin}/bread`)).text(), "og:image");
		expect(url).toBeDefined();
		expect(await imageInfo(new Uint8Array(await (await install.request(url ?? "")).arrayBuffer()))).toMatchObject({
			width: 1200,
			height: 630,
		});
	}
});

// The renderer port, as the PDF renderer's own checks: incomplete inputs never fetch anything.
test("the worker handles absent words and refuses a vector logo at its raster-only port", async () => {
	const renderer = createSocialCardRenderer();
	const input = {
		layout: "editorial" as const,
		title: "",
		siteName: "",
		language: "it",
		colours: { primary: "#2563eb", accent: "#f97316", background: "#fafafa", text: "#18181b" },
		logo: null,
	};
	expect(await imageInfo(await renderer.render(input))).toMatchObject({ width: 1200, height: 630, format: "png" });
	await expect(
		renderer.render({
			...input,
			logo: new TextEncoder().encode(
				'<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50"/></svg>',
			),
		}),
	).rejects.toThrow("raster image");
});

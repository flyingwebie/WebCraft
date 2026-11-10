import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
const input = {
	organisation: "Example Council",
	website: "https://statement.live.test",
	standard: "National accessibility legislation",
	status: "notAssessed" as const,
	limitations: "Some older PDFs are not accessible.",
	burden: "None claimed.",
	excluded: "None identified.",
	alternatives: "Contact us for a text copy.",
	preparedOn: "2026-11-10",
	reviewedOn: "2026-11-10",
	method: "Staff review; manual audit pending.",
	feedback: "Contact our accessibility officer at access@example.test.",
	feedbackUrl: "mailto:access@example.test",
	enforcement: "Contact the national enforcement body if our response is unsatisfactory.",
	enforcementUrl: "https://example.test/enforcement",
};
beforeAll(async () => {
	install = await createTestInstall();
	const w = await install.createWorkspace();
	siteId = (await install.createSite(w.id, { slug: "statement" })).id;
	staff = (await install.createStaff({ workspaces: [w.id] })).browser;
	await goLive(install, siteId);
});
afterAll(async () => {
	await install.close();
});
test("Staff generate an editable, translated Draft Page; its footer follows publishing and later updates", async () => {
	const made = await staff.api.accessibilityStatement.generate({ siteId, ...input });
	expect(made.page.status).toBe("draft");
	expect(JSON.stringify(made.page.draft.fields[made.settings.fieldKey])).toContain("aims for WCAG 2.2 AA");
	expect(JSON.stringify(made.page.draft.fields[made.settings.fieldKey])).not.toContain("is fully compliant");
	const path = `https://statement.live.test/${made.page.draft.slug}`;
	expect((await install.request(path)).status).toBe(404);
	await staff.api.components.publish({ siteId, componentId: made.settings.componentId });
	await staff.api.entries.publish({ siteId, entryId: made.page.id });
	let html = await (await install.request(path)).text();
	expect(html).toContain("Some older PDFs");
	expect(html).toMatch(/<footer[^>]*>[\s\S]*Accessibility statement[\s\S]*<\/footer>/);
	const changed = await staff.api.accessibilityStatement.generate({
		siteId,
		...input,
		limitations: "The PDF issue is fixed; testing continues.",
	});
	expect(changed.page.id).toBe(made.page.id);
	expect(await (await install.request(path)).text()).toContain("Some older PDFs");
	await staff.api.languages.add({ siteId, code: "it" });
	await staff.api.entries.saveDraft({
		siteId,
		entryId: made.page.id,
		language: "it",
		title: "Dichiarazione di accessibilità",
		slug: "accessibilita",
		fields: { [made.settings.fieldKey]: { feedback: "<p>Contattaci per assistenza.</p>" } },
	});
	await staff.api.entries.publish({ siteId, entryId: made.page.id });
	html = await (await install.request("https://statement.live.test/it/accessibilita")).text();
	expect(html).toContain("Contattaci per assistenza.");
	expect(html).toContain('href="/it/accessibilita"');
	expect(html).toContain("Dichiarazione di accessibilità");
	await staff.api.accessibilityStatement.setEnabled({ siteId, enabled: false });
	html = await (await install.request(path)).text();
	expect(html).toContain("The PDF issue is fixed");
	expect(html).not.toContain("<footer");
});

test("the statement participates in ordinary translation jobs, protects its Component, and hides the footer with the Page", async () => {
	const { translatedSite } = await import("../translation/support.ts");
	const site = await translatedSite(install, { de: "automatic" });
	const generated = await site.staff.api.accessibilityStatement.generate({
		siteId: site.siteId,
		...input,
		organisation: "<script>alert(1)</script> Council",
	});
	await expect(site.owner.api.accessibilityStatement.generate({ siteId: site.siteId, ...input })).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
	await expect(
		site.staff.api.components.delete({ siteId: site.siteId, componentId: generated.settings.componentId }),
	).rejects.toMatchObject({ code: "COMPONENT_IN_USE" });
	// A Page alone cannot expose a footer link to a not-yet-published Component.
	await site.owner.api.entries.publish({ siteId: site.siteId, entryId: generated.page.id });
	expect(await (await install.request(`${site.origin}/missing`)).text()).not.toContain("<footer");
	await site.staff.api.components.publish({ siteId: site.siteId, componentId: generated.settings.componentId });
	await install.drainJobs();
	const translated = (
		await site.owner.api.entries.get({ siteId: site.siteId, entryId: generated.page.id, language: "de" })
	).entry;
	expect(JSON.stringify(translated.published?.fields)).toContain("[de] Feedback and contact information");
	const html = await (await install.request(`${site.origin}/de/accessibility-statement`)).text();
	expect(html).toContain("[de] Accessibility statement");
	expect(html).toContain('href="/de/accessibility-statement"');
	expect(html).not.toContain("<script>alert(1)</script>");
	const siteTemplate = await site.staff.api.templates.saveSiteTemplateMarkup({
		siteId: site.siteId,
		markup: "<main>{{@outlet}}</main><footer><p>Existing footer</p></footer>",
	});
	await site.staff.api.templates.publish({ siteId: site.siteId, templateId: siteTemplate.template.id });
	const withFooter = await (await install.request(`${site.origin}/missing`)).text();
	expect(withFooter.match(/<footer>/g)).toHaveLength(1);
	expect(withFooter).toMatch(
		/<footer><p>Existing footer<\/p><a href="\/accessibility-statement">Accessibility statement<\/a><\/footer>/,
	);
	await site.owner.api.entries.saveDraft({ siteId: site.siteId, entryId: generated.page.id, hiddenLanguages: ["de"] });
	await site.owner.api.entries.publish({ siteId: site.siteId, entryId: generated.page.id });
	expect(await (await install.request(`${site.origin}/de/missing`)).text()).not.toContain(
		'href="/de/accessibility-statement"',
	);
});

test("Site export/import remaps the statement references and retains Decorative image placements", async () => {
	const { exportedArchive, importArchive } = await import("../harness/site-transfer.ts");
	const { photo, upload } = await import("../harness/images.ts");
	const { publishEverything } = await import("../site-transfer/support.ts");
	const source = await install.superadmin();
	const original = (await source.api.accessibilityStatement.get({ siteId })).settings;
	if (!original) throw new Error("The statement fixture is missing.");
	const markup = (await source.api.components.getMarkup({ siteId, componentId: original.componentId })).markup.draft;
	await source.api.components.saveMarkup({
		siteId,
		componentId: original.componentId,
		markup: `${markup}<img src="https://example.test/ornament.png" data-wc-decorative>`,
	});
	const media = (
		await source.api.media.upload({ siteId, file: upload(await photo({ width: 32, height: 32 }), "leaf.jpg") })
	).media;
	await source.api.media.update({ siteId, mediaId: media.id, alt: "Leaf" });
	const { postType } = await source.api.postTypes.create({
		siteId,
		name: "Images",
		urlPattern: "/images/{slug}",
		fields: [{ key: "body", label: "Body", type: "body" }],
	});
	await source.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Leaf",
		fields: {
			body: [
				{ type: "image", media: media.id, decorative: true },
				{ type: "image", media: media.id },
			],
		},
	});
	const archive = await exportedArchive(install, source, siteId);
	const target = await createTestInstall();
	try {
		const admin = await target.superadmin();
		const workspaceId = (await target.createWorkspace()).id;
		const imported = await importArchive(target, admin, workspaceId, archive, {
			name: "Statement copy",
			slug: "statement-copy",
		});
		expect(imported.failure).toBeNull();
		const copiedSite = imported.site?.id ?? "";
		const settings = (await admin.api.accessibilityStatement.get({ siteId: copiedSite })).settings;
		if (!settings) throw new Error("The imported statement is missing.");
		expect(settings.pageId).not.toBe(original.pageId);
		expect(settings.componentId).not.toBe(original.componentId);
		expect(settings.fieldKey).toBe(original.fieldKey);
		expect(settings.forms).toEqual(original.forms);
		expect(settings.enabled).toBe(false);
		const page = (await admin.api.entries.get({ siteId: copiedSite, entryId: settings.pageId, language: "it" })).entry;
		expect(page.published).toBeNull();
		expect(JSON.stringify(page.draft.fields)).toContain("Contattaci per assistenza.");
		expect(
			(await admin.api.components.getMarkup({ siteId: copiedSite, componentId: settings.componentId })).markup.draft,
		).toContain('data-wc-decorative="true"');
		const copiedType = (await admin.api.postTypes.list({ siteId: copiedSite })).postTypes.find(
			(p) => p.name === "Images",
		);
		const copied = (await admin.api.entries.list({ siteId: copiedSite, postTypeId: copiedType?.id ?? "" })).entries[0];
		expect(copied?.draft.fields.body).toMatchObject([
			{ decorative: true, media: expect.not.stringContaining(media.id) },
			{},
		]);
		await admin.api.accessibilityStatement.setEnabled({ siteId: copiedSite, enabled: true });
		await publishEverything(admin, copiedSite);
		const origin = await goLive(target, copiedSite);
		const html = await (await target.request(`${origin}/it/accessibilita`)).text();
		expect(html).toContain("Contattaci per assistenza.");
		expect(html).toContain('href="/it/accessibilita"');
		expect(html).toContain('alt=""');
	} finally {
		await target.close();
	}
});

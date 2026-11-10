// Literal Content and real references must remain distinguishable, even when their bytes match.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import forms from "@webcraft/module-forms";
import { analyticsApi } from "../harness/analytics.ts";
import { formVisitor } from "../harness/forms.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { exportedArchive, importArchive, rowsIn, tarFiles } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "./support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});

test("Body text, Component text Props, translations and former live history preserve literals beside Media Props", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Body literals")).id;
	const siteId = (await install.createSite(workspaceId, { slug: "body-literals" })).id;
	await admin.api.languages.add({ siteId, code: "it" });
	const literal = "123e4567-e89b-42d3-a456-426614174000";
	const external = `https://external.example/${literal}`;
	const { media } = await admin.api.media.upload({
		siteId,
		file: upload(await photo({ width: 32, height: 32 }), `${literal}.jpg`),
	});
	await install.drainJobs();
	const { component } = await admin.api.components.create({
		siteId,
		name: "Illustration",
		props: [
			{ key: "text", label: "Text", type: "text" },
			{ key: "picture", label: "Picture", type: "media" },
		],
	});
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<aside>{{ props.text }}<img src="{{ props.picture }}" alt="Illustration"></aside>',
	});
	await admin.api.components.publish({ siteId, componentId: component.id });
	const { postType } = await admin.api.postTypes.create({
		siteId,
		key: "body-literals",
		name: "Bodies",
		urlPattern: "/stories/{slug}",
		fields: [
			{ key: "body", label: "Body", type: "body", components: [component.id] },
			{
				key: "group",
				label: "Group",
				type: "group",
				fields: [
					{ key: "literal", label: "Literal", type: "text" },
					{ key: "picture", label: "Picture", type: "media" },
				],
			},
		],
	});
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<article><a href="${external}">${literal}</a>{{ body }}</article>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const body = (words: string) => [
		{ type: "paragraph", text: [{ text: `${words} ${literal}`, link: external }] },
		{
			type: "component",
			component: component.id,
			props: [
				{ name: "text", value: media.id },
				{ name: "picture", value: `media:${media.id}` },
			],
		},
	];
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: literal,
		slug: "example",
		fields: {
			body: body("Live"),
			group: { literal: media.id, picture: media.id },
		},
	});
	await admin.api.entries.saveDraft({
		siteId,
		entryId: entry.id,
		language: "it",
		title: literal,
		slug: "example",
		fields: { body: body("Pubblicato") },
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	await admin.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { body: body("Draft") } });
	await admin.api.entries.saveDraft({ siteId, entryId: entry.id, language: "it", fields: { body: body("Bozza") } });
	const imported = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Body copy",
		slug: "body-literal-copy",
	});
	expect(imported.status).toBe("done");
	const destination = imported.site?.id ?? "";
	const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
		(type) => type.key === postType.key,
	);
	const [copy] = (await admin.api.entries.list({ siteId: destination, postTypeId: copiedType?.id ?? "" })).entries;
	const [image] = (await admin.api.media.list({ siteId: destination })).items;
	const [illustration] = (await admin.api.components.list({ siteId: destination })).components;
	expect(image?.id).not.toBe(media.id);
	for (const [language, words] of [
		["en", "Draft"],
		["it", "Bozza"],
	]) {
		const { entry } = await admin.api.entries.get({ siteId: destination, entryId: copy?.id ?? "", language });
		expect(entry.draft.title).toBe(literal);
		expect(entry.draft.fields.group).toMatchObject({ literal: media.id, picture: image?.id });
		expect(entry.draft.fields.body).toMatchObject([
			{ type: "paragraph", text: [{ text: `${words} ${literal}`, link: external }] },
			{
				type: "component",
				component: illustration?.id,
				props: [
					{ name: "text", value: media.id },
					{ name: "picture", value: `media:${image?.id}` },
				],
			},
		]);
	}
	const item = { kind: "entry" as const, id: copy?.id ?? "" };
	const history = await admin.api.history.list({ siteId: destination, item });
	const revision = history.copies.find((copy) => copy.type === "revision");
	const saved = await admin.api.history.get({
		siteId: destination,
		item,
		copy: { type: "revision", id: revision?.id ?? "" },
	});
	expect(JSON.stringify(saved.content)).toContain(`Live ${literal}`);
	expect(JSON.stringify(saved.content)).toContain(`Pubblicato ${literal}`);
	await admin.api.history.restore({ siteId: destination, item, copy: { type: "revision", id: revision?.id ?? "" } });
	await publishEverything(admin, destination);
	const origin = await goLive(install, destination);
	const html = await expectSafePage(await install.request(`${origin}/stories/example`));
	expect(html).toContain(`href="${external}"`);
	expect(html).toContain(`Live ${literal}`);
	expect(html).toContain(media.id);
	expect(html).toContain(`${literal}.jpg`);
});

test("Form answers and labels keep UUID literals and external URLs", async () => {
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	const workspaceId = (await install.createWorkspace("Form literals")).id;
	const siteId = (await install.createSite(workspaceId, { slug: "form-literals" })).id;
	await admin.api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: true });
	const origin = await goLive(install, siteId);
	await admin.api.consentBanner.setSettings({ siteId, mode: "none", layout: "bar" });
	const literal = "123e4567-e89b-42d3-a456-426614174000";
	const { form } = await admin.api.forms.create({ siteId, name: literal, key: "answers" });
	await admin.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [
				{ key: "reference", label: literal, type: "text" },
				{ key: "external", label: "External", type: "url" },
			],
		},
	});
	await admin.api.forms.publish({ siteId, formId: form.id });
	const { postType: pageType } = await admin.api.postTypes.create({
		siteId,
		name: "Answers",
		key: "answers",
		urlPattern: "/{slug}",
	});
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: pageType?.id ?? "",
		markup: "<article>{{@form answers}}</article>",
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: pageType?.id ?? "",
		title: "Answers",
		slug: "answers",
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	const visitor = formVisitor(install);
	const page = await visitor.open(`${origin}/answers`);
	await expectSafePage(new Response(page.html, page.response));
	await install.clock.advance(5000);
	const external = `https://external.example/${entry.id}`;
	const submitted = await visitor.send(page, { reference: literal, external });
	expectSiteHeaders(submitted);
	expect(submitted.status).toBe(303);
	const analytics = analyticsApi(admin);
	const { goal } = await analytics.goals.create({
		siteId,
		name: "Sent",
		definition: { kind: "form", formId: form.id },
	});
	await analytics.goals.create({
		siteId,
		name: "External",
		definition: { kind: "link", link: "outbound", target: external },
	});
	await analytics.funnels.create({
		siteId,
		name: "Answers",
		steps: [
			{ kind: "page", path: `/${literal}`, match: "exact" },
			{ kind: "goal", goalId: goal.id },
		],
	});
	const imported = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Answers copy",
		slug: "form-literal-copy",
	});
	expect(imported.status).toBe("done");
	const destination = imported.site?.id ?? "";
	const api = moduleApi<typeof forms>(admin, "forms");
	const [submission] = (await api.submissions.list({ siteId: destination })).submissions;
	const saved = (await api.submissions.get({ siteId: destination, id: submission?.id ?? "" })).submission;
	expect(saved.formId).not.toBe(form.id);
	const copiedGoals = (await analytics.goals.list({ siteId: destination })).goals;
	const copiedGoal = copiedGoals.find((goal) => goal.name === "Sent");
	expect(copiedGoal?.definition).toEqual({ kind: "form", formId: saved.formId });
	expect(copiedGoals.find((goal) => goal.name === "External")?.definition).toEqual({
		kind: "link",
		link: "outbound",
		target: external,
	});
	expect((await analytics.funnels.list({ siteId: destination })).funnels[0]?.steps).toEqual([
		{ kind: "page", path: `/${literal}`, match: "exact", label: `/${literal}` },
		{ kind: "goal", goalId: copiedGoal?.id ?? "", label: "Sent" },
	]);
	const copiedArchive = await exportedArchive(install, admin, destination);
	expect(
		rowsIn(copiedArchive, "m_site_analytics.events")
			.filter((row) => row.type === "form")
			.map((row) => row.target),
	).toEqual([saved.formId]);
	expect(saved.values).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ key: "reference", label: literal, value: literal }),
			expect.objectContaining({ key: "external", value: external }),
		]),
	);
});
afterAll(async () => {
	await install?.close();
});

test("literal UUIDs and external URLs survive beside genuine Entry references", async () => {
	const admin = await install.superadmin();
	const workspace = await install.createWorkspace("Literal source");
	const site = await install.createSite(workspace.id);
	const { postType } = await admin.api.postTypes.create({
		siteId: site.id,
		name: "Documents",
		key: "documents",
		urlPattern: "/documents/{slug}",
		fields: [
			{ key: "external", label: "External reference", type: "text" },
			{ key: "literal", label: "Literal", type: "text" },
			{ key: "related", label: "Related document", type: "relationship", postTypes: ["documents"] },
		],
	});
	const uuid = "123e4567-e89b-42d3-a456-426614174000";
	const title = `Document ${uuid}`;
	const external = `https://external.example/documents/${uuid}`;
	const { entry: other } = await admin.api.entries.create({
		siteId: site.id,
		postTypeId: postType.id,
		title: "Referenced",
	});
	await admin.api.entries.create({
		siteId: site.id,
		postTypeId: postType.id,
		title,
		slug: uuid,
		fields: { external, literal: other.id, related: other.id },
	});
	await admin.api.entries.create({ siteId: site.id, postTypeId: postType.id, title: uuid, fields: { literal: uuid } });
	const archive = await exportedArchive(install, admin, site.id);
	const target = await install.createWorkspace("Literal target");
	const imported = await importArchive(install, admin, target.id, archive, { name: "Copy", slug: "literal-copy" });
	expect(imported.status).toBe("done");
	const siteId = imported.site?.id ?? "";
	const copiedType = (await admin.api.postTypes.list({ siteId })).postTypes.find((type) => type.key === "documents");
	const { entries } = await admin.api.entries.list({ siteId, postTypeId: copiedType?.id ?? "" });
	const referenced = entries.find((entry) => entry.draft.title === "Referenced");
	const copied = entries.find((entry) => entry.draft.title.startsWith("Document "));
	expect(copied?.draft).toMatchObject({
		title,
		slug: uuid,
		fields: { external, literal: other.id, related: referenced?.id },
	});
	expect(referenced?.id).not.toBe(other.id);
	expect(entries.find((entry) => entry.draft.title === uuid)?.draft.fields.literal).toBe(uuid);
});

test("tree Classes, utility tokens and CSS references remap while CSS and Template text stay literal", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Style literals")).id;
	const siteId = (await install.createSite(workspaceId, { slug: "style-literals" })).id;
	const literal = "123e4567-e89b-42d3-a456-426614174000";
	const tokenId = crypto.randomUUID();
	const { designSystem } = await admin.api.designSystem.get({ siteId });
	const tokens = designSystem.draft.tokens;
	await admin.api.designSystem.saveDraft({
		siteId,
		tokens: {
			...tokens,
			space: {
				...tokens.space,
				steps: [...tokens.space.steps, { id: tokenId, name: "special", exponent: 5, size: null }],
			},
		},
	});
	const { class: card } = await admin.api.designSystem.createClass({
		siteId,
		name: "card",
		styles: "padding: var(--space-special);",
	});
	await admin.api.designSystem.saveDraft({ siteId, customCss: `.card::before { content: "${literal}"; }` });
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Styles",
		key: "styles",
		urlPattern: "/{slug}",
	});
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<article class="card p-special">${literal}</article>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Styled",
		slug: "example",
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	await admin.api.designSystem.publish({ siteId });
	const imported = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Style copy",
		slug: "style-literal-copy",
	});
	expect(imported.status).toBe("done");
	const destination = imported.site?.id ?? "";
	const copied = (await admin.api.designSystem.get({ siteId: destination })).designSystem.draft;
	expect(copied.tokens.space.steps.find((step) => step.name === "special")?.id).not.toBe(tokenId);
	expect(copied.classes.find((item) => item.name === "card")?.id).not.toBe(card.id);
	const copiedType = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
		(type) => type.key === "styles",
	);
	const { markup } = await admin.api.templates.getEntryTemplateMarkup({
		siteId: destination,
		postTypeId: copiedType?.id ?? "",
	});
	expect(markup?.draft).toContain('class="card p-special"');
	expect(markup?.draft).toContain(literal);
	expect(copied.customCss).toContain(literal);
	await publishEverything(admin, destination);
	const origin = await goLive(install, destination);
	const html = await expectSafePage(await install.request(`${origin}/example`));
	expect(html).toContain('class="card p-special"');
	expect(html).toContain(literal);
});

test("an unrelated account UUID typed as Content does not export that person's identity", async () => {
	const admin = await install.superadmin();
	const otherWorkspace = (await install.createWorkspace("Unrelated")).id;
	const unrelated = await install.createMember({ workspaceId: otherWorkspace, role: "author" });
	const workspaceId = (await install.createWorkspace("No account disclosure")).id;
	const siteId = (await install.createSite(workspaceId, { slug: "no-account-disclosure" })).id;
	const { postTypes } = await admin.api.postTypes.list({ siteId });
	await admin.api.entries.create({ siteId, postTypeId: postTypes[0]?.id ?? "", title: unrelated.personId });
	const archive = await exportedArchive(install, admin, siteId);
	const people = tarFiles(archive).find((file) => file.path === "people.jsonl.gz");
	expect(gunzipSync(people?.data ?? new Uint8Array()).toString()).not.toContain(unrelated.account.email);
});

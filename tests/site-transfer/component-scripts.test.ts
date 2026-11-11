// Component scripts move with a Site export (ADR 0033): each Component's script arrives on the new
// Site as a Draft of its Component, with its Consent category and the Libraries it declares, which
// point at the new Site's copies of those Libraries.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { fakeNpmPackage } from "../harness/fake-npm.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("a Component script and its settings round-trip through a Site export", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId, { slug: "script-source" })).id;
	fakeNpmPackage(install, "slide-kit", { "1.0.0": { files: { "index.js": "window.slides = 1;" } } });
	const { library } = await admin.api.libraries.add({
		siteId,
		library: { source: "npm", packageName: "slide-kit", version: "1.0.0" },
	});
	const { component } = await admin.api.components.create({ siteId, name: "Slideshow" });
	await admin.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup:
			"{{@props}}\ncaption: text exposed\n{{/props}}\n<figure><figcaption>{{ props.caption }}</figcaption></figure>",
	});
	const code = "export default (root) => { root.dataset.slides = root.dataset.caption; };";
	await admin.api.components.saveScriptDraft({
		siteId,
		componentId: component.id,
		code,
		consentCategory: "analytics",
		libraryIds: [library.id],
	});
	await admin.api.components.publish({ siteId, componentId: component.id });

	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Copy",
		slug: "script-copy",
	});
	expect(copied.status).toBe("done");
	const destination = copied.site?.id ?? "";
	const [copy] = (await admin.api.components.list({ siteId: destination })).components;
	const [newLibrary] = (await admin.api.libraries.list({ siteId: destination })).libraries;
	expect(copy?.id).not.toBe(component.id);
	expect(newLibrary?.id).not.toBe(library.id);

	const { script } = await admin.api.components.getScript({ siteId: destination, componentId: copy?.id ?? "" });
	expect(script?.draft).toEqual({ code, consentCategory: "analytics", libraryIds: [newLibrary?.id] });

	// Published on the new Site, its pages load it with that Library.
	await admin.api.components.publish({ siteId: destination, componentId: copy?.id ?? "" });
	const origin = await goLive(install, destination);
	const { postType } = await admin.api.postTypes.create({
		siteId: destination,
		name: "Albums",
		key: "albums",
		urlPattern: "/albums/{slug}",
	});
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId: destination,
		postTypeId: postType.id,
		markup: '<article><Slideshow caption="{{ title }}" /></article>',
	});
	await admin.api.templates.publish({ siteId: destination, templateId: template.id });
	const { entry } = await admin.api.entries.create({ siteId: destination, postTypeId: postType.id, title: "Summer" });
	await admin.api.entries.publish({ siteId: destination, entryId: entry.id });
	const html = await expectSafePage(await install.request(`${origin}/albums/summer`));
	expect(html).toContain(`src="${newLibrary?.src}"`);
	expect(html).toMatch(
		new RegExp(
			`<template data-wc-consent="analytics"><script type="module" src="/_wc/js/component/${copy?.id}/[0-9a-f]{16}\\.js"></script></template>`,
		),
	);
	expect(html).toContain(`data-wc-component="${copy?.id}" data-caption="Summer"`);
});

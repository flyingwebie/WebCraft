import { afterEach, beforeEach, expect, test } from "bun:test";
import { openCodeMode } from "../harness/code-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeEach(async () => {
	install = await createTestInstall();
});
afterEach(async () => {
	await install.close();
});

test("markup locations address repeated bindings, joined text and branches in the authored Component source", async () => {
	const workspace = await install.createWorkspace("Markup positions");
	const { id: siteId } = await install.createSite(workspace.id, { slug: "markup-positions" });
	const { api } = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const { component } = await api.components.create({ siteId, name: "SourcePositions" });
	const markup =
		'{{@props}}\n  quote: text\n{{/props}}\n<p data-wc-id="first">{{ "One" }}two{{ props.quote }}</p>\n{{@if props.quote}}\n<p data-wc-id="second">{{ props.quote }}</p>\n{{@else}}\n<!--Staff note-->\n{{/if}}';
	const read = await api.builder.read({ siteId, target: { kind: "component", componentId: component.id }, markup });
	const parts = Object.values(read.locations).map(({ start, end }) => markup.slice(start, end));
	expect(parts.filter((part) => part === "{{ props.quote }}")).toHaveLength(2);
	expect(parts).toContain('{{ "One" }}two');
	expect(parts).toContain("{{@else}}\n<!--Staff note-->\n");
	expect(parts).toContain("<!--Staff note-->");
	expect(parts).toContain('<p data-wc-id="second">{{ props.quote }}</p>');
	expect((await api.components.get({ siteId, componentId: component.id })).component.draft.tree.nodes).toEqual([]);
});

test("derived selection ranges stay in Code mode and never enter stored markup or visitor HTML", async () => {
	const workspace = await install.createWorkspace("Rendered positions");
	const { id: siteId } = await install.createSite(workspace.id, { slug: "rendered-positions" });
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const { template } = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header>{{@if true}}<p>Shown</p>{{/if}}</header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const origin = await goLive(install, siteId);
	const visitor = await expectSafePage(await install.request(`${origin}/`));
	expect(visitor).not.toContain("wc-code-start");
	expect(visitor).not.toContain("wc-code-end");
	const code = await openCodeMode(install, staff, siteId);
	const editing = await expectSafePage(await code.page("/"), "editMode");
	expect(editing).toContain("<!--wc-code-start ");
	expect(editing).toContain("<!--wc-code-end ");
	const stored = (await staff.api.templates.getSiteTemplateMarkup({ siteId })).markup;
	expect(stored?.draft).not.toContain("wc-code-start");
	expect(stored?.published).toBe(stored?.draft);
});

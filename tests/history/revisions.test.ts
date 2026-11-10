// Revisions (GLOSSARY.md): each time an item is published, the version it was published with is saved,
// in every language, with who published it, how they came in and when. Every publishable item has
// them: Entries of every Post Type (Pages too), the Globals, the Consent banner's words, a Form's
// emails and Structure (Templates, Components, Loops, Filters, scripts, Forms, the Design system). A
// publish saves one whichever way it happens: on its own, through Publish all or an API token.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { HistoryItem } from "@webcraft/core";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { type HistorySite, historySite } from "./support.ts";

let install: TestInstall;
let site: HistorySite;

beforeAll(async () => {
	install = await createTestInstall();
	site = await historySite(install);
});

afterAll(async () => {
	await install.close();
});

describe("publishing an Entry", () => {
	test("saves a Revision of the whole published version, in every language, with who published it and when", async () => {
		const { siteId, postTypeId, editor, editorId } = site;
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Fresh bread",
			fields: { summary: "Crusty and warm" },
		});
		await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			language: "fr",
			title: "Pain frais",
			fields: { summary: "Croustillant et chaud" },
		});
		await install.clock.set(new Date("2026-03-03T10:00:00Z"));
		await editor.api.entries.publish({ siteId, entryId: entry.id });

		const item = { kind: "entry", id: entry.id } as const;
		const history = await editor.api.history.list({ siteId, item });
		expect(history.item).toMatchObject({ kind: "entry", id: entry.id, name: "Fresh bread" });
		// Saving the French values first kept the Draft as it was made, as a Checkpoint.
		const revisions = history.copies.filter((copy) => copy.type === "revision");
		expect(revisions).toHaveLength(1);
		const [revision] = revisions;
		expect(revision).toMatchObject({
			type: "revision",
			at: new Date("2026-03-03T10:00:00Z"),
			by: { person: { id: editorId, name: "Eve Editor" }, via: { kind: "admin" }, client: null },
		});

		const { content } = await editor.api.history.get({
			siteId,
			item,
			copy: { type: "revision", id: revision?.id ?? "" },
		});
		const values = (content as { values: Record<string, Record<string, { value: unknown }>> }).values;
		expect(values.title?.en?.value).toBe("Fresh bread");
		expect(values.title?.fr?.value).toBe("Pain frais");
		expect(values.summary?.en?.value).toBe("Crusty and warm");
		expect(values.summary?.fr?.value).toBe("Croustillant et chaud");
	});
});

/** Publish all's two calls, as the admin makes them: the preview, then its confirmation. */
async function publishAll(api: TestBrowser["api"], siteId: string, items: HistoryItem[]): Promise<void> {
	const preview = await api.publishing.publishAll({ siteId, items });
	if (preview.published) throw new Error("Publish all published without a confirmation.");
	await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation.id });
}

describe("every publishable item", () => {
	test("saves one Revision each time it is published, through Publish all too: Content and Structure", async () => {
		const own = await historySite(install);
		const { siteId, postTypeId, staff, staffId } = own;
		const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")
			?.id as string;
		const post = (await staff.api.entries.create({ siteId, postTypeId, title: "Spring menu" })).entry;
		const page = (await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "About us" })).entry;
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		await staff.api.globals.saveDraft({ siteId, fields: { phone: "021 555 0100" } });
		await staff.api.consentBanner.saveDraft({ siteId, fields: { heading: "Cookies" } });
		await staff.api.designSystem.saveDraft({ siteId, customCss: "main { padding: 2rem; }" });
		const { component } = await staff.api.components.create({ siteId, name: "Notice" });
		await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<p>Hi</p>" });
		const { template } = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: "<article><h1>{{ title }}</h1><Notice /></article>",
		});
		const { script } = await staff.api.scripts.saveDraft({ siteId, entryId: null, code: "console.log(1);" });
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "latest",
			source: "query",
			query: { postTypes: ["posts"] },
		});
		const { filter } = await staff.api.filters.create({
			siteId,
			name: "latest",
			loop: "latest",
			controls: [
				{ type: "sort", key: "sort", options: [{ value: "a-z", label: "A to Z", by: "title", direction: "asc" }] },
			],
		});
		const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
		await staff.api.forms.saveEmails({
			siteId,
			formId: form.id,
			emails: {
				notifications: [
					{ recipients: ["orders@acmebakery.example"], routing: null, subject: "New message", intro: "" },
				],
			},
		});
		const items: HistoryItem[] = [
			{ kind: "entry", id: post.id },
			{ kind: "entry", id: page.id },
			{ kind: "globals" },
			{ kind: "consentBanner" },
			{ kind: "designSystem" },
			{ kind: "component", id: component.id },
			{ kind: "template", id: template.id },
			{ kind: "script", id: script.id },
			{ kind: "loop", id: loop.id },
			{ kind: "filter", id: filter.id },
			{ kind: "form", id: form.id },
			{ kind: "formEmails", id: form.id },
		];
		const { drafts } = await staff.api.publishing.drafts({ siteId });
		expect(drafts).toHaveLength(items.length);

		await publishAll(staff.api, siteId, items);
		for (const item of items) {
			const { copies } = await staff.api.history.list({ siteId, item });
			const revisions = copies.filter((copy) => copy.type === "revision");
			expect({ item, copies: revisions.map(({ type, by }) => ({ type, by: by?.person?.id })) }).toEqual({
				item,
				copies: [{ type: "revision", by: staffId }],
			});
		}

		// Publishing again saves another, newest first.
		await install.clock.advance(60_000);
		await staff.api.entries.saveDraft({ siteId, entryId: post.id, title: "Spring menu 2027" });
		await staff.api.entries.publish({ siteId, entryId: post.id });
		const copies = (await staff.api.history.list({ siteId, item: { kind: "entry", id: post.id } })).copies.filter(
			(copy) => copy.type === "revision",
		);
		expect(copies).toHaveLength(2);
		const newest = await staff.api.history.get({
			siteId,
			item: { kind: "entry", id: post.id },
			copy: { type: "revision", id: copies[0]?.id ?? "" },
		});
		expect(JSON.stringify(newest.content)).toContain("Spring menu 2027");
	});

	test("an API client's publish shows as its person through the token", async () => {
		const { workspaceId, siteId, postTypeId, staff, staffId } = site;
		const { entry } = await staff.api.entries.create({ siteId, postTypeId, title: "Rye loaf" });
		const { secret } = await createApiToken(staff, { workspaceId, name: "Nightly sync" });
		const script = tokenClient(install, secret);
		const first = await script.api.entries.publish({ siteId, entryId: entry.id });
		await script.api.entries.publish({
			siteId,
			entryId: entry.id,
			confirmation: (first as unknown as { confirmation: { id: string } }).confirmation.id,
		});

		const { copies } = await script.api.history.list({ siteId, item: { kind: "entry", id: entry.id } });
		expect(copies.map((copy) => copy.by)).toEqual([
			{
				person: { id: staffId, name: "Ada Staff" },
				via: { kind: "token", name: "Nightly sync" },
				client: "Nightly sync",
				impersonator: null,
			},
		]);
	});
});

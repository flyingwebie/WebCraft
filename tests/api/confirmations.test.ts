// Destructive procedures take two steps for API clients (spec › Management API, ADR 0030): the
// first call changes nothing and answers a preview with a confirmation id, valid 5 minutes, once,
// while the preview holds; the second, with the id, goes ahead. Publishing, deleting a Class and
// removing a Library take one call in the admin (a person pressed the button on what they see) and
// two through an API token; deleting and removing elsewhere take two steps for everyone.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TOOLSETS, type Toolset } from "@webcraft/core";

import { createApiToken, type TokenClient, tokenClient } from "../harness/api-tokens.ts";
import { fakeNpmPackage } from "../harness/fake-npm.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, tree, value } from "../harness/trees.ts";

const MINUTE = 60 * 1000;

/** The answer of a first call: nothing done yet. */
type Asked = { confirmation: { id: string; expiresAt: string }; preview: Record<string, unknown> };

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	fakeNpmPackage(install, "tiny-motion", {
		"1.0.0": { files: { "index.js": "/* tiny */" }, license: "MIT", main: "index.js" },
	});
});

afterAll(async () => {
	await install.close();
});

/**
 * A Site with a Post Type, its Entry template and a Draft Entry, and a token for its Workspace: with
 * the Toolsets a new token starts with, unless `toolsets` names them.
 */
async function fixture(toolsets?: Toolset[]) {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const siteId = site.id;
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Posts", urlPattern: "/posts/{slug}" });
	await admin.api.templates.saveEntryTemplate({
		siteId,
		postTypeId: postType.id,
		tree: tree(element("h1", [value("title")])),
	});
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	const { secret } = await createApiToken(admin, { workspaceId: workspace.id, name: "Publisher", toolsets });
	return { siteId, entryId: entry.id, script: tokenClient(install, secret) };
}

async function asked(answer: Promise<unknown>): Promise<Asked> {
	const first = (await answer) as Asked;
	expect(first.confirmation.id).toEqual(expect.any(String));
	return first;
}

async function entryStatus(siteId: string, entryId: string) {
	return (await admin.api.entries.get({ siteId, entryId })).entry.status;
}

describe("publishing through a token", () => {
	test("a confirmed publish that fails keeps its confirmation: once the problem is gone, the same id publishes", async () => {
		const { siteId, entryId, script } = await fixture();
		const { postTypeId } = (await admin.api.entries.get({ siteId, entryId })).entry;
		const first = await asked(script.api.entries.publish({ siteId, entryId }));
		// Staff make a Field required meanwhile: the Draft, and so the preview, hasn't changed.
		const summary = { key: "summary", label: "Summary", type: "text" } as const;
		await admin.api.postTypes.update({ siteId, postTypeId, fields: [{ ...summary, required: true }] });

		await expect(
			script.api.entries.publish({ siteId, entryId, confirmation: first.confirmation.id }),
		).rejects.toMatchObject({ code: "ENTRY_INCOMPLETE" });
		expect(await entryStatus(siteId, entryId)).toBe("draft");

		await admin.api.postTypes.update({ siteId, postTypeId, fields: [summary] });
		await script.api.entries.publish({ siteId, entryId, confirmation: first.confirmation.id });
		expect(await entryStatus(siteId, entryId)).toBe("published");
		// Used up once it went ahead.
		await expect(
			script.api.entries.publish({ siteId, entryId, confirmation: first.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
	});

	test("the first call shows what publishing does and publishes nothing; the second, with its id, publishes", async () => {
		const { siteId, entryId, script } = await fixture();

		const first = await asked(script.api.entries.publish({ siteId, entryId }));

		expect(first.preview).toEqual({
			item: { kind: "entry", id: entryId },
			name: "Fresh bread",
			firstPublish: true,
			changed: true,
			version: expect.stringMatching(/^[0-9a-f]{16}$/),
		});
		expect(new Date(first.confirmation.expiresAt).getTime() - install.clock.now().getTime()).toBe(5 * MINUTE);
		expect(await entryStatus(siteId, entryId)).toBe("draft");

		await script.api.entries.publish({ siteId, entryId, confirmation: first.confirmation.id });

		expect(await entryStatus(siteId, entryId)).toBe("published");
	});

	test("a confirmation works once, for 5 minutes, and only while the Draft stays as it was shown", async () => {
		const { siteId, entryId, script } = await fixture();

		const used = await asked(script.api.entries.publish({ siteId, entryId }));
		await script.api.entries.publish({ siteId, entryId, confirmation: used.confirmation.id });
		await expect(
			script.api.entries.publish({ siteId, entryId, confirmation: used.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "unknown" } });

		await admin.api.entries.saveDraft({ siteId, entryId, title: "Fresher bread" });
		const late = await asked(script.api.entries.publish({ siteId, entryId }));
		await install.clock.advance(5 * MINUTE + 1000);
		await expect(
			script.api.entries.publish({ siteId, entryId, confirmation: late.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "expired" } });

		const shown = await asked(script.api.entries.publish({ siteId, entryId }));
		await admin.api.entries.saveDraft({ siteId, entryId, title: "Freshest bread" });
		await expect(
			script.api.entries.publish({ siteId, entryId, confirmation: shown.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "changed" } });
		expect((await admin.api.entries.get({ siteId, entryId })).entry.published?.title).toBe("Fresh bread");
	});

	test("nobody is shown a preview of a publish they may not make", async () => {
		const { siteId, entryId } = await fixture();
		const { site } = await admin.api.sites.get({ siteId });
		const author = await install.createMember({ workspaceId: site.workspaceId, role: "author" });
		const { secret } = await createApiToken(author.browser, { workspaceId: site.workspaceId, name: "Author's" });

		await expect(tokenClient(install, secret).api.entries.publish({ siteId, entryId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("the admin still publishes in one call", async () => {
		const { siteId, entryId } = await fixture();

		await admin.api.entries.publish({ siteId, entryId });

		expect(await entryStatus(siteId, entryId)).toBe("published");
	});

	test("every kind of item a token publishes takes the two steps", async () => {
		// A Form's emails are published only with the Submissions Toolset, which no token starts with.
		const { siteId, script } = await fixture([...TOOLSETS]);
		const { template } = await admin.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<header>Hello</header><main>{{@outlet}}</main>",
		});
		const { component } = await admin.api.components.create({ siteId, name: "PostCard" });
		const { form } = await admin.api.forms.create({ siteId, name: "Contact", key: "contact" });
		const { loop } = await admin.api.loops.create({
			siteId,
			name: "latest",
			source: "query",
			query: { postTypes: ["posts"] },
		});
		const { script: siteScript } = await admin.api.scripts.saveDraft({
			siteId,
			entryId: null,
			code: "window.ready = true;",
		});
		await admin.api.consentBanner.saveDraft({ siteId, fields: { settings: "Privacy settings" } });
		await admin.api.designSystem.createClass({ siteId, name: "badge" });

		const publishes: [string, (confirmation?: string) => Promise<unknown>][] = [
			["template", (confirmation) => script.api.templates.publish({ siteId, templateId: template.id, confirmation })],
			[
				"component",
				(confirmation) => script.api.components.publish({ siteId, componentId: component.id, confirmation }),
			],
			["form", (confirmation) => script.api.forms.publish({ siteId, formId: form.id, confirmation })],
			["formEmails", (confirmation) => script.api.forms.publishEmails({ siteId, formId: form.id, confirmation })],
			["loop", (confirmation) => script.api.loops.publish({ siteId, loopId: loop.id, confirmation })],
			["script", (confirmation) => script.api.scripts.publish({ siteId, scriptId: siteScript.id, confirmation })],
			["globals", (confirmation) => script.api.globals.publish({ siteId, confirmation })],
			["consentBanner", (confirmation) => script.api.consentBanner.publish({ siteId, confirmation })],
			["designSystem", (confirmation) => script.api.designSystem.publish({ siteId, confirmation })],
		];
		for (const [kind, publish] of publishes) {
			const first = await asked(publish());
			expect({ kind, item: first.preview.item }).toMatchObject({ kind, item: { kind } });
			const second = (await publish(first.confirmation.id)) as Record<string, unknown>;
			expect({ kind, confirmation: second.confirmation }).toEqual({ kind, confirmation: undefined });
		}

		const { template: published } = await admin.api.templates.getSiteTemplate({ siteId });
		expect(published?.published).not.toBeNull();
		expect((await admin.api.designSystem.get({ siteId })).designSystem.published).not.toBeNull();
	});
});

describe("deleting Structure through a token", () => {
	test("deleting a Class shows which, then deletes it with the confirmation", async () => {
		const { siteId, script } = await fixture();
		const made = await admin.api.designSystem.createClass({ siteId, name: "callout" });

		const first = await asked(script.api.designSystem.deleteClass({ siteId, classId: made.class.id }));
		expect(first.preview).toEqual({ class: { id: made.class.id, name: "callout" } });
		expect(await classNames(script, siteId)).toContain("callout");

		await script.api.designSystem.deleteClass({ siteId, classId: made.class.id, confirmation: first.confirmation.id });
		expect(await classNames(script, siteId)).not.toContain("callout");
	});

	test("removing a Library shows which, then removes it with the confirmation", async () => {
		const { siteId, script } = await fixture();
		const { library } = await admin.api.libraries.add({
			siteId,
			library: { source: "npm", packageName: "tiny-motion", version: "1.0.0" },
		});

		const first = await asked(script.api.libraries.remove({ siteId, libraryId: library.id }));
		expect(first.preview).toMatchObject({ library: { id: library.id, name: "tiny-motion", version: "1.0.0" } });
		expect((await admin.api.libraries.list({ siteId })).libraries).toHaveLength(1);

		await script.api.libraries.remove({ siteId, libraryId: library.id, confirmation: first.confirmation.id });
		expect((await admin.api.libraries.list({ siteId })).libraries).toEqual([]);
	});

	test("procedures that take two steps for everyone take them through a token too", async () => {
		const { siteId, entryId, script } = await fixture();

		const first = (await script.api.entries.delete({ siteId, entryId })) as {
			deleted: boolean;
			confirmation: { id: string };
		};
		expect(first.deleted).toBe(false);
		await script.api.entries.delete({ siteId, entryId, confirmation: first.confirmation.id });

		await expect(admin.api.entries.get({ siteId, entryId })).rejects.toMatchObject({ code: "ENTRY_NOT_FOUND" });
	});
});

async function classNames(script: TokenClient, siteId: string): Promise<string[]> {
	return (await script.api.designSystem.get({ siteId })).designSystem.draft.classes.map((each) => each.name);
}

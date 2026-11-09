// "Suggest alt text": an AI provider writes alt text for an image, with the AI key the Workspace uses
// (ADR 0011: its own, else a shared one). Without one the library offers nothing and the procedure
// says why. A suggestion is only a suggestion: nothing is saved until the person saves it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { ImageDescriptionRequest } from "@webcraft/core";

import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const AI_KEY = "sk-test-workspace-key-0123456789";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId)).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
});

afterAll(async () => {
	await install.close();
});

async function readyImage(browser: TestBrowser, name: string) {
	const { media } = await browser.api.media.upload({
		siteId,
		file: upload(await photo({ width: 800, height: 600 }), name),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await browser.api.media.get({ siteId, mediaId: media.id })).media;
}

describe("Suggest alt text", () => {
	test("without the Workspace's AI key, isn't offered, and says why when asked", async () => {
		const image = await readyImage(editor, "no-key.jpg");
		expect((await editor.api.media.overview({ siteId })).altTextSuggestions).toBe(false);
		await expect(editor.api.media.suggestAltText({ siteId, mediaId: image.id })).rejects.toMatchObject({
			code: "AI_KEY_MISSING",
			status: 409,
		});
		expect(install.ai.requests).toEqual([]);
	});

	test("with it, an AI provider writes alt text in the language asked; nothing is saved", async () => {
		await staff.api.aiKeys.setOwn({
			workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: AI_KEY,
		});
		install.ai.answer(({ language }) => ({
			text: language === "it" ? "  Una pagnotta rotonda su un tagliere.  " : "A round loaf on a board.",
		}));
		const image = await readyImage(editor, "sourdough.jpg");
		await editor.api.media.update({ siteId, mediaId: image.id, title: "Sourdough", caption: "Fresh today" });
		expect((await editor.api.media.overview({ siteId })).altTextSuggestions).toBe(true);

		expect(await editor.api.media.suggestAltText({ siteId, mediaId: image.id, language: "it" })).toEqual({
			alt: "Una pagnotta rotonda su un tagliere.",
		});

		const request = install.ai.requests.at(-1) as ImageDescriptionRequest | undefined;
		expect(request).toMatchObject({
			connection: { provider: "openai", model: "gpt-5-mini", key: AI_KEY },
			purpose: "altText",
			language: "it",
			image: { contentType: "image/webp" },
			hints: { fileName: "sourdough.jpg", title: "Sourdough", caption: "Fresh today" },
		});
		expect(request?.image.data.length).toBeGreaterThan(0);
		expect((await editor.api.media.get({ siteId, mediaId: image.id })).media.alt).toBeNull();
	});

	test("only for images it can send, and only by people who may change the file", async () => {
		const { media: document } = await editor.api.media.upload({ siteId, file: upload(pdf(), "menu.pdf") });
		await expect(editor.api.media.suggestAltText({ siteId, mediaId: document.id })).rejects.toMatchObject({
			code: "ALT_TEXT_UNAVAILABLE",
			data: { reason: "kind" },
		});
		const { media: svg } = await editor.api.media.upload({
			siteId,
			file: upload(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
				"a.svg",
			),
		});
		await install.drainJobs();
		await expect(editor.api.media.suggestAltText({ siteId, mediaId: svg.id })).rejects.toMatchObject({
			code: "ALT_TEXT_UNAVAILABLE",
			data: { reason: "format" },
		});

		const image = await readyImage(editor, "editors.jpg");
		await expect(author.api.media.suggestAltText({ siteId, mediaId: image.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("a provider that fails says so; another Workspace's key is never used", async () => {
		const image = await readyImage(editor, "fails.jpg");
		install.ai.fail();
		await expect(editor.api.media.suggestAltText({ siteId, mediaId: image.id })).rejects.toMatchObject({
			code: "AI_PROVIDER_FAILED",
			data: { problem: "unavailable" },
		});

		const otherWorkspace = (await install.createWorkspace()).id;
		const otherSite = (await install.createSite(otherWorkspace)).id;
		const admin = await install.superadmin();
		const { media } = await admin.api.media.upload({
			siteId: otherSite,
			file: upload(await photo({ width: 100, height: 100 }), "other.jpg"),
		});
		await install.drainJobs();
		await expect(admin.api.media.suggestAltText({ siteId: otherSite, mediaId: media.id })).rejects.toMatchObject({
			code: "AI_KEY_MISSING",
		});
	});
});

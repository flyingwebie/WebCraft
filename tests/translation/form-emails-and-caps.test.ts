// AI translation of a Form's emails (its Auto-reply goes out in the visitor's language), and AI
// translation under the Workspace's AI key: without a key the work waits; at the monthly cap it stops
// cleanly (nothing half-written) and starts again once the cap is raised or the month ends.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { AI_KEY, freshBread, requestsInto, type TranslatedSite, translatedSite } from "./support.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-11-28T09:00:00Z") });
});

afterAll(async () => {
	await install.close();
});

async function formWithAutoReply(site: TranslatedSite) {
	const { form } = await site.staff.api.forms.create({ siteId: site.siteId, name: "Wedding cakes" });
	await site.staff.api.forms.saveDraft({
		siteId: site.siteId,
		formId: form.id,
		form: { fields: [{ key: "email", type: "email", label: "Email", required: true }] },
	});
	await site.staff.api.forms.publish({ siteId: site.siteId, formId: form.id });
	await site.owner.api.forms.saveEmails({
		siteId: site.siteId,
		formId: form.id,
		emails: {
			autoReply: {
				enabled: true,
				field: "email",
				subject: { text: "Thanks for your order" },
				text: { text: "We bake it fresh for you." },
			},
		},
	});
	return form.id;
}

describe("a Form's emails", () => {
	test("in an Automatic language, the Auto-reply's subject and text are translated and published", async () => {
		const site = await translatedSite(install, { it: "automatic" });
		const formId = await formWithAutoReply(site);
		await site.owner.api.forms.publishEmails({ siteId: site.siteId, formId });
		expect((await install.drainJobs()).failed).toEqual([]);

		const { form } = await site.owner.api.forms.get({ siteId: site.siteId, formId });
		expect(form.emails.published?.autoReply).toMatchObject({
			subject: { text: "Thanks for your order", translations: { it: "[it] Thanks for your order" } },
			text: { text: "We bake it fresh for you.", translations: { it: "[it] We bake it fresh for you." } },
		});
		expect(form.emails.draft.autoReply.subject.translations).toEqual({ it: "[it] Thanks for your order" });
	});

	test("a translation a person wrote stays; the AI's own is written again when its source changes", async () => {
		const site = await translatedSite(install, { it: "automatic" });
		const formId = await formWithAutoReply(site);
		await site.owner.api.forms.publishEmails({ siteId: site.siteId, formId });
		await install.drainJobs();
		await site.owner.api.forms.saveEmails({
			siteId: site.siteId,
			formId,
			emails: {
				autoReply: {
					enabled: true,
					field: "email",
					subject: { text: "Thank you for your order", translations: { it: "Grazie dell'ordine" } },
					text: { text: "We bake it fresh, just for you.", translations: { it: "[it] We bake it fresh for you." } },
				},
			},
		});
		await site.owner.api.forms.publishEmails({ siteId: site.siteId, formId });
		await install.drainJobs();

		const { form } = await site.owner.api.forms.get({ siteId: site.siteId, formId });
		expect(form.emails.published?.autoReply.subject.translations).toEqual({ it: "Grazie dell'ordine" });
		expect(form.emails.published?.autoReply.text.translations).toEqual({ it: "[it] We bake it fresh, just for you." });
	});
});

describe("under the AI key", () => {
	test("without an AI key the work waits, and starts once a key is set", async () => {
		const site = await translatedSite(install, { it: "review" });
		await site.owner.api.aiKeys.removeOwn({ workspaceId: site.workspaceId });
		const entryId = await freshBread(site);
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		expect((await site.owner.api.translations.overview({ siteId: site.siteId })).languages[0]?.waiting).toEqual([
			{ reason: "noKey", count: 1 },
		]);

		await site.owner.api.aiKeys.setOwn({
			workspaceId: site.workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: AI_KEY,
		});
		expect((await install.drainJobs()).failed).toEqual([]);
		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" });
		expect(entry.draft.title).toBe("[it] Fresh bread");
	});

	test("at the cap translation stops with nothing half-written, and goes on once the cap is raised", async () => {
		const site = await translatedSite(install, { it: "review" });
		await site.owner.api.aiKeys.setOwn({
			workspaceId: site.workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			price: { input: 1000, output: 1000 },
			monthlyCap: 1,
		});
		// Each call costs $2: the first goes through, the second finds the cap reached.
		install.ai.translateWith((text, request) => `[${request.to.code}] ${text}`, { inputTokens: 2000, outputTokens: 0 });
		const long = Array.from({ length: 60 }, (_, index) => ({
			id: `p${index}`,
			type: "paragraph",
			text: `Paragraph ${index} about bread, ${"long ".repeat(25)}`,
		}));
		const { entry } = await site.owner.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "A long story",
			fields: { body: long },
		});
		const before = requestsInto(install, "it").length;
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		expect(requestsInto(install, "it").length).toBe(before + 1);

		const italian = async () =>
			(await site.owner.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" })).entry;
		const halted = await italian();
		expect(halted.draft.title).toBe("A long story");
		expect(halted.translation?.aiWritten).toEqual([]);
		const overview = await site.owner.api.translations.overview({ siteId: site.siteId });
		expect(overview.key.capReached).toBe(true);
		expect(overview.languages[0]?.waiting).toEqual([{ reason: "cap", count: 1 }]);

		// Raising the cap picks the work up again; the batch already paid for comes from the cache.
		await site.owner.api.aiKeys.setOwnCap({ workspaceId: site.workspaceId, monthlyCap: 100 });
		expect((await install.drainJobs()).failed).toEqual([]);
		const done = await italian();
		expect(done.draft.title).toBe("[it] A long story");
		expect(
			(done.draft.fields.body as { text: { text: string }[] }[]).every((block) =>
				block.text[0]?.text.startsWith("[it]"),
			),
		).toBe(true);
	});

	test("work held at the cap starts again by itself in the new month", async () => {
		const site = await translatedSite(install, { it: "review" });
		await site.owner.api.aiKeys.setOwn({
			workspaceId: site.workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			price: { input: 1000, output: 1000 },
			monthlyCap: 1,
		});
		install.ai.translateWith((text, request) => `[${request.to.code}] ${text}`, { inputTokens: 2000, outputTokens: 0 });
		const first = await freshBread(site, "First loaf");
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		const second = await freshBread(site, "Second loaf");
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		const title = async (entryId: string) =>
			(await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" })).entry.draft.title;
		expect(await title(first)).toBe("[it] First loaf");
		expect(await title(second)).toBe("Second loaf");

		await install.clock.set(new Date("2026-12-01T00:30:00Z"));
		// The hourly job finds the held work a new month can pay for.
		await install.clock.advance(60 * 60 * 1000);
		expect((await install.drainJobs()).failed).toEqual([]);
		expect(await title(second)).toBe("[it] Second loaf");
	});
});

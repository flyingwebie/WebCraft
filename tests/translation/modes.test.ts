// Translation modes (GLOSSARY.md): each language other than the Default language is Automatic (AI
// translation is published together with the Default language's publish, by a job after it), Review
// (AI translation lands in the Draft for a person to publish) or Manual (nothing automatic). A
// publish never waits for a translation, and never fails because of one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { taggedTranslation } from "../harness/fake-ai.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { freshBread, requestsInto, translatedSite, visit } from "./support.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

describe("Automatic", () => {
	test("the Default language's publish goes out at once; a job after it publishes the translation too", async () => {
		const site = await translatedSite(install, { de: "automatic" });
		const entryId = await freshBread(site);

		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		// Until the job runs, German visitors read the Default language's values.
		expect((await visit(install, site, "/de/blog/fresh-bread")).article).toContain("Crusty sourdough");

		expect((await install.drainJobs()).failed).toEqual([]);
		const page = await visit(install, site, "/de/blog/fresh-bread");
		expect(page.article).toContain("<h1>[de] Fresh bread</h1>");
		expect(page.article).toContain("<p>[de] Crusty sourdough</p>");
		expect(page.article).toContain("[de] Our loaves rise overnight.");
		// A shared value is never translated.
		expect(page.article).toContain("<p>4</p>");

		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "de" });
		expect(entry.published?.fields.summary).toBe("[de] Crusty sourdough");
		expect(entry.draft.fields.summary).toBe("[de] Crusty sourdough");
		expect(entry.status).toBe("published");
		expect(entry.translation?.aiWritten).toContain("fields.summary");

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 50 });
		expect(entries.find((candidate) => candidate.action === "translation.publish")).toMatchObject({
			via: { kind: "translation" },
			siteId: site.siteId,
			details: { item: { kind: "entry", id: entryId }, language: "de" },
		});
	});

	test("a translation that fails never fails the publish: the work waits, says why, and runs again", async () => {
		const site = await translatedSite(install, { de: "automatic" });
		const entryId = await freshBread(site);
		install.ai.fail("unavailable");

		const { entry } = await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		expect(entry.status).toBe("published");
		expect((await install.drainJobs()).failed).toEqual([]);
		const overview = await site.owner.api.translations.overview({ siteId: site.siteId });
		expect(overview.languages).toEqual([
			expect.objectContaining({ code: "de", mode: "automatic", waiting: [{ reason: "unavailable", count: 1 }] }),
		]);
		expect((await visit(install, site, "/de/blog/fresh-bread")).article).toContain("Crusty sourdough");

		install.ai.translateWith(taggedTranslation);
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		expect((await visit(install, site, "/de/blog/fresh-bread")).article).toContain("[de] Crusty sourdough");
		expect((await site.owner.api.translations.overview({ siteId: site.siteId })).languages[0]?.waiting).toEqual([]);
	});
});

describe("Automatic, around it", () => {
	test("the Site's Webhooks hear of a published translation, as of any publish; nothing sent reaches the log", async () => {
		const site = await translatedSite(install, { de: "automatic" });
		install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
		const url = `https://hooks.agency.example/${site.siteId}`;
		install.http.respond("POST", url, { status: 204 });
		await site.staff.api.webhooks.add({ siteId: site.siteId, url, events: ["publish"] });
		const entryId = await freshBread(site);
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		expect((await install.drainJobs()).failed).toEqual([]);

		const events = install.http.requests
			.filter((request) => request.url === url)
			.map((request) => JSON.parse(request.body) as { data: { item: { kind: string; id: string }; via: string } });
		expect(events.map((event) => ({ item: event.data.item.id, via: event.data.via }))).toEqual([
			{ item: entryId, via: "admin" },
			{ item: entryId, via: "translation" },
		]);
		expect(JSON.stringify(install.logs)).not.toContain("Crusty sourdough");
	});

	test("an Entry hidden in a language is never translated into it", async () => {
		const site = await translatedSite(install, { de: "automatic" });
		const entryId = await freshBread(site);
		await site.owner.api.entries.saveDraft({ siteId: site.siteId, entryId, hiddenLanguages: ["de"] });
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		await install.drainJobs();
		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "de" });
		expect(entry.published?.title).toBe("Fresh bread");
	});
});

describe("Review", () => {
	test("AI translation lands in the Draft; approving it publishes it", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		expect((await install.drainJobs()).failed).toEqual([]);

		const get = async () => (await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" })).entry;
		const waiting = await get();
		expect(waiting.draft.title).toBe("[it] Fresh bread");
		expect(waiting.draft.fields.summary).toBe("[it] Crusty sourdough");
		// Visitors still read the Default language's values.
		expect(waiting.published?.fields.summary).toBe("Crusty sourdough");
		expect(waiting.status).toBe("changed");
		expect(waiting.translation?.toReview).toEqual(
			expect.arrayContaining(["title", "fields.summary", "fields.intro", "fields.body", "fields.cta"]),
		);

		const { lines } = await site.editor.api.translations.queue({ siteId: site.siteId, language: "it" });
		expect(lines).toContainEqual(
			expect.objectContaining({
				item: expect.objectContaining({ kind: "entry", id: entryId, title: "Fresh bread" }),
				at: "fields.summary",
				labels: ["Summary"],
				status: "toReview",
				writtenBy: { kind: "ai" },
				source: "Crusty sourdough",
				translation: "[it] Crusty sourdough",
			}),
		);

		const { approved } = await site.editor.api.translations.approve({ siteId: site.siteId, language: "it" });
		expect(approved).toBeGreaterThanOrEqual(5);
		expect((await get()).published?.fields.summary).toBe("[it] Crusty sourdough");
		expect((await visit(install, site, "/it/blog/fresh-bread")).article).toContain("[it] Crusty sourdough");
		expect((await site.editor.api.translations.queue({ siteId: site.siteId, language: "it" })).lines).toEqual([]);
	});
});

describe("Manual", () => {
	test("nothing is translated automatically, and Translate now leaves it alone", async () => {
		const site = await translatedSite(install, { fr: "manual", it: "review" });
		const entryId = await freshBread(site);
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();

		expect(requestsInto(install, "fr").filter((request) => request.texts.includes("Crusty sourdough"))).toEqual([]);
		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "fr" });
		expect(entry.draft.fields.summary).toBe("Crusty sourdough");
	});
});

describe("Translate now", () => {
	test("translates every item: Review languages' Drafts, and Automatic languages' published values", async () => {
		const site = await translatedSite(install, { it: "review", de: "automatic" });
		const published = await freshBread(site, "Fresh bread");
		const unpublished = await freshBread(site, "Rye loaf");
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId: published });
		await install.drainJobs();
		await site.staff.api.globals.setFields({
			siteId: site.siteId,
			fields: [{ key: "opening", label: "Opening hours", type: "text" }],
		});
		await site.owner.api.globals.saveDraft({ siteId: site.siteId, fields: { opening: "Open daily" } });

		const { queued } = await site.owner.api.translations.translateNow({ siteId: site.siteId });
		expect(queued).toBe(6);
		// Pressed twice before the worker ran: the same work is queued once.
		expect((await site.owner.api.translations.translateNow({ siteId: site.siteId })).queued).toBe(6);
		expect((await install.drainJobs()).failed).toEqual([]);

		const it = async (entryId: string) =>
			(await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" })).entry;
		expect((await it(unpublished)).draft.title).toBe("[it] Rye loaf");
		expect((await site.owner.api.globals.get({ siteId: site.siteId, language: "it" })).globals.draft.opening).toBe(
			"[it] Open daily",
		);
		const de = async (entryId: string) =>
			(await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "de" })).entry;
		expect((await de(published)).published?.title).toBe("[de] Fresh bread");
		expect((await de(unpublished)).draft.title).toBe("Rye loaf");
	});

	test("the overview shows each language's progress, and what the AI key spent here this month", async () => {
		const site = await translatedSite(install, { it: "review", fr: "manual" });
		await freshBread(site);
		const before = await site.owner.api.translations.overview({ siteId: site.siteId });
		expect(before.defaultLanguage).toEqual({ code: "en", name: "English" });
		expect(before.languages.map(({ code, mode, progress }) => ({ code, mode, progress }))).toEqual([
			{ code: "it", mode: "review", progress: 0 },
			{ code: "fr", mode: "manual", progress: 0 },
		]);
		expect(before.key).toEqual({ inUse: "own", capReached: false, capPercent: null });

		await site.owner.api.translations.translateNow({ siteId: site.siteId, language: "it" });
		await install.drainJobs();
		const after = await site.owner.api.translations.overview({ siteId: site.siteId });
		expect(after.languages[0]).toMatchObject({ code: "it", progress: 100, toReview: 5, missing: 0 });
		expect(after.usage.calls).toBeGreaterThan(0);
		expect(after.usage.cost).toBeGreaterThan(0);
		// Only Staff and Owners see what AI costs.
		expect((await site.editor.api.translations.overview({ siteId: site.siteId })).usage.cost).toBeNull();
	});
});

describe("who may", () => {
	test("Staff and Owners set modes and Translate now; Editors read and approve; Authors can't approve", async () => {
		const site = await translatedSite(install, { it: "review" });
		for (const call of [
			() => site.editor.api.translations.setMode({ siteId: site.siteId, language: "it", mode: "automatic" }),
			() => site.editor.api.translations.translateNow({ siteId: site.siteId }),
			() => site.author.api.translations.approve({ siteId: site.siteId, language: "it" }),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		await site.staff.api.translations.setMode({ siteId: site.siteId, language: "it", mode: "automatic" });
		await expect(
			site.owner.api.translations.setMode({ siteId: site.siteId, language: "en", mode: "automatic" }),
		).rejects.toMatchObject({ code: "TRANSLATION_LANGUAGE_INVALID", data: { reason: "default" } });
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 50 });
		expect(entries.find((candidate) => candidate.action === "translationMode.change")).toMatchObject({
			siteId: site.siteId,
			details: { language: "it", mode: "automatic" },
		});
	});
});

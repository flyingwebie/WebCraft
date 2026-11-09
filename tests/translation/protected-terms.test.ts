// Protected terms (GLOSSARY.md): words AI translation leaves exactly as written. A Workspace keeps a
// list for all its Sites, and each Site its own. Each occurrence is sent as a placeholder and put
// back exactly as it was written; an answer that drops or changes one is refused.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { requestsInto, type TranslatedSite, translatedSite } from "./support.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

async function entryWith(site: TranslatedSite, summary: string) {
	const { entry } = await site.owner.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title: `Post ${Math.random().toString(36).slice(2, 8)}`,
		fields: { summary },
	});
	return entry.id;
}

async function translateAndRead(site: TranslatedSite, entryId: string) {
	await site.owner.api.translations.translateNow({ siteId: site.siteId });
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" })).entry;
}

describe("placeholders", () => {
	test("Workspace and Site terms are sent as placeholders and put back exactly as written", async () => {
		const site = await translatedSite(install, { it: "review" });
		await site.editor.api.protectedTerms.add({
			workspaceId: site.workspaceId,
			siteId: null,
			terms: [
				{ term: "Acme", matchCase: true },
				{ term: "Acme Sourdough Loaf", matchCase: true },
			],
		});
		await site.editor.api.protectedTerms.add({
			workspaceId: site.workspaceId,
			siteId: site.siteId,
			terms: [{ term: "bread club", matchCase: false }],
		});
		const entryId = await entryWith(site, "The Acme Sourdough Loaf is back for Bread Club members, says Acme.");

		const entry = await translateAndRead(site, entryId);
		const sent = requestsInto(install, "it").flatMap((request) => request.texts);
		// Longer terms first, so "Acme Sourdough Loaf" stays whole before "Acme" is looked for.
		expect(sent).toContain("The ⟦T1⟧ is back for ⟦T2⟧ members, says ⟦T3⟧.");
		expect(sent.join("\n")).not.toMatch(/Acme|Bread Club/);
		// Put back exactly as written where they were found, whatever the case the term was given in.
		expect(entry.draft.fields.summary).toBe("[it] The Acme Sourdough Loaf is back for Bread Club members, says Acme.");
	});

	test("a term is matched as a whole word, and in any case only when it says so", async () => {
		const site = await translatedSite(install, { it: "review" });
		await site.owner.api.protectedTerms.add({
			workspaceId: site.workspaceId,
			siteId: null,
			terms: [
				{ term: "Rye", matchCase: true },
				{ term: "kilkenny", matchCase: false },
			],
		});
		const entryId = await entryWith(site, "Ryebread and rye from KILKENNY, Rye on Sundays.");
		await translateAndRead(site, entryId);
		expect(requestsInto(install, "it").flatMap((request) => request.texts)).toContain(
			"Ryebread and rye from ⟦T1⟧, ⟦T2⟧ on Sundays.",
		);
	});

	test("an answer that drops or changes a placeholder is refused: nothing is written", async () => {
		const site = await translatedSite(install, { it: "review" });
		await site.owner.api.protectedTerms.add({
			workspaceId: site.workspaceId,
			siteId: null,
			terms: [{ term: "Acme", matchCase: true }],
		});
		const entryId = await entryWith(site, "Baked by Acme.");
		install.ai.translateWith((text) => `[it] ${text.replace("⟦T1⟧", "Akme")}`);
		const dropped = await translateAndRead(site, entryId);
		expect(dropped.draft.fields.summary).toBe("Baked by Acme.");

		install.ai.translateWith((text) => `[it] ${text.replace("⟦T1⟧", "⟦T7⟧")}`);
		const changed = await translateAndRead(site, entryId);
		expect(changed.draft.fields.summary).toBe("Baked by Acme.");
		expect((await site.owner.api.translations.overview({ siteId: site.siteId })).languages[0]?.waiting).toEqual([
			{ reason: "answer", count: 1 },
		]);
	});

	test("after a new term, the same text is sent again rather than taken from the cache", async () => {
		const site = await translatedSite(install, { it: "review" });
		await entryWith(site, "Panettone Sunday is here.");
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		await site.owner.api.protectedTerms.add({
			workspaceId: site.workspaceId,
			siteId: site.siteId,
			terms: [{ term: "Panettone Sunday", matchCase: true }],
		});

		const later = await entryWith(site, "Panettone Sunday is here.");
		const entry = await translateAndRead(site, later);
		expect(requestsInto(install, "it").flatMap((request) => request.texts)).toContain("⟦T1⟧ is here.");
		expect(entry.draft.fields.summary).toBe("[it] Panettone Sunday is here.");
	});
});

describe("the lists", () => {
	test("the Workspace's list shows its own terms and each Site's, with who added them", async () => {
		const site = await translatedSite(install, { it: "review" });
		await site.editor.api.protectedTerms.add({
			workspaceId: site.workspaceId,
			siteId: null,
			terms: [
				{ term: "Northwind Studio", matchCase: true },
				{ term: "Northwind Studio", matchCase: true },
			],
		});
		await site.owner.api.protectedTerms.add({
			workspaceId: site.workspaceId,
			siteId: site.siteId,
			terms: [{ term: "Party Platter XL", matchCase: false }],
		});

		const { terms } = await site.owner.api.protectedTerms.list({ workspaceId: site.workspaceId });
		expect(terms).toEqual([
			expect.objectContaining({
				term: "Northwind Studio",
				site: null,
				matchCase: true,
				addedBy: expect.objectContaining({ name: expect.any(String) }),
			}),
			expect.objectContaining({
				term: "Party Platter XL",
				site: { id: site.siteId, name: "Acme Bakery" },
				matchCase: false,
			}),
		]);
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 50 });
		expect(entries.find((entry) => entry.action === "protectedTerm.add")).toMatchObject({
			workspaceId: site.workspaceId,
			siteId: site.siteId,
		});

		const [workspaceTerm] = terms;
		await site.editor.api.protectedTerms.remove({ workspaceId: site.workspaceId, termId: workspaceTerm?.id ?? "" });
		expect(
			(await site.owner.api.protectedTerms.list({ workspaceId: site.workspaceId, siteId: site.siteId })).terms,
		).toEqual([expect.objectContaining({ term: "Party Platter XL" })]);
	});

	test("Authors can't change them; a term can't hold a marker or be empty", async () => {
		const site = await translatedSite(install, { it: "review" });
		await expect(
			site.author.api.protectedTerms.add({
				workspaceId: site.workspaceId,
				siteId: site.siteId,
				terms: [{ term: "Acme", matchCase: true }],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			site.author.api.protectedTerms.add({
				workspaceId: site.workspaceId,
				siteId: null,
				terms: [{ term: "Acme", matchCase: true }],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		for (const [term, reason] of [
			["   ", "empty"],
			["Acme ⟦T1⟧", "characters"],
		] as const) {
			await expect(
				site.owner.api.protectedTerms.add({
					workspaceId: site.workspaceId,
					siteId: null,
					terms: [{ term, matchCase: true }],
				}),
			).rejects.toMatchObject({ code: "PROTECTED_TERM_INVALID", data: { index: 0, reason } });
		}
	});
});

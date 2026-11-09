// Only text is sent to an AI provider: a rich text value's and a Block's text as pieces with markers
// where their formatting goes, a link's text, a video's title, SEO titles and descriptions. Never
// markup, addresses, ids, Media, code or shared values. A per-Site translation cache keeps unchanged
// text from being sent twice.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { freshBread, requestsInto, translatedSite } from "./support.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

/** Every text sent into a language so far, from the requests made after `from`. */
function sentInto(language: string, from = 0): string[] {
	return requestsInto(install, language)
		.slice(from)
		.flatMap((request) => request.texts);
}

describe("only text", () => {
	test("formatting, links and addresses never leave; their text does, and comes back in place", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		await site.owner.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			seo: {
				title: "Fresh bread at Acme",
				description: "Sourdough baked daily.",
				canonical: "https://acme.example/bread",
			},
			fields: {
				body: [
					{ id: "p1", type: "paragraph", text: "Our loaves rise overnight." },
					{ id: "p2", type: "paragraph", text: [{ text: "Bake at " }, { text: "220 °C", marks: ["bold"] }] },
					{ id: "c1", type: "code", code: "const oven = 220;" },
					{ id: "v1", type: "video", url: "https://www.youtube.com/watch?v=abc123def45", title: "Shaping a loaf" },
					{ id: "d1", type: "divider" },
				],
			},
		});
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		expect((await install.drainJobs()).failed).toEqual([]);

		const sent = sentInto("it");
		expect(sent).toEqual(
			expect.arrayContaining([
				"Fresh bread",
				"Crusty sourdough",
				"Baked ⟦1⟧every⟦/1⟧ morning, see ⟦2⟧the menu⟦/2⟧.",
				"Our loaves rise overnight.",
				"Bake at ⟦1⟧220 °C⟦/1⟧",
				"Shaping a loaf",
				"Order now",
				"Fresh bread at Acme",
				"Sourdough baked daily.",
			]),
		);
		const everything = sent.join("\n");
		for (const never of ["<", "acme.example", "youtube", "const oven", "fresh-bread", "p1", "220;"]) {
			expect(everything).not.toContain(never);
		}

		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" });
		expect(entry.draft.fields.intro).toBe(
			'<p>[it] Baked <strong>every</strong> morning, see <a href="https://acme.example/menu">the menu</a>.</p>',
		);
		expect(entry.draft.fields.cta).toEqual({ url: "https://acme.example/order", text: "[it] Order now" });
		expect(entry.draft.seo).toMatchObject({
			title: "[it] Fresh bread at Acme",
			description: "[it] Sourdough baked daily.",
			canonical: "https://acme.example/bread",
		});
		const body = entry.draft.fields.body as {
			id: string;
			type: string;
			text?: unknown;
			code?: string;
			url?: string;
			title?: string;
			source?: unknown;
		}[];
		expect(body.map((block) => block.type)).toEqual(["paragraph", "paragraph", "code", "video", "divider"]);
		expect(body[1]?.text).toEqual([{ text: "[it] Bake at " }, { text: "220 °C", marks: ["bold"] }]);
		expect(body[2]?.code).toBe("const oven = 220;");
		expect(body[3]).toMatchObject({ url: "https://www.youtube.com/watch?v=abc123def45", title: "[it] Shaping a loaf" });
		// Each Block of the translation names the Block it translates, and that the AI wrote it.
		expect(body[0]?.source).toMatchObject({ id: "p1", by: "ai" });
	});

	test("an answer that loses a marker is refused: nothing is written, the work says why", async () => {
		const site = await translatedSite(install, { it: "review" });
		const entryId = await freshBread(site);
		install.ai.translateWith((text, request) => `[${request.to.code}] ${text.replace(/⟦\/?\d+⟧/g, "")}`);
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();

		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "it" });
		expect(entry.draft.title).toBe("Fresh bread");
		expect(entry.translation?.aiWritten).toEqual([]);
		expect((await site.owner.api.translations.overview({ siteId: site.siteId })).languages[0]?.waiting).toEqual([
			{ reason: "answer", count: 1 },
		]);
	});
});

describe("the translation cache", () => {
	test("unchanged text is never sent twice; a changed paragraph is the only text sent again", async () => {
		const site = await translatedSite(install, { de: "automatic" });
		const entryId = await freshBread(site);
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		await install.drainJobs();
		const first = requestsInto(install, "de").length;
		expect(first).toBeGreaterThan(0);

		// Published again unchanged: every translation is current, nothing is asked.
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		await install.drainJobs();
		expect(requestsInto(install, "de").length).toBe(first);

		await site.owner.api.entries.saveDraft({
			siteId: site.siteId,
			entryId,
			fields: {
				body: [
					{ id: "p1", type: "paragraph", text: "Our loaves rise slowly overnight." },
					{ id: "p2", type: "paragraph", text: [{ text: "Bake at " }, { text: "220 °C", marks: ["bold"] }] },
				],
			},
		});
		await site.owner.api.entries.publish({ siteId: site.siteId, entryId });
		await install.drainJobs();
		expect(sentInto("de", first)).toEqual(["Our loaves rise slowly overnight."]);

		const { entry } = await site.owner.api.entries.get({ siteId: site.siteId, entryId, language: "de" });
		const body = entry.published?.fields.body as { text: unknown }[];
		expect(body.map((block) => block.text)).toEqual([
			[{ text: "[de] Our loaves rise slowly overnight." }],
			[{ text: "[de] Bake at " }, { text: "220 °C", marks: ["bold"] }],
		]);
	});

	test("the same text in another Entry comes from the cache", async () => {
		const site = await translatedSite(install, { it: "review" });
		await freshBread(site, "Fresh bread");
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		const before = requestsInto(install, "it").length;

		await freshBread(site, "Fresh bread");
		await site.owner.api.translations.translateNow({ siteId: site.siteId });
		await install.drainJobs();
		expect(requestsInto(install, "it").length).toBe(before);
		const { usage } = await site.owner.api.translations.overview({ siteId: site.siteId });
		expect(usage.cacheHits).toBe(50);
	});
});

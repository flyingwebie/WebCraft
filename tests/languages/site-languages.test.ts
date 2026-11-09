// A Site's languages (Structure): its Default language, and the others Staff add, each with a BCP 47
// code, the name visitors see and a text direction. Members see them; only Staff change them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let owner: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;
async function newSite(): Promise<string> {
	return (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `languages-${++sites}` })).id;
}

const english = { code: "en", name: "English", direction: "ltr", domain: null, prefix: null, default: true } as const;

describe("a Site's languages", () => {
	test("a new Site has one language, its Default language, English", async () => {
		const siteId = await newSite();

		expect(await owner.api.languages.list({ siteId })).toEqual({
			settings: { defaultLanguage: "en", browserLanguageRedirect: false, languages: [english] },
		});
	});

	test("Staff add languages: the code is a BCP 47 tag in its canonical form, the name and direction follow from it", async () => {
		const siteId = await newSite();

		await staff.api.languages.add({ siteId, code: "fr" });
		await staff.api.languages.add({ siteId, code: "PT-br" });
		const { settings } = await staff.api.languages.add({ siteId, code: "ar" });

		expect(settings.languages).toEqual<unknown[]>([
			english,
			{ code: "fr", name: "Français", direction: "ltr", domain: null, prefix: "fr", default: false },
			{ code: "pt-BR", name: "Português (Brasil)", direction: "ltr", domain: null, prefix: "pt-br", default: false },
			{ code: "ar", name: "العربية", direction: "rtl", domain: null, prefix: "ar", default: false },
		]);
	});

	test("Staff may give the name, the direction and a domain of the language's own", async () => {
		const siteId = await newSite();

		const { settings } = await staff.api.languages.add({
			siteId,
			code: "he",
			name: "  Ivrit ",
			direction: "ltr",
			domain: "Acme-Bakery.co.il",
		});
		expect(settings.languages[1]).toEqual({
			code: "he",
			name: "Ivrit",
			direction: "ltr",
			domain: "acme-bakery.co.il",
			prefix: "he",
			default: false,
		});

		const updated = await staff.api.languages.update({
			siteId,
			code: "he",
			name: "עברית",
			direction: "rtl",
			domain: null,
		});
		expect(updated.settings.languages[1]).toMatchObject({ name: "עברית", direction: "rtl", domain: null });
	});

	test("refuses a code that isn't a language tag, a language the Site has, and a domain another language has", async () => {
		const siteId = await newSite();
		for (const code of ["french", "f", "en_GB", "x-private", "en-u-ca-gregory", "_fr", "de-1996-foo"]) {
			await expect(staff.api.languages.add({ siteId, code })).rejects.toMatchObject({
				code: "LANGUAGE_INVALID",
				data: { problems: [{ at: "code" }] },
			});
		}
		await expect(staff.api.languages.add({ siteId, code: "EN" })).rejects.toMatchObject({
			code: "LANGUAGE_TAKEN",
			data: { field: "code" },
		});
		await expect(staff.api.languages.add({ siteId, code: "it", name: " " })).rejects.toMatchObject({
			code: "LANGUAGE_INVALID",
			data: { problems: [{ at: "name" }] },
		});
		await expect(staff.api.languages.add({ siteId, code: "it", domain: "not a domain" })).rejects.toMatchObject({
			code: "LANGUAGE_INVALID",
			data: { problems: [{ at: "domain" }] },
		});

		await staff.api.languages.add({ siteId, code: "it", domain: "acme.it" });
		const other = await newSite();
		await expect(staff.api.languages.add({ siteId: other, code: "it", domain: "ACME.it" })).rejects.toMatchObject({
			code: "LANGUAGE_TAKEN",
			data: { field: "domain" },
		});
		await expect(staff.api.languages.update({ siteId, code: "de", name: "Deutsch" })).rejects.toMatchObject({
			code: "LANGUAGE_NOT_FOUND",
		});
	});

	test("Members see the languages; only Staff change them", async () => {
		const siteId = await newSite();

		await expect(owner.api.languages.add({ siteId, code: "fr" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.api.languages.update({ siteId, code: "en", name: "Inglese" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("each change is recorded in the Audit log", async () => {
		const siteId = await newSite();

		await staff.api.languages.add({ siteId, code: "fr" });
		await staff.api.languages.update({ siteId, code: "fr", name: "French" });

		const { entries } = await admin.api.audit.list({ limit: 2 });
		expect(entries.reverse().map(({ action, details, siteId: site }) => ({ action, details, site }))).toEqual([
			{
				action: "language.add",
				details: { code: "fr", name: "Français", direction: "ltr", domain: null },
				site: siteId,
			},
			{ action: "language.update", details: { code: "fr", changed: ["name"] }, site: siteId },
		]);
	});
});

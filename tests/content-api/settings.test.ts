// Site settings › Content API as the Management API serves it: Staff only (`structure.edit`), each
// change applying at once and recorded in the Audit log (never a key itself), callable by Staff's API
// tokens too (making a key isn't a Sensitive action: it reads only what the Site publishes).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
let siteId: string;
let origin: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	origin = await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("who", () => {
	test("Staff only: Owners and Editors may neither read nor change it", async () => {
		const { key } = await staff.api.contentApi.keys.create({ siteId, name: "Staff's" });
		for (const member of [owner, editor]) {
			await expect(member.api.contentApi.get({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(member.api.contentApi.update({ siteId, enabled: true })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(member.api.contentApi.keys.create({ siteId, name: "Mine" })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(member.api.contentApi.keys.update({ siteId, keyId: key.id, name: "Mine" })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(member.api.contentApi.keys.revoke({ siteId, keyId: key.id })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
		}
	});

	test("Staff's API tokens may change it (not a Sensitive action), and the key is answered to them once", async () => {
		const { secret } = await createApiToken(staff, { workspaceId, name: "Deploy" });
		const script = tokenClient(install, secret);

		const made = await script.api.contentApi.keys.create({
			siteId,
			name: "From a script",
			origins: ["https://app.example"],
		});
		expect(made.secret).toMatch(/^webcraft-ck_/);
		expect((await script.api.contentApi.get({ siteId })).keys.map((key) => key.name)).toContain("From a script");
	});
});

describe("the settings", () => {
	test("off by default, nothing hidden, no keys; where frontends call it: its main address and its Staging address", async () => {
		const otherSiteId = (await install.createSite(workspaceId, { name: "Acme Cafe", slug: "cafe" })).id;

		expect(await staff.api.contentApi.get({ siteId: otherSiteId })).toEqual({
			enabled: false,
			hidden: { postTypes: [], fields: {}, globals: [] },
			keys: [],
			addresses: { main: "https://cafe.sites.test/_content/v1", staging: "https://cafe.sites.test/_content/v1" },
		});
		expect((await staff.api.contentApi.get({ siteId })).addresses).toEqual({
			main: `${origin}/_content/v1`,
			staging: "https://bakery.sites.test/_content/v1",
		});
	});

	test("a key's name has 1 to 100 characters, a key unknown to the Site is not found", async () => {
		for (const name of ["", " ", "x".repeat(101)]) {
			await expect(staff.api.contentApi.keys.create({ siteId, name })).rejects.toMatchObject({
				code: "CONTENT_API_INVALID",
				data: { problems: [expect.objectContaining({ at: "name", rule: "contentKeyName" })] },
			});
		}
		await expect(staff.api.contentApi.keys.revoke({ siteId, keyId: crypto.randomUUID() })).rejects.toMatchObject({
			code: "CONTENT_KEY_NOT_FOUND",
		});
	});

	test("Staff see who made each key and when, its hint and its status; revoked keys stay listed", async () => {
		const { key, secret } = await staff.api.contentApi.keys.create({ siteId, name: "Listed" });
		await staff.api.contentApi.keys.revoke({ siteId, keyId: key.id });

		const listed = (await staff.api.contentApi.get({ siteId })).keys.find((found) => found.id === key.id);
		expect(listed).toMatchObject({
			name: "Listed",
			hint: secret.slice(-4),
			status: "revoked",
			createdBy: { name: expect.any(String) },
			lastUsedAt: null,
		});
		expect(listed?.revokedAt).not.toBeNull();
	});
});

describe("the Audit log", () => {
	test("records switching it on, what is hidden, and each key made, changed and revoked, never a key itself", async () => {
		const postTypeId = (
			await staff.api.postTypes.create({ siteId, name: "Blog", key: "blog", urlPattern: "/blog/{slug}" })
		).postType.id;
		await staff.api.contentApi.update({ siteId, enabled: true, hidden: { postTypes: [postTypeId] } });
		const { key, secret } = await staff.api.contentApi.keys.create({
			siteId,
			name: "Audited",
			origins: ["https://a.example"],
		});
		await staff.api.contentApi.keys.update({
			siteId,
			keyId: key.id,
			name: "Audited app",
			origins: ["https://b.example"],
		});
		await staff.api.contentApi.keys.revoke({ siteId, keyId: key.id });

		const { entries } = await staff.api.audit.list({ workspaceId, siteId });
		const ours = entries.filter((entry) => entry.action.startsWith("content"));
		expect(ours.map((entry) => entry.action).slice(0, 4)).toEqual([
			"contentKey.revoke",
			"contentKey.update",
			"contentKey.create",
			"contentApi.change",
		]);
		expect(ours[3]?.details).toMatchObject({ enabled: { from: false, to: true }, postTypes: [postTypeId] });
		expect(ours[2]?.details).toEqual({ keyId: key.id, name: "Audited", origins: ["https://a.example"] });
		expect(ours[1]?.details).toMatchObject({
			changed: {
				name: { from: "Audited", to: "Audited app" },
				origins: { from: ["https://a.example"], to: ["https://b.example"] },
			},
		});
		expect(JSON.stringify(entries)).not.toContain(secret);
		expect(await install.tablesHolding(secret)).toEqual([]);
	});
});

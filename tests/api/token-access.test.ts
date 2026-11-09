// What an API token reaches: what its person may do now, and never more; only its Workspace, and
// there only its Sites; reads only when it is read-only; never a Sensitive action; never the
// admin's own procedures.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModuleApi } from "@webcraft/module-sdk";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { sample } from "../modules/sample/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
});

afterAll(async () => {
	await install.close();
});

/** A Workspace with two Sites, and another Workspace with one. */
async function workspaces() {
	const ours = await install.createWorkspace();
	const first = await install.createSite(ours.id);
	const second = await install.createSite(ours.id);
	const theirs = await install.createWorkspace();
	const theirSite = await install.createSite(theirs.id);
	return { ours, first, second, theirs, theirSite };
}

describe("acting as its person", () => {
	test("an Editor's token edits Content but never Structure, as the Editor can't", async () => {
		const { ours, first } = await workspaces();
		const admin = await install.superadmin();
		const { postType } = await admin.api.postTypes.create({
			siteId: first.id,
			name: "Posts",
			urlPattern: "/posts/{slug}",
		});
		const editor = await install.createMember({ workspaceId: ours.id, role: "editor" });
		const { secret } = await createApiToken(editor.browser, { workspaceId: ours.id, name: "Editor's script" });
		const script = tokenClient(install, secret);

		const { entry } = await script.api.entries.create({
			siteId: first.id,
			postTypeId: postType.id,
			title: "From a script",
		});
		expect(entry.draft.title).toBe("From a script");
		await expect(
			script.api.postTypes.create({ siteId: first.id, name: "Pages two", urlPattern: "/two/{slug}" }),
		).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
	});
});

describe("one Workspace", () => {
	test("even the Superadmin's token never reaches another Workspace", async () => {
		const { ours, first, theirs, theirSite } = await workspaces();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: ours.id, name: "Ours only" });
		const script = tokenClient(install, secret);

		const { workspaces: listed } = await script.api.workspaces.list();
		expect(listed.map((workspace) => workspace.id)).toEqual([ours.id]);
		await script.api.sites.get({ siteId: first.id });

		await expect(script.api.workspaces.get({ workspaceId: theirs.id })).rejects.toMatchObject({ status: 404 });
		await expect(script.api.sites.list({ workspaceId: theirs.id })).rejects.toMatchObject({ status: 404 });
		await expect(script.api.sites.get({ siteId: theirSite.id })).rejects.toMatchObject({ status: 404 });
		await expect(
			script.api.sites.create({ workspaceId: theirs.id, name: "Elsewhere", slug: "elsewhere-by-token" }),
		).rejects.toMatchObject({ status: 404 });
	});

	test("a token for some Sites reaches only those, and nothing else of the Workspace but seeing it", async () => {
		const { ours, first, second } = await workspaces();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: ours.id, name: "First Site", sites: [first.id] });
		const script = tokenClient(install, secret);

		await script.api.sites.get({ siteId: first.id });
		await script.api.workspaces.get({ workspaceId: ours.id });
		const { sites } = await script.api.sites.list({ workspaceId: ours.id });
		expect(sites.map((site) => site.id)).toEqual([first.id]);

		await expect(script.api.sites.get({ siteId: second.id })).rejects.toMatchObject({ status: 404 });
		await expect(
			script.api.sites.create({ workspaceId: ours.id, name: "More", slug: "more-by-site-token" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(script.api.members.list({ workspaceId: ours.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("read-only tokens", () => {
	test("a read-only token reads, and every write is refused before it runs", async () => {
		const { ours, first } = await workspaces();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: ours.id, name: "Reader", readOnly: true });
		const script = tokenClient(install, secret);
		const notes = script.api.m.sample as unknown as ModuleApi<typeof sample>;

		await script.api.postTypes.list({ siteId: first.id });
		await notes.notes.list({ siteId: first.id });

		for (const write of [
			() => script.api.postTypes.create({ siteId: first.id, name: "Posts", urlPattern: "/posts/{slug}" }),
			() => script.api.sites.create({ workspaceId: ours.id, name: "More", slug: "more-by-reader" }),
			() => notes.notes.add({ siteId: first.id, body: "A note" }),
		]) {
			await expect(write()).rejects.toMatchObject({ code: "TOKEN_READ_ONLY", status: 403 });
		}
		const { postTypes } = await script.api.postTypes.list({ siteId: first.id });
		expect(postTypes.filter((postType) => postType.name === "Posts")).toEqual([]);
	});
});

describe("what a token never does", () => {
	test("Sensitive actions are refused for tokens, whoever made them", async () => {
		const { ours, first } = await workspaces();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: ours.id, name: "Ambitious" });
		const script = tokenClient(install, secret);

		await expect(
			script.api.members.invite({ workspaceId: ours.id, email: "new@client.example", role: "owner", sites: "all" }),
		).rejects.toMatchObject({ code: "SENSITIVE_ACTION_REFUSED", status: 403, data: { action: "member.invite" } });
		await expect(
			script.api.webhooks.add({ siteId: first.id, url: "https://hooks.agency.example/x", events: ["publish"] }),
		).rejects.toMatchObject({ code: "SENSITIVE_ACTION_REFUSED", data: { action: "webhook.change" } });
		const { webhooks } = await admin.api.webhooks.list({ siteId: first.id });
		expect(webhooks).toEqual([]);
	});

	test("the admin's own procedures aren't served at /api/v1", async () => {
		const { ours } = await workspaces();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: ours.id, name: "Explorer" });
		const script = tokenClient(install, secret);

		for (const internal of [
			() => script.api.install.settings.get(),
			() => script.api.me.sessions.list(),
			() => script.api.staff.list(),
			() => script.api.audit.list({ limit: 5 }),
			() => script.api.session.current(),
			() => script.api.shell.context(),
			() => script.api.workspaces.create({ name: "By a token" }),
		]) {
			await expect(internal()).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
		}
	});

	test("Module procedures are public, within the token's limits", async () => {
		const { ours, first, theirSite } = await workspaces();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: ours.id, name: "Notes script" });
		const notes = (tokenClient(install, secret).api.m.sample as unknown as ModuleApi<typeof sample>).notes;

		await notes.add({ siteId: first.id, body: "Through the API" });
		const { notes: listed } = await notes.list({ siteId: first.id });
		expect(listed.map((note: { body: string }) => note.body)).toContain("Through the API");
		await expect(notes.list({ siteId: theirSite.id })).rejects.toMatchObject({ status: 404 });
	});
});

describe("uploads", () => {
	test("a script uploads Media with multipart form data", async () => {
		const { ours, first } = await workspaces();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: ours.id, name: "Uploader" });

		const { media } = await tokenClient(install, secret).api.media.upload({
			siteId: first.id,
			file: upload(await photo({ width: 40, height: 30 }), "bread.jpg", "image/jpeg"),
		});

		expect(media).toMatchObject({ fileName: "bread.jpg" });
		const { items } = await admin.api.media.list({ siteId: first.id });
		expect(items.map((file) => file.id)).toEqual([media.id]);
	});
});

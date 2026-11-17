// The Media place's ground on the server (ADR 0037, BA-22): what the admin's Media screen changes, the
// building area changes from the Site's own address, with the same Permissions and the same two steps
// for the Trash; the shell starts knowing what the person may do with Media.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MEDIA_IMPORT_LIMITS } from "@webcraft/core";

import { type BuildingAreaApi, buildingAreaApi } from "../harness/building-area-api.ts";
import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let siteId: string;
let editorArea: BuildingAreaApi;
let authorArea: BuildingAreaApi;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await staff.api.languages.add({ siteId, code: "it" });
	editorArea = buildingAreaApi(install, await openBuildingArea(install, editor, siteId));
	authorArea = buildingAreaApi(install, await openBuildingArea(install, author, siteId));
	install.dns.answer("photos.example", ["93.184.216.34"]);
});

afterAll(async () => {
	await install.close();
});

/** A small JPEG uploaded through the building area by the person whose area it is. */
async function uploaded(area: BuildingAreaApi, name: string, folderId?: string) {
	const { media } = await area.api.media.upload({
		siteId,
		file: upload(await photo({ width: 40, height: 30 }), name),
		...(folderId ? { folderId } : {}),
	});
	await install.drainJobs();
	return media;
}

describe("the shell's ground", () => {
	test("the shell knows what the person may do with Media", async () => {
		const read = async (person: TestBrowser) => {
			const building = await openBuildingArea(install, person, siteId);
			return shellConfigIn(await (await building.shell(building.landed)).text()) as
				| { permissions: string[]; adminMessages: { media: { folders: { all: string } } } }
				| undefined;
		};

		expect((await read(editor))?.permissions).toEqual(expect.arrayContaining(["media.upload", "media.manage"]));
		const forAuthor = (await read(author))?.permissions ?? [];
		expect(forAuthor).toContain("media.upload");
		expect(forAuthor).not.toContain("media.manage");
		// The reused admin parts read the admin's own words for Media, in the person's Admin language.
		expect((await read(editor))?.adminMessages.media.folders.all).toBe("All files");
	});

	test("Media places are addresses of the shell", async () => {
		const building = await openBuildingArea(install, staff, siteId);
		const { folder } = await staff.api.media.folders.create({ siteId, name: "Breads" });
		for (const place of ["media", "media%2Funfiled", "media%2Ftrash", `media%2F${folder.id}`]) {
			const response = await building.shell(`/_webcraft/build/page/?wc-place=${place}&wc-view=view%3Dgrid`);
			expect(response.status).toBe(200);
			expect(shellConfigIn(await response.text())?.page).toBe("/");
		}
	});
});

describe("a Member changes the Media library from the Site's address, as in the admin", () => {
	test("a file's alt text in each language, its folder and its Focal point", async () => {
		const { folder } = await editorArea.api.media.folders.create({ siteId, name: "Cakes" });
		const media = await uploaded(editorArea, "cake.jpg");

		await editorArea.api.media.update({ siteId, mediaId: media.id, alt: "A celebration cake" });
		await editorArea.api.media.update({ siteId, mediaId: media.id, language: "it", alt: "Una torta" });
		await editorArea.api.media.update({ siteId, mediaId: media.id, folderId: folder.id, focalPoint: { x: 30, y: 70 } });

		const english = (await staff.api.media.get({ siteId, mediaId: media.id })).media;
		const italian = (await staff.api.media.get({ siteId, mediaId: media.id, language: "it" })).media;
		expect(english).toMatchObject({ alt: "A celebration cake", folderId: folder.id, focalPoint: { x: 30, y: 70 } });
		expect(italian.alt).toBe("Una torta");

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
		const updated = entries.find((entry) => entry.siteId === siteId && entry.action === "media.update");
		expect(updated).toMatchObject({ via: { kind: "editMode" } });
	});

	test("folders: made, renamed and deleted, their files kept", async () => {
		const { folder } = await editorArea.api.media.folders.create({ siteId, name: "Team" });
		const media = await uploaded(editorArea, "team.jpg", folder.id);

		await editorArea.api.media.folders.rename({ siteId, folderId: folder.id, name: "Our team" });
		expect((await staff.api.media.folders.list({ siteId })).folders.map((each) => each.name)).toContain("Our team");

		await editorArea.api.media.folders.delete({ siteId, folderId: folder.id });
		expect((await staff.api.media.folders.list({ siteId })).folders.map((each) => each.id)).not.toContain(folder.id);
		expect((await staff.api.media.get({ siteId, mediaId: media.id })).media.folderId).toBeNull();
	});

	test("folders: A–Z or the Site's own order, arranged from the place (FX-03)", async () => {
		const { folder: first } = await editorArea.api.media.folders.create({ siteId, name: "Zeta" });
		const { folder: second } = await editorArea.api.media.folders.create({ siteId, name: "Alpha" });
		await editorArea.api.media.folders.setOrder({ siteId, order: "custom" });
		await editorArea.api.media.folders.reorder({ siteId, folderIds: [first.id, second.id] });
		const listed = await staff.api.media.folders.list({ siteId });
		expect(listed.order).toBe("custom");
		expect(listed.folders.map((each) => each.name).slice(0, 2)).toEqual(["Zeta", "Alpha"]);
		await editorArea.api.media.folders.setOrder({ siteId, order: "name" });
		expect((await staff.api.media.folders.list({ siteId })).order).toBe("name");
	});

	test("Replace file keeps the file's id", async () => {
		const media = await uploaded(editorArea, "loaf.jpg");

		const { media: replaced } = await editorArea.api.media.replace({
			siteId,
			mediaId: media.id,
			file: upload(await photo({ width: 60, height: 40 }), "loaf-2.jpg"),
		});
		await install.drainJobs();

		expect(replaced.id).toBe(media.id);
		expect((await staff.api.media.get({ siteId, mediaId: media.id })).media.width).toBe(60);
	});

	test("Import from URL goes through the guarded fetcher", async () => {
		install.http.respond("GET", "https://photos.example/rye.jpg", {
			body: await photo({ width: 20, height: 20 }),
			headers: { "content-type": "image/jpeg" },
		});
		await install.clock.advance(MEDIA_IMPORT_LIMITS.person.windowMs);

		const { media } = await editorArea.api.media.importUrl({ siteId, url: "https://photos.example/rye.jpg" });

		expect(media.fileName).toBe("rye.jpg");
		const refused = editorArea.api.media.importUrl({ siteId, url: "http://127.0.0.1/a.jpg" });
		expect(await rejection(refused)).toMatchObject({ code: "MEDIA_IMPORT_REFUSED" });
	});

	test("the Trash: two steps in, Restore, two steps to delete for good, two steps to empty", async () => {
		const first = await uploaded(editorArea, "first.jpg");
		const second = await uploaded(editorArea, "second.jpg");

		// Nothing moves without the confirmation the first call answers.
		const asked = await editorArea.api.media.delete({ siteId, mediaId: first.id });
		expect(asked.trashed).toBe(false);
		expect((await staff.api.media.get({ siteId, mediaId: first.id })).media.trashedAt).toBeNull();
		if (asked.trashed) throw new Error("Moved without asking.");
		await editorArea.api.media.delete({ siteId, mediaId: first.id, confirmation: asked.confirmation.id });
		expect((await staff.api.media.list({ siteId, trash: true })).items.map((item) => item.id)).toContain(first.id);

		await editorArea.api.media.restore({ siteId, mediaId: first.id });
		expect((await staff.api.media.get({ siteId, mediaId: first.id })).media.trashedAt).toBeNull();

		for (const media of [first, second]) {
			const ask = await editorArea.api.media.delete({ siteId, mediaId: media.id });
			if (ask.trashed) throw new Error("Moved without asking.");
			await editorArea.api.media.delete({ siteId, mediaId: media.id, confirmation: ask.confirmation.id });
		}
		const forGood = await editorArea.api.media.deleteForever({ siteId, mediaId: first.id });
		if (forGood.deleted) throw new Error("Deleted without asking.");
		expect((await staff.api.media.list({ siteId, trash: true })).items.map((item) => item.id)).toContain(first.id);
		await editorArea.api.media.deleteForever({ siteId, mediaId: first.id, confirmation: forGood.confirmation.id });
		expect((await staff.api.media.list({ siteId, trash: true })).items.map((item) => item.id)).not.toContain(first.id);

		const emptying = await editorArea.api.media.emptyTrash({ siteId });
		if (emptying.emptied) throw new Error("Emptied without asking.");
		expect(emptying.count).toBeGreaterThanOrEqual(1);
		await editorArea.api.media.emptyTrash({ siteId, confirmation: emptying.confirmation.id });
		expect((await staff.api.media.list({ siteId, trash: true })).items).toEqual([]);
	});
});

describe("an Author, as in the admin", () => {
	test("changes their own uploads, but not another's, and not the folders", async () => {
		const own = await uploaded(authorArea, "own.jpg");
		const theirs = await uploaded(editorArea, "theirs.jpg");

		await authorArea.api.media.update({ siteId, mediaId: own.id, alt: "Mine" });
		expect((await staff.api.media.get({ siteId, mediaId: own.id })).media.alt).toBe("Mine");

		for (const call of [
			() => authorArea.api.media.update({ siteId, mediaId: theirs.id, alt: "Not mine" }),
			() => authorArea.api.media.folders.create({ siteId, name: "Mine" }),
			() => authorArea.api.media.folders.setOrder({ siteId, order: "custom" }),
			() => authorArea.api.media.folders.reorder({ siteId, folderIds: [] }),
			() => authorArea.api.media.emptyTrash({ siteId }),
		]) {
			const refused = await call().then(
				() => null,
				(error: unknown) => error,
			);
			expect(refused).toMatchObject({ status: 403 });
		}
		expect((await staff.api.media.get({ siteId, mediaId: theirs.id })).media.alt).toBeNull();
	});
});

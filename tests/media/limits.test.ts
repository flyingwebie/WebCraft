// The Media library's limits: the largest file an Install takes (an Install setting), and a
// Workspace's optional storage quota, with its 80% warning and uploads refused once it is full.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { pdf, upload } from "../harness/images.ts";
import { API_PATH, createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const KB = 1024;
const MB = 1024 * KB;

let install: TestInstall;
let admin: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
});

afterAll(async () => {
	await install.close();
});

/** A PDF of exactly `size` bytes. */
function pdfOf(size: number, text = "padding"): Uint8Array {
	const bytes = new Uint8Array(size);
	bytes.set(pdf(text).subarray(0, Math.min(size, 64)));
	return bytes;
}

describe("the largest file", () => {
	test("is 50 MB unless the Superadmin sets another, and uploads over it are refused", async () => {
		const workspaceId = (await install.createWorkspace()).id;
		const siteId = (await install.createSite(workspaceId)).id;

		expect(await admin.api.install.media.get()).toEqual({ maxFileBytes: 50 * MB });

		expect(await admin.api.install.media.update({ maxFileBytes: 2 * MB })).toEqual({ maxFileBytes: 2 * MB });
		await expect(admin.api.media.upload({ siteId, file: upload(pdfOf(2 * MB + 1), "big.pdf") })).rejects.toMatchObject({
			code: "MEDIA_TOO_LARGE",
			status: 413,
			data: { maxBytes: 2 * MB },
		});
		const { media } = await admin.api.media.upload({ siteId, file: upload(pdfOf(2 * MB), "fits.pdf") });
		expect(media.sizeBytes).toBe(2 * MB);

		const { media: overview } = { media: await admin.api.media.overview({ siteId }) };
		expect(overview.maxFileBytes).toBe(2 * MB);

		const { entries } = await admin.api.audit.list({});
		expect(entries.find((entry) => entry.action === "mediaMaxFileSize.change")).toMatchObject({
			details: { maxFileBytes: 2 * MB },
		});

		await admin.api.install.media.update({ maxFileBytes: 50 * MB });
	});

	test("only the Superadmin changes it, between 1 MB and 1 GB", async () => {
		const workspaceId = (await install.createWorkspace()).id;
		const { browser: staff } = await install.createStaff({ workspaces: [workspaceId] });
		await expect(staff.api.install.media.update({ maxFileBytes: 10 * MB })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(admin.api.install.media.update({ maxFileBytes: MB - 1 })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(admin.api.install.media.update({ maxFileBytes: 1024 * MB + 1 })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("an upload declaring more than the limit is refused before its body is read", async () => {
		let pulled = 0;
		// A body that would go on for ever: the answer must come without reading it.
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += MB;
				controller.enqueue(new Uint8Array(MB));
			},
		});
		const response = await admin.request(install.adminUrl(`${API_PATH}/media/upload`), {
			method: "POST",
			headers: {
				"content-type": "multipart/form-data; boundary=x",
				"content-length": String(400 * MB),
			},
			body,
			// @ts-expect-error: Bun takes a streamed body without `duplex`, browsers need it.
			duplex: "half",
		});
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({
			json: { code: "MEDIA_TOO_LARGE", status: 413, data: { maxBytes: 50 * MB } },
		});
		expect(pulled).toBeLessThanOrEqual(2 * MB);
	});

	test("an upload that doesn't say its length stops being read once it passes the limit", async () => {
		await admin.api.install.media.update({ maxFileBytes: 2 * MB });
		let pulled = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += MB;
				controller.enqueue(new Uint8Array(MB));
			},
		});
		const response = await admin.request(install.adminUrl(`${API_PATH}/media/upload`), {
			method: "POST",
			headers: { "content-type": "multipart/form-data; boundary=x" },
			body,
			// @ts-expect-error: Bun takes a streamed body without `duplex`, browsers need it.
			duplex: "half",
		});
		expect(response.status).toBe(413);
		expect(pulled).toBeLessThanOrEqual(5 * MB);
		await admin.api.install.media.update({ maxFileBytes: 50 * MB });
	});
});

describe("a Workspace's storage quota", () => {
	test("Staff set it; Owners see it but can't change it; none until set", async () => {
		const workspaceId = (await install.createWorkspace()).id;
		const { browser: staff } = await install.createStaff({ workspaces: [workspaceId] });
		const { browser: owner } = await install.createMember({ workspaceId, role: "owner" });

		expect(await owner.api.workspaces.storage({ workspaceId })).toEqual({
			usedBytes: 0,
			quotaBytes: null,
			warning: false,
			full: false,
		});
		await expect(owner.api.workspaces.setQuota({ workspaceId, quotaBytes: 5 * MB })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		expect(await staff.api.workspaces.setQuota({ workspaceId, quotaBytes: 5 * MB })).toMatchObject({
			quotaBytes: 5 * MB,
		});
		expect((await owner.api.workspaces.storage({ workspaceId })).quotaBytes).toBe(5 * MB);
		const { entries } = await admin.api.audit.list({});
		expect(entries.find((entry) => entry.action === "storageQuota.change")).toMatchObject({
			workspaceId,
			details: { from: null, to: 5 * MB },
		});

		expect(await staff.api.workspaces.setQuota({ workspaceId, quotaBytes: null })).toMatchObject({ quotaBytes: null });
		await expect(staff.api.workspaces.setQuota({ workspaceId, quotaBytes: MB - 1 })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("usage counts the bytes stored for every Site of the Workspace, a file stored once counted once", async () => {
		const workspaceId = (await install.createWorkspace()).id;
		const bakery = (await install.createSite(workspaceId)).id;
		const cafe = (await install.createSite(workspaceId)).id;
		const menu = pdfOf(300_000, "menu");

		await admin.api.media.upload({ siteId: bakery, file: upload(menu, "menu.pdf") });
		// The same bytes under the same name share one stored file on the Site.
		await admin.api.media.upload({ siteId: bakery, file: upload(menu, "menu.pdf") });
		await admin.api.media.upload({ siteId: cafe, file: upload(pdfOf(200_000, "prices"), "prices.pdf") });

		expect((await admin.api.workspaces.storage({ workspaceId })).usedBytes).toBe(500_000);
		expect((await admin.api.media.overview({ siteId: cafe })).storage).toEqual({
			usedBytes: 500_000,
			quotaBytes: null,
			warning: false,
			full: false,
		});
	});

	test("at 80% the Workspace's Owners and Staff are told once; an upload that would pass 100% is refused", async () => {
		const workspaceId = (await install.createWorkspace("Quota Ltd")).id;
		const siteId = (await install.createSite(workspaceId)).id;
		const staff = await install.createStaff({ workspaces: [workspaceId], email: "staff.quota@agency.example" });
		await install.createMember({ workspaceId, role: "owner", email: "owner.quota@client.example" });
		const editor = await install.createMember({ workspaceId, role: "editor", email: "editor.quota@client.example" });
		await staff.browser.api.workspaces.setQuota({ workspaceId, quotaBytes: MB });

		await editor.browser.api.media.upload({ siteId, file: upload(pdfOf(700 * KB, "one"), "one.pdf") });
		expect((await editor.browser.api.media.overview({ siteId })).storage).toMatchObject({ warning: false });
		await install.drainJobs();

		await editor.browser.api.media.upload({ siteId, file: upload(pdfOf(150 * KB, "two"), "two.pdf") });
		expect((await editor.browser.api.media.overview({ siteId })).storage).toEqual({
			usedBytes: 850 * KB,
			quotaBytes: MB,
			warning: true,
			full: false,
		});
		for (const address of ["owner.quota@client.example", "staff.quota@agency.example"]) {
			const email = await install.lastEmailTo(address);
			expect(email.subject).toBe("Quota Ltd has used 83% of its Media storage");
			expect(email.text).toContain("850 KB of 1 MB");
		}
		// Told once while it stays over 80%; Editors aren't told.
		await editor.browser.api.media.upload({ siteId, file: upload(pdfOf(50 * KB, "three"), "three.pdf") });
		await install.drainJobs();
		const quotaEmails = install.logs
			.map((entry) => entry.email as { to: string; subject: string } | undefined)
			.filter((email) => email?.subject.startsWith("Quota Ltd has used"))
			.map((email) => email?.to)
			.sort();
		expect(quotaEmails).toEqual(["owner.quota@client.example", "staff.quota@agency.example"]);

		await expect(
			editor.browser.api.media.upload({ siteId, file: upload(pdfOf(200 * KB, "four"), "four.pdf") }),
		).rejects.toMatchObject({
			code: "MEDIA_QUOTA_FULL",
			status: 413,
			data: { usedBytes: 900 * KB, quotaBytes: MB },
		});
		expect((await editor.browser.api.media.list({ siteId })).total).toBe(3);
	});

	test("two uploads at once can't together take a Workspace past its quota", async () => {
		const workspaceId = (await install.createWorkspace()).id;
		const siteId = (await install.createSite(workspaceId)).id;
		await admin.api.workspaces.setQuota({ workspaceId, quotaBytes: MB });

		const answers = await Promise.allSettled([
			admin.api.media.upload({ siteId, file: upload(pdfOf(600 * KB, "left"), "left.pdf") }),
			admin.api.media.upload({ siteId, file: upload(pdfOf(600 * KB, "right"), "right.pdf") }),
		]);

		expect(answers.filter((answer) => answer.status === "fulfilled")).toHaveLength(1);
		const refused = answers.find((answer) => answer.status === "rejected");
		expect(refused?.reason).toMatchObject({ code: "MEDIA_QUOTA_FULL", status: 413 });
		expect((await admin.api.workspaces.storage({ workspaceId })).usedBytes).toBe(600 * KB);
		expect((await admin.api.media.list({ siteId })).total).toBe(1);
	});
});

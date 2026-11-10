// Private Form uploads cross Installs with their Submissions, through real HTTP and the worker.
// The only fake here is the remote object store.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import forms from "@webcraft/module-forms";

import { formVisitor } from "../harness/forms.ts";
import { createFakeS3, createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import {
	exportedArchive,
	exportSite,
	importArchive,
	manifestIn,
	rewritten,
	rowsIn,
	tarFiles,
	tarOf,
	uploadArchive,
} from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";

type Attachment = { uploadId: string; name: string; size: number; contentType: string; url: string };
type Submission = { id: string; formId: string; values: { key: string; value: unknown }[] };
const bytes = new Map([
	["disk.pdf", Buffer.from("%PDF-1.4\nDisk attachment\n%%EOF\n")],
	["bucket.pdf", Buffer.from(`%PDF-1.4\n${"private".repeat(300_000)}\n%%EOF\n`)],
]);

let source: TestInstall;
let sourceAdmin: TestBrowser;
let sourceSiteId: string;
let sourceWorkspaceId: string;
let sourceFormId: string;
let pageUrl: string;
let archive: Uint8Array;
let sourceRemote: ReturnType<typeof bucket>;
let refusal = 0;

function fixtureBytes(name: string): Buffer<ArrayBuffer> {
	const value = bytes.get(name);
	if (!value) throw new Error(`Unknown attachment fixture: ${name}`);
	return value;
}

function mapFiles(values: unknown, change: (file: Record<string, unknown>) => Record<string, unknown>) {
	return (values as { type: string; value: unknown }[]).map((field) => ({
		...field,
		value: field.type === "file" ? (field.value as Record<string, unknown>[]).map(change) : field.value,
	}));
}

function api(browser: TestBrowser) {
	return moduleApi<typeof forms>(browser, "forms");
}

function files(submission: Submission): Attachment[] {
	return submission.values.flatMap((value) => (value.key === "attachment" ? (value.value as Attachment[]) : []));
}

async function approve(install: TestInstall) {
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	return admin;
}

function bucket(install: TestInstall) {
	const settings = {
		endpoint: "https://uploads.storage.test",
		bucket: "private-files",
		region: "eu-west-1",
		accessKeyId: "TESTKEY",
		secretAccessKey: "private-upload-test-secret",
	};
	return {
		fake: createFakeS3(install.http, settings),
		settings: { kind: "s3" as const, ...settings, prefix: "install", pathStyle: true },
	};
}

async function send(name: string, content: Uint8Array) {
	const visitor = formVisitor(source);
	const page = await visitor.open(pageUrl);
	await source.clock.advance(5000);
	expect(
		(await visitor.send(page, {}, { files: { attachment: [{ name, bytes: content, type: "application/pdf" }] } }))
			.status,
	).toBe(303);
	const { submissions } = await api(sourceAdmin).submissions.list({
		siteId: sourceSiteId,
		formId: sourceFormId,
		limit: 1,
	});
	return (await api(sourceAdmin).submissions.get({ siteId: sourceSiteId, id: submissions[0]?.id ?? "" })).submission;
}

beforeAll(async () => {
	source = await createTestInstall({ adminHost: "source.test" });
	sourceAdmin = await approve(source);
	sourceWorkspaceId = (await source.createWorkspace("Source")).id;
	sourceSiteId = (await source.createSite(sourceWorkspaceId, { name: "Applications", slug: "applications" })).id;
	const origin = await goLive(source, sourceSiteId);
	const { form } = await sourceAdmin.api.forms.create({
		siteId: sourceSiteId,
		name: "Application",
		key: "application",
	});
	sourceFormId = form.id;
	await sourceAdmin.api.forms.saveDraft({
		siteId: sourceSiteId,
		formId: form.id,
		form: {
			fields: [{ key: "attachment", type: "file", label: "Attachment", accept: ["pdf"], required: true }],
		},
	});
	await sourceAdmin.api.forms.publish({ siteId: sourceSiteId, formId: form.id });
	const { postType } = await sourceAdmin.api.postTypes.create({
		siteId: sourceSiteId,
		name: "Applications",
		key: "applications",
		urlPattern: "/apply/{slug}",
	});
	const { template } = await sourceAdmin.api.templates.saveEntryTemplateMarkup({
		siteId: sourceSiteId,
		postTypeId: postType.id,
		markup: "<section><h1>{{ title }}</h1>{{@form application}}</section>",
	});
	await sourceAdmin.api.templates.publish({ siteId: sourceSiteId, templateId: template.id });
	const { entry } = await sourceAdmin.api.entries.create({
		siteId: sourceSiteId,
		postTypeId: postType.id,
		title: "Apply",
		slug: "here",
	});
	await sourceAdmin.api.entries.publish({ siteId: sourceSiteId, entryId: entry.id });
	pageUrl = `${origin}/apply/here`;
	await send("disk.pdf", fixtureBytes("disk.pdf"));
	sourceRemote = bucket(source);
	await sourceAdmin.api.install.storage.update(sourceRemote.settings);
	await send("bucket.pdf", fixtureBytes("bucket.pdf"));
	// New files now go to disk; the second attachment must still be read from its recorded bucket.
	await sourceAdmin.api.install.storage.update({ kind: "disk" });
	archive = await exportedArchive(source, sourceAdmin, sourceSiteId);
});

afterAll(async () => {
	await source?.close();
});

test("claimed disk and bucket attachments round-trip into a fresh Install outside its Media quota", async () => {
	const manifest = manifestIn(archive);
	expect(manifest.files).toMatchObject({
		rows: 2,
		bytes: [...bytes.values()].reduce((n, data) => n + data.length, 0),
		mediaBytes: 0,
	});
	expect(tarFiles(archive).filter((file) => file.path.includes("/form-uploads/"))).toHaveLength(2);
	expect(rowsIn(archive, "public.form_uploads")).toHaveLength(2);
	const target = await createTestInstall({ adminHost: "destination.test" });
	try {
		const admin = await approve(target);
		const remote = bucket(target);
		await admin.api.install.storage.update(remote.settings);
		const workspaceId = (await target.createWorkspace("Destination")).id;
		await admin.api.workspaces.setQuota({ workspaceId, quotaBytes: 1024 * 1024 });
		const imported = await importArchive(target, admin, workspaceId, archive, { name: "Imported", slug: "imported" });
		expect(imported.status).toBe("done");
		const siteId = imported.site?.id ?? "";
		const publicOrigin = await goLive(target, siteId);
		const { submissions } = await api(admin).submissions.list({ siteId });
		expect(submissions).toHaveLength(2);
		const originals = rowsIn(archive, "public.form_uploads");
		const sourceUploads = originals.map((row) => row.id);
		const sourceSubmissions = originals.map((row) => row.submission_id);
		const author = (await target.createMember({ workspaceId, role: "author" })).browser;
		const outsider = (await target.createStaff({ workspaces: [] })).browser;
		for (const listed of submissions) {
			expect(sourceSubmissions).not.toContain(listed.id);
			const { submission } = await api(admin).submissions.get({ siteId, id: listed.id });
			expect(submission.formId).not.toBe(sourceFormId);
			for (const file of files(submission)) {
				expect(sourceUploads).not.toContain(file.uploadId);
				expect(file.url).toBe(target.adminUrl(`/api/forms/uploads/${siteId}/${file.uploadId}`));
				expect(file.url).not.toContain("source.test");
				const response = await admin.request(file.url);
				expect(response.status).toBe(200);
				expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtureBytes(file.name));
				expect([...remote.fake.objects.keys()]).toContain(
					`install/${workspaceId}/${siteId}/form-uploads/${file.uploadId}`,
				);
				expect((await target.browser().request(file.url)).status).toBe(404);
				expect((await author.request(file.url)).status).toBe(404);
				expect((await outsider.request(file.url)).status).toBe(404);
				expect((await admin.request(target.adminUrl(`/api/forms/uploads/${siteId}/${sourceUploads[0]}`))).status).toBe(
					404,
				);
				expect((await target.request(`${publicOrigin}/form-uploads/${file.uploadId}`)).status).toBe(404);
			}
			const asked = await api(admin).submissions.delete({ siteId, ids: [listed.id] });
			if (asked.deleted) throw new Error("Expected confirmation before deletion.");
			await api(admin).submissions.delete({ siteId, ids: [listed.id], confirmation: asked.confirmation.id });
			for (const file of files(submission)) expect((await admin.request(file.url)).status).toBe(404);
		}
		expect([...remote.fake.objects.keys()].filter((key) => key.includes("/form-uploads/"))).toEqual([]);
		expect((await admin.api.media.list({ siteId })).total).toBe(0);
	} finally {
		await target.close();
	}
});

test("excluding Submissions excludes their rows and all private attachment bytes", async () => {
	const without = await exportedArchive(source, sourceAdmin, sourceSiteId, { includeSubmissions: false });
	const manifest = manifestIn(without);
	expect(manifest.tables.map((table: { name: string }) => table.name)).not.toContain("m_forms.submissions");
	expect(manifest.tables.map((table: { name: string }) => table.name)).not.toContain("public.form_uploads");
	expect(manifest.leftOut.submissions).toBe(true);
	expect(manifest.files).toMatchObject({ rows: 0, bytes: 0, mediaBytes: 0 });
	expect(tarFiles(without).some((file) => file.path.includes("/form-uploads/"))).toBe(false);
	const workspaceId = (await source.createWorkspace("Without Submissions")).id;
	const imported = await importArchive(source, sourceAdmin, workspaceId, without, {
		name: "Empty inbox",
		slug: "empty-inbox",
	});
	expect(imported.status).toBe("done");
	expect(imported.report?.dropped).toMatchObject({ submissions: true });
	const siteId = imported.site?.id ?? "";
	expect((await api(sourceAdmin).submissions.list({ siteId })).total).toBe(0);
	expect((await sourceAdmin.api.forms.list({ siteId })).forms).toHaveLength(1);
});

test("abandoned writes and detached deletion retries are never exported", async () => {
	await sourceAdmin.api.install.storage.update(sourceRemote.settings);
	const detached = await send("detached.pdf", fixtureBytes("disk.pdf"));
	sourceRemote.fake.fail("DELETE", 503);
	const asked = await api(sourceAdmin).submissions.delete({ siteId: sourceSiteId, ids: [detached.id] });
	if (asked.deleted) throw new Error("Expected confirmation before deletion.");
	await api(sourceAdmin).submissions.delete({
		siteId: sourceSiteId,
		ids: [detached.id],
		confirmation: asked.confirmation.id,
	});
	sourceRemote.fake.fail("PUT", 503);
	const visitor = formVisitor(source);
	const page = await visitor.open(pageUrl);
	await source.clock.advance(5000);
	expect(
		(
			await visitor.send(
				page,
				{},
				{ files: { attachment: [{ name: "abandoned.pdf", bytes: fixtureBytes("disk.pdf") }] } },
			)
		).status,
	).toBe(500);
	await sourceAdmin.api.install.storage.update({ kind: "disk" });
	try {
		const clean = await exportedArchive(source, sourceAdmin, sourceSiteId);
		expect(
			rowsIn(clean, "public.form_uploads")
				.map((row) => row.name)
				.sort(),
		).toEqual(["bucket.pdf", "disk.pdf"]);
		expect(manifestIn(clean).files.rows).toBe(2);
		for (const file of files(detached))
			expect(tarFiles(clean).some((entry) => entry.path.endsWith(file.uploadId))).toBe(false);
	} finally {
		sourceRemote.fake.recover();
	}
});

test("an unavailable claimed attachment fails the export instead of offering an incomplete archive", async () => {
	sourceRemote.fake.fail("GET", 404);
	try {
		const exported = await exportSite(source, sourceAdmin, sourceSiteId);
		expect(exported).toMatchObject({ status: "failed", download: null });
	} finally {
		sourceRemote.fake.recover();
	}
	const recovered = await exportedArchive(source, sourceAdmin, sourceSiteId);
	expect(manifestIn(recovered).tables.map((table: { name: string }) => table.name)).not.toContain(
		"public.error_group_places",
	);
	expect(manifestIn(recovered).leftOut.tables).toContainEqual({ name: "public.error_group_places", reason: "install" });
});

test("another Workspace on the same Install gets separate private files and fresh download URLs", async () => {
	const workspaceId = (await source.createWorkspace("Another Workspace")).id;
	const imported = await importArchive(source, sourceAdmin, workspaceId, archive, {
		name: "Private copy",
		slug: "private-copy",
	});
	expect(imported.status).toBe("done");
	const siteId = imported.site?.id ?? "";
	const owner = (await source.createMember({ workspaceId, role: "owner" })).browser;
	const sourceOwner = (await source.createMember({ workspaceId: sourceWorkspaceId, role: "owner" })).browser;
	const { submissions } = await api(owner).submissions.list({ siteId });
	for (const listed of submissions) {
		const { submission } = await api(owner).submissions.get({ siteId, id: listed.id });
		for (const file of files(submission)) {
			const response = await owner.request(file.url);
			expect(response.status).toBe(200);
			expect(Buffer.from(await response.arrayBuffer())).toEqual(fixtureBytes(file.name));
			expect(readFileSync(join(source.storageDir, workspaceId, siteId, "form-uploads", file.uploadId))).toEqual(
				fixtureBytes(file.name),
			);
			expect((await sourceOwner.request(file.url)).status).toBe(404);
			expect(
				(await sourceAdmin.request(source.adminUrl(`/api/forms/uploads/${sourceSiteId}/${file.uploadId}`))).status,
			).toBe(404);
		}
	}
	const again = await exportedArchive(source, sourceAdmin, siteId);
	expect(rowsIn(again, "public.form_uploads")).toHaveLength(2);
	expect(manifestIn(again).files).toMatchObject({ rows: 2, bytes: manifestIn(archive).files.bytes, mediaBytes: 0 });
});

for (const [name, change] of [
	[
		"an unclaimed upload",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "public.form_uploads" ? rows.map((row) => ({ ...row, submission_id: null })) : rows,
	],
	[
		"an upload claimed by another Submission",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "public.form_uploads" ? rows.map((row) => ({ ...row, submission_id: crypto.randomUUID() })) : rows,
	],
	[
		"an upload for another Form",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "public.form_uploads" ? rows.map((row) => ({ ...row, form_id: crypto.randomUUID() })) : rows,
	],
	[
		"a key in a public storage folder",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "public.form_uploads"
				? rows.map((row) => ({ ...row, key: `${row.workspace_id}/${row.site_id}/media/${row.id}` }))
				: rows,
	],
	[
		"a different attachment filename",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "public.form_uploads" ? rows.map((row) => ({ ...row, name: "different.pdf" })) : rows,
	],
	[
		"an oversized attachment claim",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "m_forms.submissions"
				? rows.map((row) => ({
						...row,
						values: mapFiles(row.values, (file) => ({ ...file, size: 1024 * 1024 * 1024 })),
					}))
				: rows,
	],
	[
		"a repeated attachment claim",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "m_forms.submissions" ? [...rows, ...rows.map((row) => ({ ...row, id: crypto.randomUUID() }))] : rows,
	],
	[
		"a missing upload row",
		(table: string, rows: Record<string, unknown>[]) => (table === "public.form_uploads" ? rows.slice(1) : rows),
	],
	[
		"a missing Submissions table",
		(table: string, rows: Record<string, unknown>[]) => (table === "m_forms.submissions" ? null : rows),
	],
	[
		"an incorrect upload id in a Submission value",
		(table: string, rows: Record<string, unknown>[]) =>
			table === "m_forms.submissions"
				? rows.map((row) => ({
						...row,
						values: mapFiles(row.values, (file) => ({ ...file, uploadId: crypto.randomUUID() })),
					}))
				: rows,
	],
] as const) {
	test(`the import refuses ${name}, leaving no Site`, async () => {
		const workspaceId = (await source.createWorkspace(`Refused: ${name}`)).id;
		const damaged = rewritten(archive, { rows: change });
		const imported = await importArchive(source, sourceAdmin, workspaceId, damaged, {
			name: "Refused",
			slug: `refused-${++refusal}`,
		});
		expect(imported).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
		expect((await sourceAdmin.api.sites.list({ workspaceId })).sites).toEqual([]);
	});
}

test("a damaged private file rolls back the Site and removes files already copied to its bucket", async () => {
	const target = await createTestInstall();
	try {
		const admin = await approve(target);
		const remote = bucket(target);
		await admin.api.install.storage.update(remote.settings);
		const workspaceId = (await target.createWorkspace("Rollback")).id;
		const entries = tarFiles(archive);
		const last = entries.filter((file) => file.path.includes("/form-uploads/")).at(-1);
		if (!last) throw new Error("Missing private file fixture.");
		last.data[0] = (last.data[0] ?? 0) ^ 1;
		const imported = await importArchive(target, admin, workspaceId, tarOf(entries), {
			name: "Damaged",
			slug: "damaged",
		});
		expect(imported).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
		expect((await admin.api.sites.list({ workspaceId })).sites).toEqual([]);
		expect([...remote.fake.objects.keys()].filter((key) => key.includes("/form-uploads/"))).toEqual([]);
		expect(remote.fake.openUploads).toBe(0);
	} finally {
		await target.close();
	}
});

test("a missing Forms Module keeps its remapped Submissions and attachment bytes private", async () => {
	const target = await createTestInstall({ modules: [] });
	try {
		const admin = await target.superadmin();
		const workspaceId = (await target.createWorkspace("Missing Forms")).id;
		const withSourceUrls = rewritten(archive, {
			rows: (table, rows) =>
				table === "m_forms.submissions"
					? rows.map((row) => ({
							...row,
							values: mapFiles(row.values, (file) => ({
								...file,
								url: `https://source.test/api/forms/uploads/${sourceSiteId}/${file.uploadId}`,
							})),
						}))
					: rows,
		});
		const imported = await importArchive(target, admin, workspaceId, withSourceUrls, {
			name: "Kept aside",
			slug: "kept-aside",
		});
		expect(imported.status).toBe("done");
		expect(imported.report?.modules).toContainEqual(
			expect.objectContaining({ id: "forms", status: "missing", keptAside: true }),
		);
		const siteId = imported.site?.id ?? "";
		const kept = gunzipSync(
			readFileSync(join(target.storageDir, workspaceId, siteId, "kept-aside/m_forms.submissions/part-000001")),
		).toString();
		const rows = kept
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const row of rows) {
			for (const file of files(row)) {
				expect(file).not.toHaveProperty("url");
				expect(readFileSync(join(target.storageDir, workspaceId, siteId, "form-uploads", file.uploadId))).toEqual(
					fixtureBytes(file.name),
				);
				expect((await admin.request(target.adminUrl(`/api/forms/uploads/${siteId}/${file.uploadId}`))).status).toBe(
					404,
				);
			}
		}
	} finally {
		await target.close();
	}
});

test("missing Modules do not bypass validation of private attachment claims", async () => {
	const target = await createTestInstall({ modules: [] });
	try {
		const admin = await target.superadmin();
		const workspaceId = (await target.createWorkspace("Invalid missing Module")).id;
		const damaged = rewritten(archive, {
			rows: (table, rows) =>
				table === "m_forms.submissions"
					? rows.map((row) => ({
							...row,
							values: mapFiles(row.values, (file) => ({ ...file, uploadId: crypto.randomUUID() })),
						}))
					: rows,
		});
		const imported = await importArchive(target, admin, workspaceId, damaged, { name: "Invalid", slug: "invalid" });
		expect(imported).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
		expect((await admin.api.sites.list({ workspaceId })).sites).toEqual([]);
	} finally {
		await target.close();
	}
});

test("an archive claiming Submissions were omitted cannot carry them", async () => {
	const workspaceId = (await source.createWorkspace("Contradictory omission")).id;
	const damaged = rewritten(archive, {
		manifest(manifest) {
			manifest.leftOut.submissions = true;
		},
	});
	const imported = await importArchive(source, sourceAdmin, workspaceId, damaged, {
		name: "Contradiction",
		slug: "contradiction",
	});
	expect(imported).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
});

test("an unavailable destination bucket rolls back attachment writes and the Site", async () => {
	const target = await createTestInstall();
	try {
		const admin = await approve(target);
		const remote = bucket(target);
		const workspaceId = (await target.createWorkspace("Unavailable bucket")).id;
		const uploaded = await uploadArchive(admin, workspaceId, archive);
		await admin.api.install.storage.update(remote.settings);
		remote.fake.fail("PUT", 503);
		await admin.api.siteImports.start({
			workspaceId,
			importId: uploaded.id,
			name: "Unavailable",
			slug: "unavailable",
			passphrase: null,
		});
		await target.drainJobs();
		const { import: imported } = await admin.api.siteImports.get({ workspaceId, importId: uploaded.id });
		expect(imported).toMatchObject({ status: "failed", site: null });
		expect((await admin.api.sites.list({ workspaceId })).sites).toEqual([]);
		expect([...remote.fake.objects.keys()].filter((key) => key.includes("/form-uploads/"))).toEqual([]);
		expect(remote.fake.openUploads).toBe(0);
	} finally {
		await target.close();
	}
});

test("a valid empty text attachment survives export, import and download", async () => {
	await sourceAdmin.api.forms.saveDraft({
		siteId: sourceSiteId,
		formId: sourceFormId,
		form: {
			fields: [{ key: "attachment", type: "file", label: "Attachment", accept: ["pdf", "txt"], required: true }],
		},
	});
	await sourceAdmin.api.forms.publish({ siteId: sourceSiteId, formId: sourceFormId });
	await send("empty.txt", new Uint8Array());
	const withEmpty = await exportedArchive(source, sourceAdmin, sourceSiteId);
	const workspaceId = (await source.createWorkspace("Empty attachment")).id;
	const imported = await importArchive(source, sourceAdmin, workspaceId, withEmpty, {
		name: "Empty attachment",
		slug: "empty-attachment",
	});
	expect(imported.failure).toBeNull();
	expect(imported.status).toBe("done");
	const siteId = imported.site?.id ?? "";
	const { submissions } = await api(sourceAdmin).submissions.list({ siteId });
	let checked = false;
	for (const listed of submissions) {
		const { submission } = await api(sourceAdmin).submissions.get({ siteId, id: listed.id });
		for (const file of files(submission).filter((item) => item.name === "empty.txt")) {
			const response = await sourceAdmin.request(file.url);
			expect(response.status).toBe(200);
			expect((await response.arrayBuffer()).byteLength).toBe(0);
			checked = true;
		}
	}
	expect(checked).toBe(true);
});

// A person who must set up two-factor authentication and hasn't is refused everything but setting
// it up: the procedures, and also the three downloads the admin serves by the session cookie (a
// Media file's preview, a Form upload, a Site export). The report's A1-8.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import { formVisitor } from "../harness/forms.ts";
import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { downloadExport, exportSite } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { addAuthenticator, signInWithAuthenticator } from "../harness/two-factor.ts";

const PAGE = "https://bakery.live.test/visit/apply";

let install: TestInstall;
let superadmin: TestAccount;
let late: { browser: TestBrowser; account: TestAccount };
let downloads: Record<"Media preview" | "Form upload" | "Site export", () => Promise<Response>>;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	// Staff without a second factor, signed in before two-factor authentication is required.
	late = await install.createStaff({ workspaces: [workspaceId] });
	const staff = late.browser;

	const media = await staff.api.media.upload({ siteId, file: upload(pdf(), "guide.pdf") });
	const mediaPath = install.adminUrl(`/api/media/${siteId}/${(media.media.url ?? "").replace("/_media/", "")}`);

	const { form } = await staff.api.forms.create({ siteId, name: "Job application", key: "apply" });
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [
				{ key: "name", type: "text", label: "Your name", required: true },
				{ key: "cv", type: "file", label: "Your CV", required: true, accept: ["pdf"] },
			],
		},
	});
	await staff.api.forms.publish({ siteId, formId: form.id });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Visits", urlPattern: "/visit/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<section data-wc-id="s1"><h1 data-wc-id="h1">{{ title }}</h1>{{@form apply}}</section>',
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Apply", slug: "apply" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	const visitor = formVisitor(install);
	const page = await visitor.open(PAGE);
	await install.clock.advance(5_000);
	await visitor.send(
		page,
		{ name: "Siobhán Murphy" },
		{ files: { cv: [{ name: "cv.pdf", type: "application/pdf", bytes: pdf("A CV") }] } },
	);
	const { submissions } = await moduleApi<typeof forms>(staff, "forms").submissions.list({
		siteId,
		formId: form.id,
		folder: "inbox",
		limit: 1,
	});
	const files = (submissions[0]?.values.find((value) => value.key === "cv")?.value ?? []) as { uploadId: string }[];
	const uploadPath = install.adminUrl(`/api/forms/uploads/${siteId}/${files[0]?.uploadId}`);

	const exported = await exportSite(install, staff, siteId);

	downloads = {
		"Media preview": () => late.browser.request(mediaPath),
		"Form upload": () => late.browser.request(uploadPath),
		"Site export": () => downloadExport(install, late.browser, exported),
	};
});

afterAll(async () => {
	await install.close();
});

async function statuses(): Promise<Record<string, number>> {
	const answers: Record<string, number> = {};
	for (const [name, download] of Object.entries(downloads)) answers[name] = (await download()).status;
	return answers;
}

describe("the admin's downloads, for a person who must set up two-factor authentication", () => {
	test("are refused like everything else until they add it, then work again", async () => {
		expect(await statuses()).toEqual({ "Media preview": 200, "Form upload": 200, "Site export": 200 });

		// The Superadmin requires two-factor authentication of everyone on the Install.
		const admin = await install.superadmin();
		const { secret } = await addAuthenticator(install, admin, superadmin.password);
		const withFactor = await signInWithAuthenticator(install, superadmin, secret);
		await withFactor.api.install.security.requireTwoFactor({ required: true });

		await expect(late.browser.api.workspaces.list()).rejects.toMatchObject({ code: "TWO_FACTOR_SETUP_REQUIRED" });
		expect(await statuses()).toEqual({ "Media preview": 404, "Form upload": 404, "Site export": 404 });

		await addAuthenticator(install, late.browser, late.account.password);
		expect(await statuses()).toEqual({ "Media preview": 200, "Form upload": 200, "Site export": 200 });
	});
});

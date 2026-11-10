// A rich Site for Site export tests: Post Types joined by a Relationship, an Entry template placing a
// Component and a Media image (ids written inside element trees), a Form with a Submission, Site
// analytics' events, a Redirect rule, Revisions, Members, a second language, a live domain and secrets.
import type forms from "@webcraft/module-forms";
import type redirects from "@webcraft/module-redirects";

import { analyticsVisitor } from "../harness/analytics.ts";
import { formVisitor } from "../harness/forms.ts";
import { photo, upload } from "../harness/images.ts";
import type { TestAccount, TestBrowser, TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

export const SMTP_PASSWORD = "site-smtp-password-1234";
export const WEBHOOK_SECRET = "webhook-signing-secret-5678";

/** Approves the Modules a rich Site uses on an Install (as the Superadmin does on Install settings › Modules). */
export async function approveModules(install: TestInstall): Promise<void> {
	const admin = await install.superadmin();
	const { modules } = await admin.api.modules.list();
	for (const id of ["forms", "redirects", "site-analytics"]) {
		const module = modules.find((each) => each.id === id);
		if (module && module.status !== "approved")
			await admin.api.modules.approve({ moduleId: id, version: module.version });
	}
}

/** Publish all's two calls, as the admin makes them: every Draft of the Site, previewed, then confirmed. */
export async function publishEverything(browser: TestBrowser, siteId: string) {
	const { drafts } = await browser.api.publishing.drafts({ siteId });
	const items = drafts.map((draft) => draft.item) as never;
	const preview = await browser.api.publishing.publishAll({ siteId, items });
	const confirmation = (preview as { confirmation?: { id: string } }).confirmation?.id;
	if (!confirmation) throw new Error("Publish all answered no confirmation.");
	return browser.api.publishing.publishAll({ siteId, items, confirmation });
}

export type RichSite = {
	workspaceId: string;
	siteId: string;
	origin: string;
	staff: TestBrowser;
	staffAccount: TestAccount;
	editorAccount: TestAccount;
	ownerAccount: TestAccount;
	mediaId: string;
	mediaUrl: string;
	mediaBytes: Uint8Array;
	formId: string;
	entryId: string;
	page: string;
};

/** Builds the rich Site on an Install (whose Modules must be approved), live on its domain. */
export async function richSite(install: TestInstall, workspaceName = "Acme Ltd"): Promise<RichSite> {
	const workspaceId = (await install.createWorkspace(workspaceName)).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const origin = await goLive(install, siteId);
	const staffMember = await install.createStaff({ workspaces: [workspaceId] });
	const staff = staffMember.browser;
	const editor = await install.createMember({ workspaceId, role: "editor", name: "Eve Editor" });
	const owner = await install.createMember({ workspaceId, role: "owner", name: "Olive Owner" });
	await staff.api.languages.add({ siteId, code: "it" });
	for (const moduleId of ["forms", "redirects", "site-analytics"]) {
		await staff.api.modules.setOnSite({ siteId, moduleId, on: true });
	}

	const { media } = await editor.browser.api.media.upload({
		siteId,
		file: upload(await photo({ width: 800, height: 600 }), "Sourdough.jpg", "image/jpeg"),
	});
	await editor.browser.api.media.update({ siteId, mediaId: media.id, alt: "A sourdough loaf" });
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw new Error(`Jobs failed: ${JSON.stringify(drained.failed)}`);
	const ready = (await staff.api.media.get({ siteId, mediaId: media.id })).media;
	const mediaUrl = ready.url ?? "";
	const mediaBytes = new Uint8Array(await (await install.request(`${origin}${mediaUrl}`)).arrayBuffer());

	const { component } = await staff.api.components.create({
		siteId,
		name: "Badge",
		props: [{ key: "label", label: "Label", type: "text" }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<strong>{{ props.label }}</strong>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });

	const { postType: categories } = await staff.api.postTypes.create({
		siteId,
		name: "Categories",
		key: "categories",
		urlPattern: "/category/{slug}",
	});
	const { postType: posts } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "category", label: "Category", type: "relationship", postTypes: ["categories"], multiple: false },
			{ key: "photo", label: "Photo", type: "media" },
		],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: posts.id,
		markup: `<article><h1>{{ title }}</h1><p><em>{{ category.title }}</em></p><Badge label="Fresh"/><img src="media:${media.id}" alt="Our loaf"></article>`,
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry: bread } = await staff.api.entries.create({ siteId, postTypeId: categories.id, title: "Bread" });
	await staff.api.entries.publish({ siteId, entryId: bread.id });
	const { entry } = await editor.browser.api.entries.create({
		siteId,
		postTypeId: posts.id,
		title: "Fresh bread",
		fields: { category: bread.id, photo: media.id },
	});
	await editor.browser.api.entries.publish({ siteId, entryId: entry.id });
	await install.clock.advance(60_000);
	await editor.browser.api.entries.saveDraft({
		siteId,
		entryId: entry.id,
		title: "Fresh bread",
		fields: { photo: media.id },
	});
	await editor.browser.api.entries.publish({ siteId, entryId: entry.id });

	// A Form on a page, and a visitor's Submission.
	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [
				{ key: "name", type: "text", label: "Your name", required: true },
				{ key: "email", type: "email", label: "Email", required: true },
			],
			success: { kind: "message", message: "Thanks!" },
		},
	});
	await staff.api.forms.publish({ siteId, formId: form.id });
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry: contact } = await staff.api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Contact" });
	await staff.api.entries.publish({ siteId, entryId: contact.id });
	const { postType: visits } = await staff.api.postTypes.create({
		siteId,
		name: "Visits",
		key: "visits",
		urlPattern: "/visit/{slug}",
	});
	const visitTemplate = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: visits.id,
		markup: "<section><h1>{{ title }}</h1>{{@form contact}}</section>",
	});
	await staff.api.templates.publish({ siteId, templateId: visitTemplate.template.id });
	const { entry: visit } = await staff.api.entries.create({
		siteId,
		postTypeId: visits.id,
		title: "Contact",
		slug: "contact",
	});
	await staff.api.entries.publish({ siteId, entryId: visit.id });
	const visitor = formVisitor(install);
	const loaded = await visitor.open(`${origin}/visit/contact`);
	await install.clock.advance(5000);
	const sent = await visitor.send(loaded, { name: "Ada", email: "ada@example.com" });
	if (sent.status >= 400) throw new Error(`The Form post answered ${sent.status}`);

	// A Redirect rule, and a page view Site analytics counts.
	await moduleApi<typeof redirects>(editor.browser, "redirects").rules.add({
		siteId,
		from: "/old-bread",
		to: "/blog/fresh-bread",
		status: 301,
	});
	await staff.api.consentBanner.setSettings({ siteId, mode: "none", layout: "bar" });
	const view = await analyticsVisitor(install, origin).view("/blog/fresh-bread");
	if (view.status >= 300) throw new Error(`The page view answered ${view.status}`);

	const page = await expectSafePage(await install.request(`${origin}/blog/fresh-bread`));
	void moduleApi<typeof forms>;
	return {
		workspaceId,
		siteId,
		origin,
		staff,
		staffAccount: staffMember.account,
		editorAccount: editor.account,
		ownerAccount: owner.account,
		mediaId: media.id,
		mediaUrl,
		mediaBytes,
		formId: form.id,
		entryId: entry.id,
		page,
	};
}

/** Gives the rich Site its secrets: its own mail server's password and a Webhook's signing secret. */
export async function giveSecrets(install: TestInstall, site: RichSite): Promise<void> {
	await site.staff.api.siteSmtp.update({
		siteId: site.siteId,
		fromName: "Acme Bakery",
		replyTo: null,
		server: {
			host: "smtp.bakery.example",
			port: 587,
			security: "starttls",
			username: "bakery",
			fromAddress: "hello@bakery.example",
			password: SMTP_PASSWORD,
		},
	});
	await site.staff.api.webhooks.add({
		siteId: site.siteId,
		name: "Orders",
		url: "https://hooks.bakery.example/webcraft",
		events: ["publish"],
		secret: WEBHOOK_SECRET,
	});
	void install;
}

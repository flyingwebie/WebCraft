// `{{@form <key>}}` places one of the Site's Forms in a Template or Component (ADR 0017): stored by
// the Form's id, written by its key, checked where it sits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let contactId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
	contactId = form.id;
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: { fields: [{ key: "email", type: "email", label: "Email", required: true }] },
	});
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Shops",
		key: "shops",
		urlPattern: "/shops/{slug}",
		fields: [],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

describe("writing {{@form}}", () => {
	test("Template markup names the Form by its key; the tree keeps its id", async () => {
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: '<section data-wc-id="s1"><h2 data-wc-id="h1">Ask us</h2>{{@form contact}}</section>',
		});

		expect(saved.markup).toBe('<section data-wc-id="s1"><h2 data-wc-id="h1">Ask us</h2>{{@form contact}}</section>');
		expect(saved.template.draft.nodes[0]).toMatchObject({
			children: [{ tag: "h2" }, { type: "form", form: contactId }],
		});
		const { usage } = await staff.api.forms.get({ siteId, formId: contactId });
		expect(usage.usedIn).toEqual([{ kind: "entryTemplate", id: saved.template.id, name: "Shops" }]);
	});

	test("changing the Form's key changes how every Template writes it", async () => {
		await staff.api.forms.rename({ siteId, formId: contactId, key: "get-in-touch" });

		const { markup } = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });

		expect(markup?.draft).toContain("{{@form get-in-touch}}");
		await staff.api.forms.rename({ siteId, formId: contactId, key: "contact" });
	});

	test("an unknown key, a missing one, and a Form where one can't go are refused where they are", async () => {
		const refusal = (markup: string) =>
			staff.api.templates
				.saveEntryTemplateMarkup({ siteId, postTypeId, markup })
				.then(() => null)
				.catch((error) => error as { code: string; data: { problems: { message: string }[] } });

		expect(await refusal("{{@form nowhere}}")).toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ line: 1, column: 9, message: "There is no Form with the key nowhere on this Site." }] },
		});
		expect((await refusal("{{@form}}"))?.data.problems[0]?.message).toContain("names the Form to place");
		expect((await refusal('<p data-wc-id="p1">{{@form contact}}</p>'))?.data.problems[0]?.message).toBe(
			"{{@form}} is a form of its own: it can't go inside <p>.",
		);
		expect((await refusal('<a href="/x" data-wc-id="a1">{{@form contact}}</a>'))?.data.problems[0]?.message).toBe(
			"{{@form}} is a form of its own: it can't go inside <a>.",
		);
	});

	test("Components and the Site template place Forms too", async () => {
		const { component } = await staff.api.components.create({ siteId, name: "ContactBox" });
		const saved = await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: '<aside data-wc-id="a2">{{@form contact}}</aside>',
		});
		const site = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<main data-wc-id="m1">{{@outlet}}</main><footer data-wc-id="f1">{{@form contact}}</footer>',
		});

		expect(saved.markup).toContain("{{@form contact}}");
		expect(site.markup).toContain("{{@form contact}}");
	});
});

describe("publishing what places a Form", () => {
	test("a Template placing a Form that isn't published yet can't be published", async () => {
		const { template } = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });

		await expect(staff.api.templates.publish({ siteId, templateId: template?.id ?? "" })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
		});
		await staff.api.forms.publish({ siteId, formId: contactId });
		await staff.api.templates.publish({ siteId, templateId: template?.id ?? "" });
		const { template: published } = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
		expect(published?.published?.nodes[0]).toMatchObject({ children: [{}, { type: "form", form: contactId }] });
	});

	test("a Form can't be deleted while something places it", async () => {
		await expect(staff.api.forms.delete({ siteId, formId: contactId })).rejects.toMatchObject({
			code: "FORM_IN_USE",
			data: { usedIn: expect.arrayContaining([expect.objectContaining({ kind: "component", name: "ContactBox" })]) },
		});
	});
});

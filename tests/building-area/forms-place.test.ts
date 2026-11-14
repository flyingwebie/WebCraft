// The Forms place's ground on the server (ADR 0037, BA-26): what the admin's Build tab saves and
// publishes, the building area does from the Site's own address, for Staff only; a Form's emails and
// deleting a Form stay the admin's; the shell starts knowing whether the person builds Forms, with the
// admin's words for a field's settings.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyField } from "@webcraft/renderer/forms";

import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { type BuildingAreaApi, buildingAreaApi, refusalOf } from "../harness/building-area-api.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let staffArea: BuildingAreaApi;
let editorArea: BuildingAreaApi;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staffArea = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
	editorArea = buildingAreaApi(install, await openBuildingArea(install, editor, siteId));
});

afterAll(async () => {
	await install.close();
});

const field = (key: string, type: Parameters<typeof emptyField>[1], label: string) =>
	emptyField(key, type, { text: label });

describe("Staff build a Form from the Site's address", () => {
	test("New Form from a starter, its Draft saved with widths, then its fields published apart from its emails", async () => {
		const { form } = await staffArea.api.forms.create({ siteId, name: "Order a cake" });
		expect(form.key).toBe("order-a-cake");

		const fields = [
			{ ...field("name", "text", "Name"), required: true, width: "half" as const },
			{ ...field("email", "email", "Email"), required: true, width: "half" as const },
			field("cake", "section", "Your cake"),
			{ ...field("message", "textarea", "Message"), width: "third" as const },
		];
		await staffArea.api.forms.saveDraft({ siteId, formId: form.id, form: { fields } });

		const listed = (await staffArea.api.forms.list({ siteId })).forms.find((each) => each.id === form.id);
		expect(listed).toMatchObject({ name: "Order a cake", status: "draft", usage: { usedIn: [] } });
		const opened = await staffArea.api.forms.get({ siteId, formId: form.id });
		expect(opened.form.draft.fields.map((each) => [each.key, each.width])).toEqual([
			["name", "half"],
			["email", "half"],
			["cake", null],
			["message", "third"],
		]);

		const published = await staffArea.api.forms.publish({ siteId, formId: form.id });
		expect(published.form.status).toBe("published");
		expect(published.form.published?.fields.map((each) => each.key)).toEqual(["name", "email", "cake", "message"]);
		// Emails are Content with a Draft of their own: Publish leaves them as they were.
		expect(published.form.emails.status).toBe("draft");
		expect(published.form.emails.published).toBeNull();

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
		const logged = entries.find((entry) => entry.siteId === siteId && entry.action === "form.publish");
		expect(logged).toMatchObject({ via: { kind: "editMode" } });
	});

	test("a refused Draft says each problem at its field, and keeps what was there", async () => {
		const { form } = await staffArea.api.forms.create({ siteId, name: "Contact" });
		await staffArea.api.forms.saveDraft({ siteId, formId: form.id, form: { fields: [field("name", "text", "Name")] } });

		const refused = staffArea.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: { fields: [field("name", "text", "Name"), field("name", "email", "Email")] },
		});
		await expect(refused).rejects.toMatchObject({ code: "FORM_INVALID" });
		const problems = await refused.catch((error: { data?: { problems?: { at: string }[] } }) => error.data?.problems);
		expect(problems?.some((problem) => problem.at.startsWith("fields[1]"))).toBe(true);
		expect((await staffArea.api.forms.get({ siteId, formId: form.id })).form.draft.fields).toHaveLength(1);
	});
});

describe("a Member", () => {
	test("may not make, change or publish a Form from the Site's address", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Newsletter sign-up" });
		const fields = [field("email", "email", "Email")];
		for (const call of [
			() => editorArea.api.forms.create({ siteId, name: "Mine" }),
			() => editorArea.api.forms.saveDraft({ siteId, formId: form.id, form: { fields } }),
			() => editorArea.api.forms.publish({ siteId, formId: form.id }),
		]) {
			await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect((await staff.api.forms.get({ siteId, formId: form.id })).form.draft.fields).toEqual([]);
	});

	test("the shell knows who builds Forms, and carries the admin's words for a field's settings", async () => {
		const read = async (person: TestBrowser) => {
			const building = await openBuildingArea(install, person, siteId);
			return shellConfigIn(await (await building.shell(building.landed)).text()) as
				| { permissions: string[]; adminMessages: { forms: { field: { label: string } } } }
				| undefined;
		};
		const forStaff = await read(staff);
		expect(forStaff?.permissions).toContain("structure.edit");
		expect(forStaff?.adminMessages.forms.field.label).toBe("Label");
		expect((await read(editor))?.permissions).not.toContain("structure.edit");
	});
});

describe("what stays the admin's", () => {
	test("a Form's emails, its name and key, and deleting it are not on the Site's address", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Job application" });
		for (const [path, input] of [
			["forms.saveEmails", { siteId, formId: form.id, emails: { notifications: [] } }],
			["forms.publishEmails", { siteId, formId: form.id }],
			["forms.rename", { siteId, formId: form.id, name: "Jobs" }],
			["forms.delete", { siteId, formId: form.id }],
			["forms.captcha.get", { siteId }],
		] as const) {
			const refusal = await refusalOf(await staffArea.call(path, input));
			expect({ path, refusal }).toMatchObject({ path, refusal: { status: 404, code: "NOT_FOUND" } });
		}
		expect((await staff.api.forms.get({ siteId, formId: form.id })).form.name).toBe("Job application");
	});

	test("the Forms place is an address of the shell", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Booking request" });
		const building = await openBuildingArea(install, staff, siteId);
		for (const place of ["forms", `forms%2F${form.id}`, `forms%2F${form.id}%2Femails`]) {
			const response = await building.shell(`/_webcraft/build/page/?wc-place=${place}&wc-view=field%3D2%26step%3D2`);
			expect(response.status).toBe(200);
		}
	});
});

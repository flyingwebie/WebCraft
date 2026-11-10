import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

const SMTP = {
	host: "smtp.agency.example",
	port: 587,
	security: "starttls",
	username: null,
	fromAddress: "noreply@agency.example",
	replyTo: null,
} as const;

let install: TestInstall;
let superadmin: TestAccount;
let admin: TestBrowser;
let superadminId: string;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
	admin = await install.signIn(superadmin);
	superadminId = (await admin.api.session.current()).person?.id ?? "";
	await admin.api.install.smtp.update(SMTP);
});

afterAll(async () => {
	await install.close();
});

beforeEach(async () => {
	install.mail.clear();
	await admin.api.install.emailBranding.update({ senderName: null, logoUrl: null, accentColour: null, footer: null });
	await admin.api.install.settings.update({ name: "" });
	await admin.api.me.updatePreferences({ adminLanguage: null });
});

async function sendAndDrain(type: "api-token-created" | "review-submitted" = "api-token-created") {
	if (type === "api-token-created") {
		await install.sendSystemEmail({ type, to: { personId: superadminId }, data: { tokenName: "deploy" } });
	} else {
		await install.sendSystemEmail({
			type,
			to: { personId: superadminId },
			data: {
				authorName: "Ada",
				items: [{ kind: "entry", title: "Spring menu" }],
				siteName: "Acme Bakery",
				note: null,
				reviewPath: "/review/1",
			},
		});
	}
	await install.drainJobs();
	const sent = install.mail.sent.at(-1);
	if (!sent) throw new Error("Nothing was sent.");
	return sent;
}

describe("Install branding", () => {
	test("starts from WebCraft's defaults", async () => {
		expect(await admin.api.install.emailBranding.get()).toEqual({
			senderName: null,
			logoUrl: null,
			accentColour: null,
			footer: null,
			defaults: { senderName: "WebCraft", accentColour: "#c2410c" },
		});

		const sent = await sendAndDrain();

		expect(sent.from.name).toBe("WebCraft");
		expect(sent.html).toContain("#c2410c");
		expect(sent.html).not.toContain("<img");
	});

	test("the sender name follows the Install's name until the Superadmin sets one", async () => {
		await admin.api.install.settings.update({ name: "Northwind Studio" });

		expect((await admin.api.install.emailBranding.get()).defaults.senderName).toBe("Northwind Studio");
		expect((await sendAndDrain()).from.name).toBe("Northwind Studio");
	});

	test("every System email carries the sender name, logo, accent colour and footer the Superadmin sets", async () => {
		await admin.api.install.emailBranding.update({
			senderName: "Northwind Studio support",
			logoUrl: "https://cdn.northwind.example/logo.png",
			accentColour: "#0F766E",
			footer: "Northwind Studio · 1 Harbour Road, Dublin\nWe build and run your websites.",
		});

		const sent = await sendAndDrain();

		expect(sent.from).toEqual({ name: "Northwind Studio support", address: "noreply@agency.example" });
		expect(sent.html).toContain('<img src="https://cdn.northwind.example/logo.png" alt="Northwind Studio support"');
		expect(sent.html).toContain("#0f766e");
		expect(sent.html).toContain("Northwind Studio · 1 Harbour Road, Dublin<br>We build and run your websites.");
		expect(sent.text).toContain("Northwind Studio · 1 Harbour Road, Dublin\nWe build and run your websites.");
	});

	test("refuses a logo that isn't an HTTPS address, and an accent colour that isn't #rrggbb", async () => {
		await expect(
			admin.api.install.emailBranding.update({ logoUrl: "http://cdn.northwind.example/logo.png" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(admin.api.install.emailBranding.update({ accentColour: "orange" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(admin.api.install.emailBranding.update({ footer: "x".repeat(501) })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("only the Superadmin can read or change it", async () => {
		await expect(install.browser().api.install.emailBranding.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(install.browser().api.install.emailBranding.update({ senderName: "Mallory" })).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});

describe("the layout", () => {
	test("is written in the recipient's Admin language, laid out for it", async () => {
		await admin.api.me.updatePreferences({ adminLanguage: "it" });

		const sent = await sendAndDrain();

		expect(sent.subject).toBe("È stato creato un nuovo token API");
		expect(sent.html).toContain('<html lang="it" dir="ltr">');
		expect(sent.text).toContain("Inviata da WebCraft.");
	});

	test("follows the Install's default Admin language for people who haven't chosen one", async () => {
		await admin.api.install.settings.update({ defaultAdminLanguage: "it" });

		const sent = await sendAndDrain();

		expect(sent.subject).toBe("È stato creato un nuovo token API");
		await admin.api.install.settings.update({ defaultAdminLanguage: "en" });
	});

	test("escapes every value", async () => {
		await install.sendSystemEmail({
			type: "api-token-created",
			to: { personId: superadminId },
			data: { tokenName: '<script>alert("x")</script>' },
		});
		await install.drainJobs();

		const sent = install.mail.sent.at(-1);
		expect(sent?.html).not.toContain("<script>");
		expect(sent?.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	});

	test("work and alert emails link to the person's email switches; security emails don't", async () => {
		const work = await sendAndDrain("review-submitted");
		expect(work.html).toContain('href="https://admin.test/review/1"');
		expect(work.html).toContain('href="https://admin.test/account#emails"');
		expect(work.text).toContain("Choose which emails you get: https://admin.test/account#emails");

		const security = await sendAndDrain("api-token-created");
		expect(security.html).not.toContain("/account#emails");
	});
});

// A Site export carries the Site's secrets only under an export passphrase (ADR 0032): never in plain
// text, never under the Master key. Imported with the passphrase they work as before; without it they
// are dropped, listed in the export and in the Site import report, and what needed them is switched off.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { createTestInstall, TEST_MASTER_KEY, type TestBrowser, type TestInstall } from "../harness/index.ts";
import {
	exportedArchive,
	importArchive,
	manifestIn,
	PASSPHRASE,
	tarFiles,
	tarOf,
	uploadArchive,
} from "../harness/site-transfer.ts";
import { receiverAccepts } from "../webhooks/support.ts";

const SMTP_PASSWORD = "site-smtp-password-1234";
const WEBHOOK_SECRET = "webhook-signing-secret-5678";
const SERVER = {
	host: "smtp.bakery.example",
	port: 587,
	security: "starttls" as const,
	username: "bakery",
	fromAddress: "hello@bakery.example",
};
const HOOK = "https://hooks.bakery.example/webcraft";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let workspaceId: string;
let withPassphrase: Uint8Array;
let withoutPassphrase: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	// A Site's own server must be on the public internet (`tests/email/site-smtp-network.test.ts`).
	install.dns.answer(SERVER.host, ["93.184.216.40"]);
	await staff.api.siteSmtp.update({
		siteId,
		fromName: "Acme Bakery",
		replyTo: null,
		server: { ...SERVER, password: SMTP_PASSWORD },
	});
	await staff.api.webhooks.add({ siteId, name: "Orders", url: HOOK, events: ["publish"], secret: WEBHOOK_SECRET });
	install.dns.answer("hooks.bakery.example", ["93.184.216.34"]);
	install.http.respond("POST", HOOK, { status: 204 });
	await staff.api.staging.setPassword({ siteId, password: "staging-password-1234" });
	withPassphrase = await exportedArchive(install, staff, siteId, { passphrase: PASSPHRASE });
	withoutPassphrase = await exportedArchive(install, staff, siteId);
});

afterAll(async () => {
	await install?.close();
});

/** Whether any file of the archive holds `text` (unzipped, its JSON Lines too). */
function archiveHolds(archive: Uint8Array, text: string): boolean {
	return tarFiles(archive).some((file) => {
		const data = Buffer.from(file.data);
		if (data.includes(text)) return true;
		if (file.path.endsWith(".gz")) return gunzipSync(Buffer.from(file.data)).includes(text);
		return false;
	});
}

describe("exported with a passphrase", () => {
	test("carries the secrets encrypted under it, never in plain text and never the Master key", () => {
		const manifest = manifestIn(withPassphrase);
		expect(manifest.secrets.carried).toBe(true);
		expect(manifest.secrets.names).toEqual(expect.arrayContaining(["smtp.password"]));
		expect(manifest.secrets.names.some((name: string) => /^webhook:.*:signing$/.test(name))).toBe(true);
		expect(tarFiles(withPassphrase).map((file) => file.path)).toContain("secrets.json");
		for (const text of [SMTP_PASSWORD, WEBHOOK_SECRET, TEST_MASTER_KEY, PASSPHRASE]) {
			expect(archiveHolds(withPassphrase, text)).toBe(false);
		}
	});

	test("imported with the passphrase, the secrets work as before", async () => {
		const otherWorkspaceId = (await install.createWorkspace("Beta Ltd")).id;
		const admin = await install.superadmin();
		const imported = await importArchive(install, admin, otherWorkspaceId, withPassphrase, {
			name: "Beta Bakery",
			slug: "beta-bakery",
			passphrase: PASSPHRASE,
		});
		expect(imported.status).toBe("done");
		expect(imported.report?.secrets.dropped).toEqual([]);
		expect(imported.report?.secrets.set.length).toBe(2);
		expect(imported.report?.webhooksOff).toEqual([]);
		const newSiteId = imported.site?.id ?? "";

		// The Site's own mail server gets the password it had.
		install.mail.clear();
		const sent = await admin.api.siteSmtp.sendTest({
			siteId: newSiteId,
			to: "ops@agency.example",
			fromName: null,
			replyTo: null,
			server: SERVER,
		});
		expect(sent.status).toBe("sent");
		expect(install.mail.sent.at(-1)?.smtp).toMatchObject({ host: SERVER.host, password: SMTP_PASSWORD });

		// The Webhook signs with the secret it had, so its receiver still accepts it.
		const { webhooks } = await admin.api.webhooks.list({ siteId: newSiteId });
		expect(webhooks.map((webhook) => [webhook.name, webhook.status])).toEqual([["Orders", "on"]]);
		await admin.api.webhooks.test({ siteId: newSiteId, webhookId: webhooks[0]?.id ?? "" });
		const delivery = install.http.requests.filter((request) => request.url === HOOK).at(-1);
		expect(delivery && receiverAccepts(delivery, WEBHOOK_SECRET, install.clock.now())).toBe(true);
	});

	test("imported without it, the secrets are dropped and listed, and what needed them is switched off", async () => {
		const otherWorkspaceId = (await install.createWorkspace("Gamma Ltd")).id;
		const admin = await install.superadmin();
		const imported = await importArchive(install, admin, otherWorkspaceId, withPassphrase, {
			name: "Gamma Bakery",
			slug: "gamma-bakery",
		});
		expect(imported.status).toBe("done");
		expect(imported.report?.secrets).toMatchObject({ set: [], reason: "noPassphrase" });
		expect(imported.report?.secrets.dropped).toEqual(expect.arrayContaining(["smtp.password"]));
		expect(imported.report?.webhooksOff).toEqual(["Orders"]);
		const { webhooks } = await admin.api.webhooks.list({ siteId: imported.site?.id ?? "" });
		expect(webhooks.map((webhook) => webhook.status)).toEqual(["off"]);
	});

	test("a wrong passphrase is refused when the import starts, before anything is read in", async () => {
		const otherWorkspaceId = (await install.createWorkspace("Delta Ltd")).id;
		const admin = await install.superadmin();
		const uploaded = await uploadArchive(admin, otherWorkspaceId, withPassphrase);
		expect(uploaded.archive?.secrets).toMatchObject({ carried: true });
		await expect(
			admin.api.siteImports.start({
				workspaceId: otherWorkspaceId,
				importId: uploaded.id,
				name: "Delta Bakery",
				slug: "delta-bakery",
				passphrase: "not the passphrase at all",
			}),
		).rejects.toMatchObject({ code: "SITE_IMPORT_PASSPHRASE_WRONG", status: 400 });
		const { import: after } = await admin.api.siteImports.get({ workspaceId: otherWorkspaceId, importId: uploaded.id });
		expect(after.status).toBe("ready");
	});
});

describe("exported without a passphrase", () => {
	test("drops the secrets, listing them by name in the manifest", () => {
		const manifest = manifestIn(withoutPassphrase);
		expect(manifest.secrets).toMatchObject({ carried: false, sha256: null });
		expect(manifest.secrets.names).toEqual(expect.arrayContaining(["smtp.password"]));
		expect(tarFiles(withoutPassphrase).map((file) => file.path)).not.toContain("secrets.json");
	});

	test("the Site import report lists them as dropped", async () => {
		const otherWorkspaceId = (await install.createWorkspace("Epsilon Ltd")).id;
		const admin = await install.superadmin();
		const imported = await importArchive(install, admin, otherWorkspaceId, withoutPassphrase, {
			name: "Epsilon Bakery",
			slug: "epsilon-bakery",
			passphrase: PASSPHRASE,
		});
		expect(imported.report?.secrets).toMatchObject({ set: [], reason: "notCarried" });
		expect(imported.report?.secrets.dropped).toEqual(expect.arrayContaining(["smtp.password"]));
	});
});

describe("the passphrase", () => {
	test("has at least 12 characters", async () => {
		await expect(staff.api.siteExports.start({ siteId, passphrase: "short" })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});
});

test("staging credentials never leave the Install, even under an export passphrase", () => {
	for (const archive of [withPassphrase, withoutPassphrase]) {
		const manifest = manifestIn(archive);
		expect(manifest.leftOut.stagingPassword).toBe(true);
		expect(manifest.site.settings).not.toHaveProperty("staging_password_hash");
		expect(manifest.site.settings).not.toHaveProperty("staging_password_changed_at");
	}
});

test("a carried secret too large to store is dropped and reported before the Site is completed", async () => {
	const files = tarFiles(withPassphrase);
	const file = files.find((entry) => entry.path === "secrets.json");
	const head = files[0];
	if (!file || !head) throw new Error("Missing archive metadata.");
	const bundle = JSON.parse(Buffer.from(file.data).toString());
	const base = await crypto.subtle.importKey("raw", Buffer.from(PASSPHRASE.normalize("NFC")), "PBKDF2", false, [
		"deriveKey",
	]);
	const key = await crypto.subtle.deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt: Buffer.from(bundle.kdf.salt, "base64"), iterations: bundle.kdf.rounds },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const secret = bundle.secrets.find((value: { name: string }) => value.name === "smtp.password");
	const iv = crypto.getRandomValues(new Uint8Array(12));
	secret.iv = Buffer.from(iv).toString("base64");
	secret.ciphertext = Buffer.from(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: Buffer.from("webcraft site export secret:smtp.password") },
			key,
			Buffer.from("x".repeat(65_537)),
		),
	).toString("base64");
	file.data = Buffer.from(JSON.stringify(bundle));
	const manifest = manifestIn(withPassphrase);
	manifest.secrets.sha256 = createHash("sha256").update(file.data).digest("hex");
	head.data = Buffer.from(JSON.stringify(manifest));
	const target = (await install.createWorkspace("Oversized secret")).id;
	const admin = await install.superadmin();
	const imported = await importArchive(install, admin, target, tarOf(files), {
		name: "Oversized secret",
		slug: "oversized-secret",
		passphrase: PASSPHRASE,
	});
	expect(imported.status).toBe("done");
	expect(imported.report?.secrets).toMatchObject({ dropped: ["smtp.password"], reason: "unreadable" });
	expect((await admin.api.sites.list({ workspaceId: target })).sites).toHaveLength(1);
});

test("an archive can't make the Install hash a passphrase for longer than WebCraft's own exports do", async () => {
	const admin = await install.superadmin();
	const target = (await install.createWorkspace("Slow key")).id;
	// The most the format took before: more than eight times what an export writes.
	for (const rounds of [5_000_000, 1_200_001]) {
		const files = tarFiles(withPassphrase);
		const file = files.find((entry) => entry.path === "secrets.json");
		const head = files[0];
		if (!file || !head) throw new Error("Missing archive metadata.");
		const bundle = JSON.parse(Buffer.from(file.data).toString());
		expect(bundle.kdf.rounds).toBe(600_000);
		bundle.kdf.rounds = rounds;
		file.data = Buffer.from(JSON.stringify(bundle));
		const manifest = manifestIn(withPassphrase);
		manifest.secrets.sha256 = createHash("sha256").update(file.data).digest("hex");
		head.data = Buffer.from(JSON.stringify(manifest));

		await expect(uploadArchive(admin, target, tarOf(files))).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
			data: { reason: "damaged" },
		});
	}
});

test("the secret inventory must agree with the manifest, without duplicate names", async () => {
	const admin = await install.superadmin();
	const target = (await install.createWorkspace("Secret inventory")).id;
	for (const change of [
		(bundle: { secrets: { name: string }[] }) => {
			bundle.secrets.push({ ...bundle.secrets[0], name: "smtp.password" });
		},
		(bundle: { secrets: { name: string }[] }) => {
			bundle.secrets[0] = { ...bundle.secrets[0], name: "unlisted.secret" };
		},
	]) {
		const files = tarFiles(withPassphrase);
		const file = files.find((entry) => entry.path === "secrets.json");
		const head = files[0];
		if (!file || !head) throw new Error("Missing archive metadata.");
		const bundle = JSON.parse(Buffer.from(file.data).toString());
		change(bundle);
		file.data = Buffer.from(JSON.stringify(bundle));
		const manifest = manifestIn(withPassphrase);
		manifest.secrets.sha256 = createHash("sha256").update(file.data).digest("hex");
		head.data = Buffer.from(JSON.stringify(manifest));
		await expect(uploadArchive(admin, target, tarOf(files))).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
			data: { reason: "damaged" },
		});
	}
});

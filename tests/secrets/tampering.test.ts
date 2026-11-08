// A stored secret that was changed outside WebCraft is refused, never decrypted into something
// else. These tests act as someone with write access to the database would, so unlike other
// tests they name the table that holds secrets (`secrets`) and its columns: there is no other way
// to tamper with a stored value.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { type SecretRef, SecretUnreadableError } from "@webcraft/core";
import pg from "pg";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let database: pg.Client;

/** A Site's secret: the rows these tests change are found by Workspace, Site and name. */
type SiteSecret = SecretRef & { owner: { kind: "site"; workspaceId: string; siteId: string } };

let northSmtp: SiteSecret;
let southSmtp: SiteSecret;
let northCaptcha: SiteSecret;

beforeAll(async () => {
	install = await createTestInstall();
	database = new pg.Client({ connectionString: install.databaseUrl });
	await database.connect();
	const north = (await install.createWorkspace("North")).id;
	const northShop = (await install.createSite(north, { slug: "north-shop" })).id;
	const south = (await install.createWorkspace("South")).id;
	const southShop = (await install.createSite(south, { slug: "south-shop" })).id;
	northSmtp = { owner: { kind: "site", workspaceId: north, siteId: northShop }, name: "smtp.password" };
	southSmtp = { owner: { kind: "site", workspaceId: south, siteId: southShop }, name: "smtp.password" };
	northCaptcha = { owner: { kind: "site", workspaceId: north, siteId: northShop }, name: "captcha.secret" };
});

afterAll(async () => {
	await database.end();
	await install.close();
});

const NORTH_PASSWORD = "north-smtp-password-1234567890";
const SOUTH_PASSWORD = "south-smtp-password-0987654321";

beforeEach(async () => {
	await install.secrets.set(northSmtp, NORTH_PASSWORD);
	await install.secrets.set(southSmtp, SOUTH_PASSWORD);
	await install.secrets.set(northCaptcha, "captcha-secret-abcdefghijklmnop");
});

/** Runs `change` on the stored row of `secret`; `$4`, `$5` and `$6` in it name `from`'s row. */
async function tamper(secret: SiteSecret, change: string, from: SiteSecret = secret): Promise<void> {
	const parameters = [
		secret.owner.workspaceId,
		secret.owner.siteId,
		secret.name,
		from.owner.workspaceId,
		from.owner.siteId,
		from.name,
	];
	// Postgres wants exactly as many parameters as the statement uses.
	const used = Math.max(3, ...Array.from(change.matchAll(/\$(\d)/g), (match) => Number(match[1])));
	const result = await database.query(
		`UPDATE secrets SET ${change} WHERE workspace_id = $1 AND site_id = $2 AND name = $3`,
		parameters.slice(0, used),
	);
	expect(result.rowCount).toBe(1);
}

/** The columns of `from`'s stored row, for copying into another row. */
const COPY = `iv = (SELECT iv FROM secrets WHERE workspace_id = $4 AND site_id = $5 AND name = $6),
		 ciphertext = (SELECT ciphertext FROM secrets WHERE workspace_id = $4 AND site_id = $5 AND name = $6)`;

async function expectRefused(secret: SecretRef): Promise<void> {
	let called = false;
	const use = install.secrets.useWith(secret, () => {
		called = true;
	});
	await expect(use).rejects.toThrow(SecretUnreadableError);
	await expect(use).rejects.toThrow(/was changed outside WebCraft/);
	await expect(install.secrets.describe(secret)).rejects.toThrow(SecretUnreadableError);
	expect(called).toBe(false);
}

test("a stored value with one byte changed is refused", async () => {
	await tamper(northSmtp, "ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)");

	await expectRefused(northSmtp);
});

test("a changed authentication tag is refused", async () => {
	await tamper(
		northSmtp,
		"ciphertext = set_byte(ciphertext, length(ciphertext) - 1, get_byte(ciphertext, length(ciphertext) - 1) # 128)",
	);

	await expectRefused(northSmtp);
});

test("a changed nonce is refused", async () => {
	await tamper(northSmtp, "iv = set_byte(iv, 11, get_byte(iv, 11) # 1)");

	await expectRefused(northSmtp);
});

test("another Workspace's stored value copied into a row is refused, not decrypted", async () => {
	await tamper(northSmtp, COPY, southSmtp);

	await expectRefused(northSmtp);
	await install.secrets.useWith(southSmtp, (value) => expect(value).toBe(SOUTH_PASSWORD));
});

test("a stored value moved to another name of the same Site is refused", async () => {
	await tamper(northCaptcha, COPY, northSmtp);

	await expectRefused(northCaptcha);
});

test("a row moved to another owner is refused", async () => {
	await database.query("DELETE FROM secrets WHERE workspace_id = $1 AND site_id = $2 AND name = $3", [
		southSmtp.owner.workspaceId,
		southSmtp.owner.siteId,
		southSmtp.name,
	]);
	await tamper(northSmtp, "workspace_id = $4, site_id = $5", southSmtp);

	await expectRefused(southSmtp);
});

test("the refusal names the secret but never shows a value", async () => {
	await tamper(northSmtp, "ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)");

	const error = await install.secrets.useWith(northSmtp, () => undefined).catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(SecretUnreadableError);
	expect(String(error)).toBe(
		`SecretUnreadableError: The secret "smtp.password" of Site ${northSmtp.owner.siteId} in Workspace ${northSmtp.owner.workspaceId} can't be decrypted: its stored value was changed outside WebCraft.`,
	);
});

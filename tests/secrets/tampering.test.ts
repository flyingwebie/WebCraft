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

beforeAll(async () => {
	install = await createTestInstall();
	database = new pg.Client({ connectionString: install.databaseUrl });
	await database.connect();
});

afterAll(async () => {
	await database.end();
	await install.close();
});

/** A Site's secret: the rows these tests change are found by Workspace, Site and name. */
type SiteSecret = SecretRef & { owner: { kind: "site"; workspaceId: string; siteId: string } };

const northSmtp: SiteSecret = { owner: { kind: "site", workspaceId: "north", siteId: "shop" }, name: "smtp.password" };
const southSmtp: SiteSecret = { owner: { kind: "site", workspaceId: "south", siteId: "shop" }, name: "smtp.password" };
const northCaptcha: SiteSecret = {
	owner: { kind: "site", workspaceId: "north", siteId: "shop" },
	name: "captcha.secret",
};

const NORTH_PASSWORD = "north-smtp-password-1234567890";
const SOUTH_PASSWORD = "south-smtp-password-0987654321";

beforeEach(async () => {
	await install.secrets.set(northSmtp, NORTH_PASSWORD);
	await install.secrets.set(southSmtp, SOUTH_PASSWORD);
	await install.secrets.set(northCaptcha, "captcha-secret-abcdefghijklmnop");
});

/** Runs `change` on the stored row of `secret`. */
async function tamper(secret: SiteSecret, change: string): Promise<void> {
	const result = await database.query(
		`UPDATE secrets SET ${change} WHERE workspace_id = $1 AND site_id = $2 AND name = $3`,
		[secret.owner.workspaceId, secret.owner.siteId, secret.name],
	);
	expect(result.rowCount).toBe(1);
}

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
	await tamper(
		northSmtp,
		`iv = (SELECT iv FROM secrets WHERE workspace_id = 'south' AND site_id = 'shop' AND name = 'smtp.password'),
		 ciphertext = (SELECT ciphertext FROM secrets WHERE workspace_id = 'south' AND site_id = 'shop' AND name = 'smtp.password')`,
	);

	await expectRefused(northSmtp);
	await install.secrets.useWith(southSmtp, (value) => expect(value).toBe(SOUTH_PASSWORD));
});

test("a stored value moved to another name of the same Site is refused", async () => {
	await tamper(
		northCaptcha,
		`iv = (SELECT iv FROM secrets WHERE workspace_id = 'north' AND site_id = 'shop' AND name = 'smtp.password'),
		 ciphertext = (SELECT ciphertext FROM secrets WHERE workspace_id = 'north' AND site_id = 'shop' AND name = 'smtp.password')`,
	);

	await expectRefused(northCaptcha);
});

test("a row moved to another owner is refused", async () => {
	await database.query(
		"DELETE FROM secrets WHERE workspace_id = 'south' AND site_id = 'shop' AND name = 'smtp.password'",
	);
	await tamper(northSmtp, "workspace_id = 'south'");

	await expectRefused(southSmtp);
});

test("the refusal names the secret but never shows a value", async () => {
	await tamper(northSmtp, "ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1)");

	const error = await install.secrets.useWith(northSmtp, () => undefined).catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(SecretUnreadableError);
	expect(String(error)).toBe(
		'SecretUnreadableError: The secret "smtp.password" of Site shop in Workspace north can\'t be decrypted: its stored value was changed outside WebCraft.',
	);
});

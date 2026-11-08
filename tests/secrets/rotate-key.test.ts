// `webcraft admin rotate-key` re-encrypts every secret under a new Master key. The new key is in
// WEBCRAFT_SECRET_KEY, where web and worker read it from afterwards; the key being replaced is
// passed once, in WEBCRAFT_OLD_SECRET_KEY or a file. These tests run the real command.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMasterKey, type SecretRef } from "@webcraft/core";
import pg from "pg";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const CLI = new URL("../../apps/cli/src/main.ts", import.meta.url).pathname;

/** Bun loads `.env` from the directory it starts in; the CLI starts in an empty one. */
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-rotate-"));

const OLD_KEY = "the-master-key-the-install-started-with-0001";
const NEW_KEY = "the-master-key-the-install-rotates-to-00002";

type Fixture = [SecretRef, string];
const INSTALL_SMTP: Fixture = [{ owner: { kind: "install" }, name: "smtp.password" }, "install-smtp-password-123456"];
const ACME_AI: Fixture = [
	{ owner: { kind: "workspace", workspaceId: "acme" }, name: "ai.key" },
	"sk-acme-ai-key-abcdefghijklmnop",
];
const SHOP_CDN: Fixture = [
	{ owner: { kind: "site", workspaceId: "acme", siteId: "shop" }, name: "cdn.token" },
	"cdn-token-for-the-shop-site-zz",
];
const SECRETS = [INSTALL_SMTP, ACME_AI, SHOP_CDN];

let install: TestInstall;

beforeEach(async () => {
	install = await createTestInstall({ masterKey: OLD_KEY });
	for (const [ref, value] of SECRETS) {
		await install.secrets.set(ref, value);
	}
});

afterEach(async () => {
	await install.close();
});

/** Runs `webcraft admin rotate-key` against the Install, with `env` on top of its own environment. */
async function rotateKey(env: Record<string, string | undefined>, args: string[] = []) {
	const merged: Record<string, string> = { PATH: process.env.PATH ?? "" };
	for (const [name, value] of Object.entries({ ...install.env, ...env })) {
		if (value !== undefined) merged[name] = value;
	}
	const child = Bun.spawn(["bun", CLI, "admin", "rotate-key", ...args], {
		cwd: EMPTY_DIRECTORY,
		env: merged,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

async function expectSecretsReadable(): Promise<void> {
	for (const [ref, value] of SECRETS) {
		await install.secrets.useWith(ref, (seen) => expect(seen).toBe(value));
	}
}

test("re-encrypts every secret under a new key version, which web and worker then start with", async () => {
	const before = await Promise.all(SECRETS.map(([ref]) => install.secrets.describe(ref)));

	const { code, stdout, stderr } = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY });

	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(stdout).toContain("Re-encrypted 3 secrets under Master key version 2.");
	expect(stdout).toContain(`Fingerprint of the new Master key: ${await parseMasterKey(NEW_KEY, "key").fingerprint()}`);
	expect(stdout).not.toContain(NEW_KEY);
	expect(stdout).not.toContain(OLD_KEY);

	await install.restart({ masterKey: NEW_KEY });
	await expectSecretsReadable();
	expect(await Promise.all(SECRETS.map(([ref]) => install.secrets.describe(ref)))).toEqual(before);

	await expect(install.restart({ masterKey: OLD_KEY })).rejects.toThrow(
		"WEBCRAFT_SECRET_KEY is the Install's old Master key (version 1)",
	);
});

test("takes the key being replaced from a file given with --old-key-file", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "webcraft-old-key-")), "old-key");
	await Bun.write(file, `${OLD_KEY}\n`);

	const { code, stdout } = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY }, ["--old-key-file", file]);

	expect(code).toBe(0);
	expect(stdout).toContain("Re-encrypted 3 secrets under Master key version 2.");
	await install.restart({ masterKey: NEW_KEY });
	await expectSecretsReadable();
});

test("refuses an old key that isn't the Install's current Master key, changing nothing", async () => {
	const { code, stderr } = await rotateKey({
		WEBCRAFT_SECRET_KEY: NEW_KEY,
		WEBCRAFT_OLD_SECRET_KEY: "a-key-this-install-has-never-seen-0123456",
	});

	expect(code).toBe(1);
	expect(stderr).toContain(
		"webcraft: WEBCRAFT_OLD_SECRET_KEY is not the Install's current Master key (version 1, whose fingerprint starts with",
	);
	expect(stderr).toContain("Nothing was changed.");
	await install.restart({ masterKey: OLD_KEY });
	await expectSecretsReadable();
	await expect(install.restart({ masterKey: NEW_KEY })).rejects.toThrow("is not this Install's Master key");
});

test("asks for the key being replaced when it isn't given, and refuses it twice over", async () => {
	const missing = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY });

	expect(missing.code).toBe(1);
	expect(missing.stderr).toContain(
		"webcraft: Pass the Install's current Master key, the one being replaced, in WEBCRAFT_OLD_SECRET_KEY or with --old-key-file <path>. WEBCRAFT_SECRET_KEY holds the new key.",
	);

	const file = join(mkdtempSync(join(tmpdir(), "webcraft-old-key-")), "old-key");
	await Bun.write(file, OLD_KEY);
	const twice = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY }, [
		"--old-key-file",
		file,
	]);

	expect(twice.code).toBe(1);
	expect(twice.stderr).toContain("either in WEBCRAFT_OLD_SECRET_KEY or with --old-key-file, not both");
});

test("refuses a new key shorter than 32 characters, and an old key that is the same as the new one", async () => {
	const short = await rotateKey({ WEBCRAFT_SECRET_KEY: "too-short", WEBCRAFT_OLD_SECRET_KEY: OLD_KEY });

	expect(short.code).toBe(1);
	expect(short.stderr).toContain("WEBCRAFT_SECRET_KEY is shorter than 32 characters");
	expect(short.stderr).toContain("openssl rand -base64 32");

	const same = await rotateKey({ WEBCRAFT_SECRET_KEY: OLD_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY });

	expect(same.code).toBe(1);
	expect(same.stderr).toContain(
		"webcraft: WEBCRAFT_SECRET_KEY and WEBCRAFT_OLD_SECRET_KEY hold the same key. Make a new key with `openssl rand -base64 32`.",
	);
	await expectSecretsReadable();
});

test("running it again after it finished changes nothing", async () => {
	const keys = { WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY };
	expect((await rotateKey(keys)).code).toBe(0);

	const again = await rotateKey(keys);

	expect(again.code).toBe(0);
	expect(again.stdout).toBe("The Install already uses this Master key (version 2); nothing was re-encrypted.\n");
	await install.restart({ masterKey: NEW_KEY });
	await expectSecretsReadable();
});

test("never goes back to a key the Install used before", async () => {
	expect((await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY })).code).toBe(0);

	const back = await rotateKey({ WEBCRAFT_SECRET_KEY: OLD_KEY, WEBCRAFT_OLD_SECRET_KEY: NEW_KEY });

	expect(back.code).toBe(1);
	expect(back.stderr).toContain("WEBCRAFT_SECRET_KEY is a key this Install used before (version 1)");
	await install.restart({ masterKey: NEW_KEY });
	await expectSecretsReadable();
});

test("rotates again from the second key to a third", async () => {
	const THIRD_KEY = "a-third-master-key-for-a-second-rotation-03";
	expect((await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY })).code).toBe(0);

	const second = await rotateKey({ WEBCRAFT_SECRET_KEY: THIRD_KEY, WEBCRAFT_OLD_SECRET_KEY: NEW_KEY });

	expect(second.code).toBe(0);
	expect(second.stdout).toContain("Re-encrypted 3 secrets under Master key version 3.");
	await install.restart({ masterKey: THIRD_KEY });
	await expectSecretsReadable();
	await expect(install.restart({ masterKey: NEW_KEY })).rejects.toThrow("old Master key (version 2)");
});

test("when one secret can't be decrypted, rotates none of them", async () => {
	// Someone with database access changed one stored value (see tampering.test.ts).
	const database = new pg.Client({ connectionString: install.databaseUrl });
	await database.connect();
	await database.query(
		"UPDATE secrets SET ciphertext = set_byte(ciphertext, 0, get_byte(ciphertext, 0) # 1) WHERE workspace_id = 'acme' AND site_id IS NULL AND name = 'ai.key'",
	);
	await database.end();

	const { code, stderr } = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY });

	expect(code).toBe(1);
	expect(stderr).toContain(
		'webcraft: 1 of the 3 secrets can\'t be decrypted with WEBCRAFT_OLD_SECRET_KEY, so nothing was changed: "ai.key" of Workspace acme.',
	);
	await install.restart({ masterKey: OLD_KEY });
	for (const [ref, value] of [INSTALL_SMTP, SHOP_CDN]) {
		await install.secrets.useWith(ref, (seen) => expect(seen).toBe(value));
	}
	await expect(install.restart({ masterKey: NEW_KEY })).rejects.toThrow("is not this Install's Master key");
});

test("web and worker still running with the old key can no longer use or write secrets", async () => {
	expect((await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY })).code).toBe(0);
	const [ref, value] = INSTALL_SMTP;

	await expect(install.secrets.useWith(ref, () => "used")).rejects.toThrow(
		"The secret \"smtp.password\" of the Install is encrypted under Master key version 2, which is not this process's Master key. Restart web and worker with the Install's current Master key.",
	);
	await expect(install.secrets.set(ref, "written-under-the-retired-key-000")).rejects.toThrow(
		"This process's Master key is the Install's old Master key (version 1)",
	);

	await install.restart({ masterKey: NEW_KEY });
	await install.secrets.useWith(ref, (seen) => expect(seen).toBe(value));
});

test("an Install that has no secrets yet takes the new key as its first key version", async () => {
	const fresh = await createTestInstall({ masterKey: OLD_KEY });
	try {
		const { code, stdout } = await rotateKey({
			...fresh.env,
			WEBCRAFT_SECRET_KEY: NEW_KEY,
			WEBCRAFT_OLD_SECRET_KEY: OLD_KEY,
		});

		expect(code).toBe(0);
		expect(stdout).toContain("Re-encrypted 0 secrets under Master key version 1.");
		await expect(fresh.restart({ masterKey: OLD_KEY })).rejects.toThrow("is not this Install's Master key");
		await fresh.restart({ masterKey: NEW_KEY });
	} finally {
		await fresh.close();
	}
});

describe("when the old key is lost", () => {
	test("--old-key-lost lists the secrets it would delete and changes nothing without --yes", async () => {
		const { code, stdout } = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY }, ["--old-key-lost"]);

		expect(code).toBe(1);
		expect(stdout).toBe(
			"Without the old Master key these 3 secrets can't be decrypted, so they would be deleted:\n" +
				'  "smtp.password" of the Install\n' +
				'  "ai.key" of Workspace acme\n' +
				'  "cdn.token" of Site shop in Workspace acme\n' +
				"Run again with --yes to delete them and use the new key. Then set them again.\n",
		);
		await install.restart({ masterKey: OLD_KEY });
		await expectSecretsReadable();
	});

	test("--old-key-lost --yes deletes every secret and makes the new key the next key version", async () => {
		const { code, stdout } = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY }, ["--old-key-lost", "--yes"]);

		expect(code).toBe(0);
		expect(stdout).toContain("Deleted 3 secrets. The Install now uses Master key version 2.");
		expect(stdout).toContain('  "ai.key" of Workspace acme\n');
		await expect(install.restart({ masterKey: OLD_KEY })).rejects.toThrow("old Master key (version 1)");
		await install.restart({ masterKey: NEW_KEY });
		for (const [ref] of SECRETS) {
			expect(await install.secrets.describe(ref)).toEqual({ set: false });
		}
		const [ref, value] = INSTALL_SMTP;
		await install.secrets.set(ref, value);
		await install.secrets.useWith(ref, (seen) => expect(seen).toBe(value));
	});

	test("refuses to delete anything when WEBCRAFT_SECRET_KEY is the Install's current key", async () => {
		const { code, stderr } = await rotateKey({ WEBCRAFT_SECRET_KEY: OLD_KEY }, ["--old-key-lost", "--yes"]);

		expect(code).toBe(1);
		expect(stderr).toContain(
			"webcraft: WEBCRAFT_SECRET_KEY is the Install's current Master key (version 1), so it isn't lost and nothing was deleted.",
		);
		await expectSecretsReadable();
	});

	test("refuses --old-key-lost together with an old key", async () => {
		const { code, stderr } = await rotateKey({ WEBCRAFT_SECRET_KEY: NEW_KEY, WEBCRAFT_OLD_SECRET_KEY: OLD_KEY }, [
			"--old-key-lost",
		]);

		expect(code).toBe(1);
		expect(stderr).toContain("--old-key-lost is for when the old key is lost; don't pass the old key with it.");
		await expectSecretsReadable();
	});
});

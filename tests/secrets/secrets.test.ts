// Secrets (SMTP passwords, AI keys, CDN tokens, Webhook and CAPTCHA secrets) are stored encrypted
// under the Master key and can be written but never read back: code gets a secret's value only
// inside a `useWith` callback, and people see only "set" and its last 4 characters.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SecretNotSetError, type SecretRef } from "@webcraft/core";
import pg from "pg";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

/** The ids of the Workspaces and Sites the secrets below belong to. */
const ids = { acme: "", shop: "", blog: "", north: "", northOne: "", northTwo: "", south: "", southOne: "", gone: "" };

beforeAll(async () => {
	install = await createTestInstall();
	ids.acme = (await install.createWorkspace("Acme")).id;
	ids.shop = (await install.createSite(ids.acme, { slug: "shop" })).id;
	ids.blog = (await install.createSite(ids.acme, { slug: "blog" })).id;
	ids.north = (await install.createWorkspace("North")).id;
	ids.northOne = (await install.createSite(ids.north, { slug: "north-one" })).id;
	ids.northTwo = (await install.createSite(ids.north, { slug: "north-two" })).id;
	ids.south = (await install.createWorkspace("South")).id;
	ids.southOne = (await install.createSite(ids.south, { slug: "south-one" })).id;
	ids.gone = (await install.createWorkspace("Gone")).id;
});

afterAll(async () => {
	await install.close();
});

describe("useWith", () => {
	test("hands a secret that was set to the code that uses it", async () => {
		const smtpPassword: SecretRef = { owner: { kind: "install" }, name: "smtp.password" };
		await install.secrets.set(smtpPassword, "correct horse battery staple");

		const result = await install.secrets.useWith(smtpPassword, (value) => {
			expect(value).toBe("correct horse battery staple");
			return "sent";
		});

		expect(result).toBe("sent");
	});

	test("waits for an async callback and returns its answer", async () => {
		const token: SecretRef = { owner: { kind: "site", workspaceId: ids.acme, siteId: ids.shop }, name: "cdn.token" };
		await install.secrets.set(token, "cdn-token-0000000000000000");

		const status = await install.secrets.useWith(token, async (value) => {
			const response = new Response(null, { status: value.startsWith("cdn-token-") ? 204 : 401 });
			return response.status;
		});

		expect(status).toBe(204);
	});

	test("setting a secret again replaces its value", async () => {
		const password: SecretRef = {
			owner: { kind: "site", workspaceId: ids.acme, siteId: ids.blog },
			name: "smtp.password",
		};
		await install.secrets.set(password, "the first password, long enough");
		await install.clock.advance(60_000);
		await install.secrets.set(password, "the second password, long enough");

		await install.secrets.useWith(password, (value) => expect(value).toBe("the second password, long enough"));
		expect(await install.secrets.describe(password)).toEqual({
			set: true,
			lastFour: "ough",
			updatedAt: install.clock.now(),
		});
	});

	test("keeps the same name apart for the Install, each Workspace and each Site", async () => {
		const owners = [
			{ kind: "install" },
			{ kind: "workspace", workspaceId: ids.north },
			{ kind: "workspace", workspaceId: ids.south },
			{ kind: "site", workspaceId: ids.north, siteId: ids.northOne },
			{ kind: "site", workspaceId: ids.north, siteId: ids.northTwo },
			{ kind: "site", workspaceId: ids.south, siteId: ids.southOne },
		] as const;
		for (const [index, owner] of owners.entries()) {
			await install.secrets.set({ owner, name: "shared.name" }, `value number ${index} of the shared name`);
		}

		for (const [index, owner] of owners.entries()) {
			await install.secrets.useWith({ owner, name: "shared.name" }, (value) =>
				expect(value).toBe(`value number ${index} of the shared name`),
			);
		}
	});

	test("refuses a secret nobody set, without calling the callback", async () => {
		let called = false;
		const missing = install.secrets.useWith({ owner: { kind: "install" }, name: "never.set" }, () => {
			called = true;
		});

		await expect(missing).rejects.toThrow(new SecretNotSetError('The secret "never.set" of the Install is not set.'));
		expect(called).toBe(false);
	});
});

describe("owners", () => {
	test("a secret can't belong to a Workspace that doesn't exist", async () => {
		const ref: SecretRef = { owner: { kind: "workspace", workspaceId: crypto.randomUUID() }, name: "ai.key" };

		await expect(install.secrets.set(ref, "sk-a-key-for-nobody-0000000000")).rejects.toThrow();
	});

	test("a Site's secret belongs to a Site of its own Workspace, never another Workspace's", async () => {
		const ref: SecretRef = {
			owner: { kind: "site", workspaceId: ids.north, siteId: ids.southOne },
			name: "smtp.password",
		};

		await expect(install.secrets.set(ref, "a password for the wrong Site")).rejects.toThrow();
		await expect(install.secrets.describe(ref)).resolves.toEqual({ set: false });
	});
});

describe("describe", () => {
	test("says a secret nobody set is not set", async () => {
		const description = await install.secrets.describe({ owner: { kind: "install" }, name: "cdn.token" });

		expect(description).toEqual({ set: false });
	});

	test('says "set", with the last 4 characters and when it was set', async () => {
		const aiKey: SecretRef = { owner: { kind: "workspace", workspaceId: ids.acme }, name: "ai.key" };
		await install.secrets.set(aiKey, "sk-proj-4f9a8b7c6d5e4f3a2b1c0d9e8f7a1b2c");

		const description = await install.secrets.describe(aiKey);

		expect(description).toEqual({ set: true, lastFour: "1b2c", updatedAt: install.clock.now() });
	});

	test("shows no characters of a secret shorter than 16 characters, so at most a quarter of one shows", async () => {
		const short: SecretRef = { owner: { kind: "install" }, name: "captcha.secret" };
		await install.secrets.set(short, "fifteen-chars!!");

		expect(await install.secrets.describe(short)).toEqual({
			set: true,
			lastFour: null,
			updatedAt: install.clock.now(),
		});

		await install.secrets.set(short, "sixteen-char!!!!");

		expect(await install.secrets.describe(short)).toMatchObject({ set: true, lastFour: "!!!!" });
	});

	test("counts characters, not bytes: an emoji at the end is one character", async () => {
		const ref: SecretRef = { owner: { kind: "install" }, name: "webhook.signing" };
		await install.secrets.set(ref, "a-long-signing-secret-ending-in-é🔑");

		expect(await install.secrets.describe(ref)).toMatchObject({ lastFour: "n-é🔑" });
	});
});

describe("remove", () => {
	test("forgets a secret: it is no longer set and can't be used", async () => {
		const ref: SecretRef = { owner: { kind: "workspace", workspaceId: ids.gone }, name: "ai.key" };
		await install.secrets.set(ref, "sk-a-key-that-will-be-removed-soon");

		await install.secrets.remove(ref);

		expect(await install.secrets.describe(ref)).toEqual({ set: false });
		await expect(install.secrets.useWith(ref, () => "used")).rejects.toThrow(SecretNotSetError);
	});

	test("removing a secret nobody set does nothing", async () => {
		const ref: SecretRef = { owner: { kind: "install" }, name: "never.set.either" };

		await install.secrets.remove(ref);

		expect(await install.secrets.describe(ref)).toEqual({ set: false });
	});
});

describe("no read-back", () => {
	let ref: SecretRef;
	const VALUE = "whsec-never-shown-anywhere-9f8e7d6c5b4a";

	beforeAll(async () => {
		ref = { owner: { kind: "site", workspaceId: ids.acme, siteId: ids.shop }, name: "webhook.secret" };
		await install.secrets.set(ref, VALUE);
	});

	test("the secrets interface offers set, useWith, describe and remove, and nothing that reads a value", () => {
		expect(Object.keys(install.secrets).sort()).toEqual(["describe", "remove", "set", "useWith"]);
	});

	test("set answers nothing, and describe shows no more than the last 4 characters", async () => {
		expect(await install.secrets.set(ref, VALUE)).toBeUndefined();

		const description = await install.secrets.describe(ref);

		expect(description).toEqual({ set: true, lastFour: "5b4a", updatedAt: install.clock.now() });
	});

	test("useWith refuses to hand the value back out of the callback", async () => {
		await expect(install.secrets.useWith(ref, (value) => value)).rejects.toThrow(
			`The useWith callback for the secret "webhook.secret" of Site ${ids.shop} in Workspace ${ids.acme} returned the secret's value. A secret's value must not leave the callback.`,
		);
		await expect(install.secrets.useWith(ref, async (value) => `Bearer ${value}`)).rejects.toThrow(
			"returned the secret's value",
		);
	});

	test("the value is stored nowhere in the database and written to no log", async () => {
		await install.secrets.useWith(ref, () => undefined);
		await install.secrets.describe(ref);

		expect(await databaseHolds(install.databaseUrl, "webhook.secret")).not.toEqual([]);
		expect(await databaseHolds(install.databaseUrl, VALUE)).toEqual([]);
		expect(JSON.stringify(install.logs)).not.toContain(VALUE);
	});
});

/**
 * Every column, in every table of every schema, that holds `text` as text or as UTF-8 bytes: what a
 * copy of the database (a Backup) would reveal. It reads no table by name, so it keeps working as
 * the schema changes.
 */
async function databaseHolds(databaseUrl: string, text: string): Promise<string[]> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		const { rows: columns } = await client.query<{ schema: string; table: string; column: string; type: string }>(
			`SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column, c.data_type AS type
			   FROM information_schema.columns c
			   JOIN information_schema.tables t USING (table_schema, table_name)
			  WHERE t.table_type = 'BASE TABLE' AND c.table_schema NOT IN ('pg_catalog', 'information_schema')`,
		);
		const found: string[] = [];
		for (const { schema, table, column, type } of columns) {
			const name = `${quote(schema)}.${quote(table)}`;
			const condition =
				type === "bytea"
					? `position(convert_to($1, 'UTF8') IN ${quote(column)}) > 0`
					: `strpos(${quote(column)}::text, $1) > 0`;
			const { rows } = await client.query(`SELECT 1 FROM ${name} WHERE ${condition} LIMIT 1`, [text]);
			if (rows.length > 0) found.push(`${schema}.${table}.${column}`);
		}
		return found;
	} finally {
		await client.end();
	}
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

describe("what a secret can be", () => {
	test("an empty value is refused: remove a secret instead", async () => {
		const ref: SecretRef = { owner: { kind: "install" }, name: "smtp.password" };

		await expect(install.secrets.set(ref, "")).rejects.toThrow(
			"A secret's value can't be empty; remove the secret instead.",
		);
	});

	test("a value longer than 64 KiB is refused", async () => {
		const ref: SecretRef = { owner: { kind: "install" }, name: "huge" };

		await expect(install.secrets.set(ref, "x".repeat(65_537))).rejects.toThrow(
			"A secret's value can't be longer than 65536 characters.",
		);
	});

	test("names are 1 to 200 letters, digits, dots, colons, dashes and underscores", async () => {
		for (const name of ["", " smtp", "smtp password", "smtp/password", "x".repeat(201)]) {
			await expect(install.secrets.set({ owner: { kind: "install" }, name }, "a value long enough")).rejects.toThrow(
				`"${name}" is not a secret name`,
			);
		}
		for (const name of ["smtp.password", "webhook:7f3c-2a:signing", "AI_KEY-2", "x".repeat(200)]) {
			await install.secrets.set({ owner: { kind: "install" }, name }, "a value long enough");
		}
	});

	test("a Workspace or Site owner needs its ids", async () => {
		await expect(
			install.secrets.describe({ owner: { kind: "workspace", workspaceId: "" }, name: "ai.key" }),
		).rejects.toThrow("A secret's owner needs a Workspace id.");
		await expect(
			install.secrets.describe({ owner: { kind: "site", workspaceId: "acme", siteId: " " }, name: "smtp.password" }),
		).rejects.toThrow("A secret's owner needs a Site id.");
	});
});

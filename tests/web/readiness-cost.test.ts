// `/readyz` is asked by anyone (a load balancer, or a stranger in a loop) and checks the schema in the
// database: the applied migrations, each Module's, the job queue's version. However often it is asked,
// that check must not take the Install's database connections away from the admin and the Sites: a
// ready answer is kept for a moment, and requests arriving together share one check.
import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

/**
 * Keeps the schema check waiting, as a database too busy to answer it would: the record of applied
 * migrations is locked by another connection until `release()`.
 */
async function schemaCheckHeld(): Promise<{ release(): Promise<void> }> {
	const client = new pg.Client({ connectionString: install.databaseUrl });
	await client.connect();
	await client.query("BEGIN");
	await client.query("LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE");
	return {
		async release() {
			await client.query("ROLLBACK");
			await client.end();
		},
	};
}

/** The answer when it comes within `ms`, else "waiting". */
function within<Answer>(ms: number, answer: Promise<Answer>): Promise<Answer | "waiting"> {
	return Promise.race([answer, new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), ms))]);
}

const readyz = () => install.request(install.adminUrl("/readyz"));

test("requests arriving together share one schema check, so the rest of the Install keeps its connections", async () => {
	const admin = await install.superadmin();
	const held = await schemaCheckHeld();
	let waiting: Promise<Response>[] = [];
	try {
		// More at once than the web process has database connections.
		waiting = Array.from({ length: 30 }, readyz);
		expect(await within(300, Promise.race(waiting))).toBe("waiting");

		// The admin still reads the database.
		const listed = await within(5_000, admin.api.workspaces.list());
		expect(listed).not.toBe("waiting");
	} finally {
		await held.release();
	}
	const answers = await Promise.all(waiting);
	expect(answers.map((answer) => answer.status)).toEqual(Array(30).fill(200));
});

test("a ready answer is kept for a moment: asked again at once, it doesn't check the database again", async () => {
	expect((await readyz()).status).toBe(200);
	const held = await schemaCheckHeld();
	try {
		const again = await within(1_000, readyz());

		expect(again).not.toBe("waiting");
		expect((again as Response).status).toBe(200);
		expect(await (again as Response).json()).toEqual({
			status: "ready",
			checks: { database: "ok", schema: "current" },
		});
	} finally {
		await held.release();
	}
});

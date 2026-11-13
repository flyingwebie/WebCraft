// The Install always keeps a Superadmin who can sign in, also when two Superadmins deactivate each
// other at the same moment (review finding on audit A1-3). v1 makes one Superadmin and offers no way
// to make a second, but nothing in the data forbids it (a later version, a restore), and the rule is
// counted over all of them: so this test writes the second one's role straight into the database.
import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

test("two Superadmins deactivating each other at once: one is refused, and one can still sign in", async () => {
	const firstAccount = await install.createSuperadmin({ name: "Sam Superadmin" });
	const firstBrowser = await install.signIn(firstAccount);
	const firstId = (await firstBrowser.api.session.current()).person?.id ?? "";
	const promoted = await install.createStaff({ workspaces: "all", name: "Second Superadmin" });
	const database = new pg.Client({ connectionString: install.databaseUrl });
	await database.connect();
	try {
		await database.query("update install_roles set role = 'superadmin' where person_id = $1", [promoted.personId]);
	} finally {
		await database.end();
	}

	type Superadmin = { id: string; account: TestAccount; browser: TestBrowser };
	const superadmins: [Superadmin, Superadmin] = [
		{ id: firstId, account: firstAccount, browser: firstBrowser },
		{ id: promoted.personId, account: promoted.account, browser: promoted.browser },
	];

	for (let round = 0; round < 5; round++) {
		const [a, b] = superadmins;
		const outcomes = await Promise.allSettled([
			a.browser.api.accounts.deactivate({ personId: b.id }),
			b.browser.api.accounts.deactivate({ personId: a.id }),
		]);
		expect({ round, done: outcomes.filter((outcome) => outcome.status === "fulfilled").length }).toEqual({
			round,
			done: 1,
		});

		// Whoever went through is still a Superadmin who can sign in; they bring the other back.
		const winner = outcomes[0].status === "fulfilled" ? a : b;
		const other = winner === a ? b : a;
		winner.browser = await install.signIn(winner.account);
		await expect(install.signIn(other.account)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
		await winner.browser.api.accounts.reactivate({ personId: other.id });
		other.browser = await install.signIn(other.account);
	}
});

// Second factors outlive a new Master key: authenticator secrets are secrets of the secret store,
// and backup codes are hashed under a key kept there, so `webcraft admin rotate-key` carries both
// over. (A key derived from the Master key would end every backup code at a rotation.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { addAuthenticator, TOTP_STEP_MS, totpCode } from "../harness/two-factor.ts";

const CLI = new URL("../../apps/cli/src/main.ts", import.meta.url).pathname;
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-rotate-2fa-"));
const OLD_KEY = "the-master-key-the-install-started-with-2fa1";
const NEW_KEY = "the-master-key-the-install-rotates-to-2fa002";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ masterKey: OLD_KEY });
});

afterAll(async () => {
	await install.close();
});

test("an authenticator app and backup codes still sign in after the Master key is rotated", async () => {
	const workspaceId = (await install.createWorkspace("Acme")).id;
	const { account, browser } = await install.createMember({ workspaceId, role: "editor" });
	const { secret, backupCodes } = await addAuthenticator(install, browser);

	const child = Bun.spawn(["bun", CLI, "admin", "rotate-key"], {
		cwd: EMPTY_DIRECTORY,
		env: {
			PATH: process.env.PATH ?? "",
			...install.env,
			WEBCRAFT_SECRET_KEY: NEW_KEY,
			WEBCRAFT_OLD_SECRET_KEY: OLD_KEY,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await child.exited).toBe(0);
	await install.restart({ masterKey: NEW_KEY });

	await install.clock.advance(TOTP_STEP_MS);
	const withApp = install.browser();
	expect((await withApp.api.session.signIn(account)).secondStep).not.toBeNull();
	await withApp.api.session.secondStep({ method: "authenticator", code: totpCode(secret, install.clock.now()) });
	expect((await withApp.api.session.current()).person?.email).toBe(account.email);

	const withCode = install.browser();
	await withCode.api.session.signIn(account);
	await withCode.api.session.secondStep({ method: "backupCode", code: backupCodes[0] ?? "" });
	expect((await withCode.api.session.current()).person?.email).toBe(account.email);
});

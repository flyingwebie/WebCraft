// The `webcraft` CLI as a developer uses it, run in process against a test Install: its requests go
// to the Install's handler (never the network), its clock is the Install's, and it keeps its profiles
// and sign-ins in a folder of its own (sign-ins in a file, never this computer's keychain).
//
//     const cli = cliUser(install);
//     const { code, stdout } = await cli.run(["sites", "list", "--workspace-id", workspaceId], {
//       env: { WEBCRAFT_TOKEN: secret, WEBCRAFT_INSTALL: install.adminUrl("/") },
//     });
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "@webcraft/api";
import { credentialStore } from "@webcraft/cli/credentials";
import { runCli } from "@webcraft/cli/run";

import { fromAddress, TEST_PASSWORD, type TestBrowser, type TestInstall } from "./index.ts";

/** What one run printed, and its exit code. */
export type CliRun = { code: number; stdout: string; stderr: string };

export type CliRunOptions = {
	/** Environment variables (the person's shell): `WEBCRAFT_TOKEN`, `WEBCRAFT_INSTALL`, … */
	env?: Record<string, string>;
	/** What standard input holds (`--data -`). */
	stdin?: string;
	/**
	 * Run as on a terminal, answering each question with the next of these (none left: an empty
	 * line). Without it, the run has no terminal and can ask nothing.
	 */
	answers?: string[];
	/**
	 * Called each time the CLI waits (between polls of a device sign-in), with what it printed so far:
	 * the person acting meanwhile (approving the code in the admin). The Install's clock then moves on
	 * by the time the CLI waits.
	 */
	whileWaiting?: (output: { stdout: string; stderr: string }) => Promise<void>;
	/** The working folder relative paths are read from. */
	cwd?: string;
	/** Run another `webcraft` version than this build's (an older one, say). */
	version?: string;
};

export type CliUser = {
	/** Runs `webcraft <args>` and answers what it printed. */
	run(args: string[], options?: CliRunOptions): Promise<CliRun>;
	/** The folder its profiles, sign-ins and cached catalogues are in. */
	configDir: string;
	/** Addresses the CLI asked the browser to open. */
	opened: string[];
	/** Every request it sent. */
	requests: Request[];
	close(): Promise<void>;
};

let addresses = 0;

/** A developer's computer with `webcraft` on it, talking to `install`. */
export function cliUser(install: TestInstall, { hostname = "dev-laptop" }: { hostname?: string } = {}): CliUser {
	const configDir = mkdtempSync(join(tmpdir(), "webcraft-cli-config-"));
	const address = `10.220.${(++addresses >> 8) & 255}.${addresses & 255}`;
	const opened: string[] = [];
	const requests: Request[] = [];
	return {
		configDir,
		opened,
		requests,
		async run(args, options = {}) {
			let stdout = "";
			let stderr = "";
			const answers = [...(options.answers ?? [])];
			const code = await runCli(args, {
				env: { ...options.env },
				stdout: (text) => {
					stdout += text;
				},
				stderr: (text) => {
					stderr += text;
				},
				interactive: options.answers !== undefined,
				ask: async (question) => {
					stderr += question;
					return answers.shift() ?? "";
				},
				readStdin: async () => options.stdin ?? "",
				fetch: (request) => {
					requests.push(request.clone());
					return install.request(fromAddress(request, address));
				},
				configDir,
				cwd: options.cwd ?? configDir,
				credentials: credentialStore(configDir, "file"),
				sleep: async (milliseconds) => {
					await options.whileWaiting?.({ stdout, stderr });
					await install.clock.advance(milliseconds);
				},
				now: () => install.clock.now(),
				openBrowser: async (url) => {
					opened.push(url);
					return true;
				},
				hostname,
				version: options.version,
			});
			return { code, stdout, stderr };
		},
		close: () => rm(configDir, { recursive: true, force: true }),
	};
}

/** The user code a device sign-in printed (`BCDF-GHJK`), or null before it did. */
export function userCodeIn(output: string): string | null {
	return /enter this code: ([A-Z]{4}-[A-Z]{4})/.exec(output)?.[1] ?? null;
}

/**
 * Approves a device sign-in as `browser`'s person does on `/oauth/device` (a Sensitive action: they
 * confirm their password, `TEST_PASSWORD`, when asked).
 */
export async function approveDevice(
	browser: TestBrowser,
	userCode: string,
	choice: Omit<Parameters<ApiClient["oauth"]["approveDevice"]>[0], "userCode">,
): Promise<{ client: string }> {
	const approve = () => browser.api.oauth.approveDevice({ userCode, ...choice });
	return approve().catch(async (error: { code?: string }) => {
		if (error.code !== "IDENTITY_CHECK_REQUIRED") throw error;
		await browser.api.session.confirmIdentity({ password: TEST_PASSWORD });
		return approve();
	});
}

/**
 * Signs `cli` in to `install` as `browser`'s person: runs `webcraft login` and approves its code in
 * the admin while it waits.
 */
export async function signInCli(
	cli: CliUser,
	install: TestInstall,
	browser: TestBrowser,
	choice: Omit<Parameters<ApiClient["oauth"]["approveDevice"]>[0], "userCode">,
	args: string[] = [],
): Promise<CliRun> {
	let approved = false;
	return cli.run(["login", "--install", install.adminUrl("/"), ...args], {
		whileWaiting: async ({ stderr }) => {
			const code = userCodeIn(stderr);
			if (approved || !code) return;
			approved = true;
			await approveDevice(browser, code, choice);
		},
	});
}

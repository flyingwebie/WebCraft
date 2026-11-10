import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { type CredentialStore, credentialStore } from "./account/credentials.ts";

/**
 * Everything the CLI touches outside itself, so the same code runs as the `webcraft` process and
 * in process in the tests (its fetch pointed at the test Install's handler, its clock the Install's).
 */
export type CliIo = {
	env: Readonly<Record<string, string | undefined>>;
	/** Writes to standard output. */
	stdout(text: string): void;
	/** Writes to standard error: messages for the person, never what scripts read. */
	stderr(text: string): void;
	/** Whether a person types into a terminal, so a question can be asked. */
	interactive: boolean;
	/** Asks a question on the terminal (on standard error) and answers the line typed. */
	ask(question: string): Promise<string>;
	/** Everything on standard input, for `--data -`. */
	readStdin(): Promise<string>;
	fetch(request: Request): Promise<Response>;
	/** Where profiles (and, without a keychain, sign-ins) are kept. */
	configDir: string;
	/** The folder relative paths are read from. */
	cwd: string;
	credentials: CredentialStore;
	/** Waits, between polls of the device sign-in. */
	sleep(milliseconds: number): Promise<void>;
	now(): Date;
	/** Opens an address in the person's browser; false when it can't. */
	openBrowser(url: string): Promise<boolean>;
	/** This computer's name, which a device sign-in names its client after. */
	hostname: string;
	/** Which `webcraft` this is: `CLI_VERSION` unless a test runs another. */
	version?: string;
};

/**
 * Where the CLI keeps its profiles: `WEBCRAFT_CONFIG_DIR`, else `%APPDATA%\webcraft` on Windows and
 * `$XDG_CONFIG_HOME/webcraft` (`~/.config/webcraft`) elsewhere.
 */
export function configDirectory(env: Readonly<Record<string, string | undefined>>): string {
	const given = env.WEBCRAFT_CONFIG_DIR?.trim();
	if (given) return given;
	if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "webcraft");
	return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "webcraft");
}

/** The real process's input and output. */
export function processIo(): CliIo {
	const env = process.env;
	const configDir = configDirectory(env);
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	return {
		env,
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
		ask: async (question) => {
			process.stderr.write(question);
			return readTerminalLine();
		},
		readStdin: () => Bun.stdin.text(),
		fetch: (request) => fetch(request),
		configDir,
		cwd: process.cwd(),
		credentials: credentialStore(configDir, env.WEBCRAFT_CREDENTIALS === "file" ? "file" : "keychain"),
		sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		now: () => new Date(),
		openBrowser,
		hostname: hostname(),
	};
}

/** Reads one line from the terminal, echoed as usual. */
function readTerminalLine(): Promise<string> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		let line = "";
		stdin.setEncoding("utf8");
		stdin.resume();
		const done = (error?: Error) => {
			stdin.off("data", onData);
			stdin.pause();
			if (error) reject(error);
			else resolve(line);
		};
		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === "\r" || character === "\n") return done();
				if (character === "\u0003") return done(new Error("Cancelled."));
				line += character;
			}
		};
		stdin.on("data", onData);
	});
}

/** Opens an address with the system's own opener; false when there is none or it failed. */
async function openBrowser(url: string): Promise<boolean> {
	if (!/^https?:\/\//.test(url)) return false;
	const command =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["rundll32", "url.dll,FileProtocolHandler", url]
				: ["xdg-open", url];
	try {
		const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		return (await child.exited) === 0;
	} catch {
		return false;
	}
}

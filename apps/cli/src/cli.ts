import { CliError, EXIT, EXIT_CODES_HELP } from "./exit-codes.ts";
import { readFlags } from "./flags.ts";
import type { CliIo } from "./io.ts";
import type { Catalogue } from "./remote/catalogue.ts";
import { connect, type GlobalOptions, type RunContext } from "./remote/connection.ts";
import { commandHelp, groupsHelp, listHelp } from "./remote/help.ts";
import { knownCatalogue } from "./remote/known.ts";
import { runRemote } from "./remote/run.ts";
import { cliVersion } from "./version.ts";

const USAGE = `Usage: webcraft <command> [options]

Signing in (several Installs: one profile each, chosen with --install):
  login --install <address>   Sign in to an Install in your browser (a device code you approve).
  logout                      End this sign-in on the Install and forget it here.
  whoami                      Who you act as: the person, the Install, the Workspace, Sites and Toolsets.
  profiles [use <name>]       The Installs you signed in to, and which one commands use.

Structure as files, for your own editor and git:
  structure pull [--site-id <id>] [--dir <folder>]
                              Write the Site's Templates, Components, Design system, Post Types, Loops,
                              Forms and Filters as files.
  structure push [--dir <folder>] [--dry-run] [--force]
                              Send what you changed as Drafts, after a preview. Never publishes.

The Install's own commands, one for each public procedure of its API:
  webcraft <group> <command> [--option value…]   for example: webcraft sites list --workspace-id <id>
  webcraft help commands                         list them; webcraft <group> --help for one group

Server commands (on the server, with the Install's environment):
  admin <command>             webcraft admin --help lists them.
  site export <site id> [--to <file or folder>] [--passphrase] [--without-submissions]
  site import <archive> --workspace <id> --slug <slug> [--name <name>] [--passphrase]
                              A Site export written or imported on the server (webcraft admin --help).

Options for every command:
  --install <name|address>    Which Install (a profile's name or address); WEBCRAFT_INSTALL does the same.
  --json                      Print the answer as JSON, for scripts.
  -y, --yes                   Go ahead with changes that ask to be confirmed.
  -h, --help                  Help for a command.
  -V, --version               This webcraft's version.

For CI, set WEBCRAFT_TOKEN to an API token and WEBCRAFT_INSTALL to the Install's admin address.
Exit codes: webcraft help exit-codes.
`;

/**
 * Runs `webcraft` with its arguments and answers its exit code. Nothing here reads the process: the
 * real process passes `processIo()`, the tests their own.
 */
export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
	let parsed: { options: GlobalOptions & { help: boolean; version: boolean }; rest: string[] };
	try {
		parsed = globalOptions(args);
	} catch (error) {
		return failed(io, error, false);
	}
	const { options, rest } = parsed;
	const context: RunContext = { io, options, warnedAboutVersion: false, installVersion: null };
	const [first, second] = rest;
	try {
		if (options.version || first === "version") {
			io.stdout(`webcraft ${cliVersion(io)}\n`);
			return EXIT.ok;
		}
		if (first === "admin") return await admin(rest.slice(1), io, options);
		// Site exports read and write the Install's database and files: server commands too.
		if (first === "site" && (second === "export" || second === "import")) return await admin(rest, io, options);
		if (!first || first === "help" || (options.help && rest.length === 0)) {
			return await help(context, first === "help" ? rest.slice(1) : []);
		}
		switch (first) {
			case "login":
			case "logout":
			case "whoami":
			case "profiles": {
				const account = await import("./account/commands.ts");
				return await account.runAccount(context, first, rest.slice(1), options.help);
			}
			case "structure": {
				if (second === "pull" || second === "push") {
					const structure = await import("./structure/commands.ts");
					return await structure.runStructure(context, second, rest.slice(2), options.help);
				}
				io.stdout(STRUCTURE_HELP);
				return options.help && second === undefined ? EXIT.ok : EXIT.usage;
			}
		}
		return await remote(context, rest);
	} catch (error) {
		return failed(io, error, options.json);
	}
}

/** What the compiled webcraft says about server commands, which only the Install's own webcraft runs. */
const STANDALONE_ADMIN = `Server commands (webcraft admin …) run on the server, with the Install's environment and files:
use the webcraft in the web image (docker compose run --rm migrate webcraft admin <command>, or
docker compose exec web webcraft admin <command>), or bun apps/cli/src/main.ts admin <command> from a
checkout of the Install's version. This webcraft runs the Install's remote commands.`;

const STRUCTURE_HELP = `Usage:
  webcraft structure pull [--site-id <id>] [--dir <folder>] [--force]
  webcraft structure push [--dir <folder>] [--dry-run] [--force] [--yes]

See webcraft structure pull --help and webcraft structure push --help.
`;

/**
 * The server commands. They load the Install's own code (the database, the migrations), so only when
 * asked; the compiled webcraft (built with `WEBCRAFT_BUILD=standalone`) leaves them out altogether.
 */
async function admin(args: string[], io: CliIo, options: GlobalOptions & { help: boolean }): Promise<number> {
	// One expression, so the build's constant leaves the import out of the compiled file altogether.
	const runAdmin = process.env.WEBCRAFT_BUILD === "standalone" ? null : (await import("./admin/index.ts")).runAdmin;
	if (!runAdmin) throw new CliError(EXIT.usage, STANDALONE_ADMIN);
	return runAdmin(args, io, { help: options.help, json: options.json });
}

/**
 * Takes the options every command has out of the arguments, wherever they are. An option this
 * doesn't know (a command's own, such as `--site-id`) is passed through in `rest` for the parser
 * further down the line to read.
 */
function globalOptions(args: readonly string[]): {
	options: GlobalOptions & { help: boolean; version: boolean };
	rest: string[];
} {
	const options = { json: false, yes: false, help: false, version: false } as GlobalOptions & {
		help: boolean;
		version: boolean;
	};
	const flags = readFlags(args);
	for (let flag = flags.next(); flag; flag = flags.next()) {
		if (!flag.short && flag.name === "json") options.json = true;
		else if ((!flag.short && flag.name === "yes") || (flag.short && flag.name === "y")) options.yes = true;
		else if ((!flag.short && flag.name === "help") || (flag.short && flag.name === "h")) options.help = true;
		else if ((!flag.short && flag.name === "version") || (flag.short && flag.name === "V")) options.version = true;
		else if (!flag.short && flag.name === "install") {
			options.install = flags.value(flag, "--install needs a profile's name or an Install's address.");
		} else flags.rest.push(flag.raw);
	}
	return { options, rest: flags.rest };
}

/** The Install's catalogue when one answers; else the commands this webcraft was built with. */
async function catalogueForHelp(context: RunContext): Promise<{ catalogue: Catalogue; fromInstall: boolean }> {
	try {
		const connection = await connect(context);
		return { catalogue: await connection.catalogue(), fromInstall: true };
	} catch {
		return { catalogue: await knownCatalogue(), fromInstall: false };
	}
}

async function help(context: RunContext, topic: string[]): Promise<number> {
	const { io } = context;
	if (topic.length === 0) {
		io.stdout(USAGE);
		return EXIT.ok;
	}
	if (topic[0] === "exit-codes") {
		io.stdout(EXIT_CODES_HELP);
		return EXIT.ok;
	}
	const { catalogue, fromInstall } = await catalogueForHelp(context);
	const note = fromInstall ? "" : "\n(The commands this webcraft knows: sign in to see your Install's.)\n";
	if (topic[0] === "commands") {
		io.stdout(
			`The Install's commands, by group (webcraft <group> --help lists a group):\n${groupsHelp(catalogue)}\n${note}`,
		);
		return EXIT.ok;
	}
	const found = catalogue.find(topic);
	if (found && found.rest.length === 0) {
		io.stdout(commandHelp(found.command) + note);
		return EXIT.ok;
	}
	const list = listHelp(catalogue, topic);
	if (list) {
		io.stdout(list + note);
		return EXIT.ok;
	}
	throw new CliError(EXIT.usage, `There is no command webcraft ${topic.join(" ")}. See webcraft help commands.`);
}

/** A remote command: one of the Install's public procedures. */
async function remote(context: RunContext, rest: string[]): Promise<number> {
	const { io, options } = context;
	const firstOption = rest.findIndex((arg) => arg.startsWith("-"));
	const commandWords = firstOption === -1 ? rest : rest.slice(0, firstOption);

	if (options.help) {
		const { catalogue, fromInstall } = await catalogueForHelp(context);
		const note = fromInstall ? "" : "\n(The commands this webcraft knows: sign in to see your Install's.)\n";
		const found = catalogue.find(commandWords);
		if (found && found.rest.length === 0) io.stdout(commandHelp(found.command) + note);
		else {
			const list = listHelp(catalogue, commandWords);
			if (!list) throw unknownCommand(catalogue, commandWords);
			io.stdout(list + note);
		}
		return EXIT.ok;
	}

	const connection = await connect(context);
	const catalogue = await connection.catalogue();
	const found = catalogue.find(commandWords);
	if (!found || found.rest.length > 0) {
		const sensitive = catalogue.sensitive.get(commandWords.join(" "));
		if (sensitive) {
			throw new CliError(
				EXIT.notOffered,
				`webcraft ${commandWords.join(" ")} is a Sensitive action (${sensitive.action}): it needs a fresh identity check, so it is done in the admin, never with the CLI or an API token.`,
			);
		}
		const known = (await knownCatalogue()).find(commandWords);
		if (known && known.rest.length === 0) {
			throw new CliError(
				EXIT.notOffered,
				`The Install at ${connection.url} doesn't offer webcraft ${known.command.words.join(" ")} (${known.command.operationId}): it runs another WebCraft version than this webcraft (${cliVersion(io)}), or doesn't run the Module it belongs to. See webcraft help commands for what it offers.`,
			);
		}
		const list = listHelp(catalogue, commandWords);
		if (list && commandWords.length > 0) {
			io.stderr(list);
			return EXIT.usage;
		}
		throw unknownCommand(catalogue, commandWords);
	}
	return runRemote(context, connection, found.command, firstOption === -1 ? [] : rest.slice(firstOption));
}

function unknownCommand(catalogue: Catalogue, words: string[]): CliError {
	const typed = words.join(" ");
	const close = catalogue.commands
		.map((command) => command.words.join(" "))
		.filter((name) => name.startsWith(words[0] ?? "") || distance(name, typed) <= 3)
		.slice(0, 5);
	return new CliError(
		EXIT.usage,
		`There is no command webcraft ${typed}.${close.length ? ` Did you mean:\n${close.map((name) => `  webcraft ${name}`).join("\n")}` : " See webcraft help."}`,
	);
}

/** How many single-character changes turn one text into another. */
function distance(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0] ?? 0;
		previous[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = previous[j] ?? 0;
			previous[j] = Math.min(above + 1, (previous[j - 1] ?? 0) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return previous[b.length] ?? 0;
}

/** Prints a failure: its words on standard error (as JSON with `--json`), and answers its exit code. */
function failed(io: CliIo, error: unknown, json: boolean): number {
	if (error instanceof CliError) {
		if (json) {
			io.stderr(
				`${JSON.stringify({ error: error.refusal ?? { code: "CLI", message: error.message }, exitCode: error.code }, null, 2)}\n`,
			);
		} else io.stderr(`webcraft: ${error.message}\n`);
		return error.code;
	}
	io.stderr(`webcraft: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	return EXIT.failed;
}

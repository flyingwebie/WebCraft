#!/usr/bin/env bun
// The `webcraft` command line. For now it has the server command `admin migrate`; the generated
// remote commands, `login` and the other server commands arrive with the CLI ticket.
import { ConfigError, loadDatabaseUrl } from "@webcraft/core";
import { runMigrations } from "@webcraft/db";

const USAGE = `Usage: webcraft <command>

Server commands (run on the server, with the Install's environment):
  admin migrate   Apply pending database migrations and install or upgrade the job queue schema.
                  Run it before starting a new version of web and worker.

Options:
  -h, --help      Show this help.
`;

async function main(args: string[]): Promise<number> {
	const [group, command, ...rest] = args;
	if (!group || group === "-h" || group === "--help" || group === "help") {
		process.stdout.write(USAGE);
		return group ? 0 : 1;
	}
	if (group === "admin" && command === "migrate" && rest.length === 0) {
		return migrate();
	}
	process.stderr.write(`Unknown command: webcraft ${args.join(" ")}\n\n${USAGE}`);
	return 1;
}

async function migrate(): Promise<number> {
	const report = await runMigrations(loadDatabaseUrl(process.env));
	const applied = report.appliedMigrations;
	process.stdout.write(
		applied.length === 0
			? "No migrations were pending.\n"
			: `Applied ${applied.length} migration${applied.length === 1 ? "" : "s"}:\n${applied.map((name) => `  ${name}\n`).join("")}`,
	);
	const { from, to } = report.jobQueueSchema;
	process.stdout.write(
		from === to
			? `The job queue schema is at version ${to}.\n`
			: `The job queue schema went from ${from === null ? "not installed" : `version ${from}`} to version ${to}.\n`,
	);
	return 0;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error: unknown) => {
		const message = error instanceof ConfigError ? error.message : error instanceof Error ? error.stack : String(error);
		process.stderr.write(`webcraft: ${message}\n`);
		process.exit(1);
	},
);

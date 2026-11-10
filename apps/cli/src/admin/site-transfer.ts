// `webcraft site export` and `webcraft site import`: a Site export written or read on the server
// (ADR 0033), with the Install's environment, as the admin's Site › Export and Workspace › Site imports
// do through the worker. A passphrase is never taken from the command line: it is asked on a terminal,
// or read from the first line of standard input.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import {
	ConfigError,
	createLogger,
	type Environment,
	fileTarget,
	openInstallForCommandSendingJobs,
	PASSPHRASE_MIN_LENGTH,
} from "@webcraft/core";

import { askSecret, firstLineOfStandardInput, interactive } from "./prompt.ts";

export type SiteExportOptions = { siteId: string; to: string; passphrase: boolean };
export type SiteImportOptions = {
	archive: string;
	workspaceId: string;
	slug: string;
	name: string | null;
	passphrase: boolean;
};

/** Reads `<site id> [--to <file or folder>] [--passphrase]`; null for anything else. */
export function parseSiteExportOptions(args: string[]): SiteExportOptions | null {
	let siteId: string | undefined;
	let to = ".";
	let passphrase = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--to" && args[index + 1]) to = args[++index] ?? ".";
		else if (arg.startsWith("--to=") && arg.length > 5) to = arg.slice(5);
		else if (arg === "--passphrase") passphrase = true;
		else if (!arg.startsWith("-") && siteId === undefined) siteId = arg;
		else return null;
	}
	return siteId ? { siteId, to, passphrase } : null;
}

/** Reads `<archive> --workspace <id> --slug <slug> [--name <name>] [--passphrase]`; null for anything else. */
export function parseSiteImportOptions(args: string[]): SiteImportOptions | null {
	let archive: string | undefined;
	let workspaceId: string | undefined;
	let slug: string | undefined;
	let name: string | null = null;
	let passphrase = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const value = () => args[++index];
		if (arg === "--workspace") workspaceId = value();
		else if (arg === "--slug") slug = value();
		else if (arg === "--name") name = value() ?? null;
		else if (arg === "--passphrase") passphrase = true;
		else if (!arg.startsWith("-") && archive === undefined) archive = arg;
		else return null;
	}
	return archive && workspaceId && slug ? { archive, workspaceId, slug, name, passphrase } : null;
}

/** The passphrase, asked on a terminal (twice when it is new) or read from standard input. */
async function readPassphrase(again: boolean): Promise<string> {
	if (!interactive()) return firstLineOfStandardInput();
	const passphrase = await askSecret("Export passphrase: ");
	if (again && (await askSecret("The passphrase again: ")) !== passphrase) {
		throw new ConfigError("The two passphrases differ. Nothing was exported.");
	}
	return passphrase;
}

function commandLog() {
	return createLogger({
		fields: { process: "cli" },
		write: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
	});
}

function size(bytes: number): string {
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** `webcraft site export <site id> [--to <file or folder>] [--passphrase]`. */
export async function siteExportCommand(env: Environment, options: SiteExportOptions): Promise<number> {
	const passphrase = options.passphrase ? await readPassphrase(true) : null;
	if (passphrase !== null && passphrase.length < PASSPHRASE_MIN_LENGTH) {
		throw new ConfigError(
			`An export passphrase has at least ${PASSPHRASE_MIN_LENGTH} characters. Nothing was exported.`,
		);
	}
	const { services, close } = await openInstallForCommandSendingJobs({ env, log: commandLog() });
	try {
		const target = await fileTarget(options.to);
		let location = "";
		const written = await services.siteTransfer.exportByCommand({
			siteId: options.siteId,
			passphrase,
			write: (name, bytes) => {
				location = target.location(name);
				return target.write(name, bytes);
			},
		});
		const { secrets, leftOut } = written.summary;
		process.stdout.write(
			`Exported the Site: ${location} (${size(written.sizeBytes)}).\n` +
				(secrets.carried
					? `Its ${secrets.names.length} secrets are in it, encrypted under the passphrase: give the passphrase to whoever imports it, apart from the file.\n`
					: `Its secrets were left out${secrets.names.length ? `: ${secrets.names.join(", ")}` : ""}.\n`) +
				`Never in it: passwords, sessions, API tokens, Content keys (${leftOut.contentKeys.length}), Share links (${leftOut.shareLinks.length}); Scheduled publishes left out: ${leftOut.scheduledPublishes.length}.\n`,
		);
		return 0;
	} finally {
		await close();
	}
}

/** `webcraft site import <archive> --workspace <id> --slug <slug> [--name <name>] [--passphrase]`. */
export async function siteImportCommand(env: Environment, options: SiteImportOptions): Promise<number> {
	const file = await stat(options.archive).catch(() => null);
	if (!file?.isFile()) throw new ConfigError(`There is no file at ${options.archive}.`);
	const passphrase = options.passphrase ? await readPassphrase(false) : null;
	const { services, close } = await openInstallForCommandSendingJobs({ env, log: commandLog() });
	try {
		const imported = await services.siteTransfer.importByCommand({
			workspaceId: options.workspaceId,
			fileName: options.archive.split(/[\\/]/).pop() ?? "site.tar",
			sizeBytes: file.size,
			open: () => createReadStream(options.archive) as AsyncIterable<Uint8Array>,
			name: options.name ?? options.slug,
			slug: options.slug,
			passphrase,
		});
		const report = imported.report;
		process.stdout.write(
			`Imported the Site as ${options.slug} (${imported.site?.id ?? ""}): its Content arrived as Drafts.\n` +
				(report
					? `Paused domains: ${report.paused.map((domain) => domain.name).join(", ") || "none"}. ` +
						`Pending invitations (not sent): ${report.invited.length}. ` +
						`Secrets set: ${report.secrets.set.length}, left out: ${report.secrets.dropped.length}. ` +
						`Reassigned: ${report.reassigned.length}.\n` +
						"The Site import report is on the Workspace's Site imports page in the admin.\n"
					: ""),
		);
		return 0;
	} finally {
		await close();
	}
}

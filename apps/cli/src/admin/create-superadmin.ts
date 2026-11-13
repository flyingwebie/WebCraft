import { assertNewPasswordAllowed, assertValidEmail, normaliseEmail } from "@webcraft/auth";
import {
	ADMIN_LANGUAGE_CODES,
	type AdminLanguageCode,
	ConfigError,
	createLogger,
	DEFAULT_ADMIN_LANGUAGE,
	isAdminLanguage,
	openInstallForCommand,
} from "@webcraft/core";

import { ask, askSecret, firstLineOfStandardInput, interactive } from "./prompt.ts";

export type CreateSuperadminOptions = {
	email: string;
	name?: string;
	language: AdminLanguageCode;
};

/**
 * Reads `<email> [--name <name>] [--language <code>]`. A password is never taken from the command
 * line, where shell history and process lists would keep it: passing one is refused.
 */
export function parseCreateSuperadminOptions(args: string[]): CreateSuperadminOptions | null {
	let email: string | undefined;
	let name: string | undefined;
	let language: AdminLanguageCode = DEFAULT_ADMIN_LANGUAGE;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const [flag, inline] = arg.startsWith("--") ? splitFlag(arg) : [arg, undefined];
		if (flag === "--password") {
			throw new ConfigError(
				"The password is read from a prompt, or from standard input when there is no terminal, never on the command line.",
			);
		}
		if (flag === "--name" || flag === "--language") {
			const value = inline ?? args[++index];
			if (!value) return null;
			if (flag === "--name") name = value;
			else if (isAdminLanguage(value)) language = value;
			else throw new ConfigError(`--language must be one of ${ADMIN_LANGUAGE_CODES.join(", ")}.`);
		} else if (!arg.startsWith("-") && email === undefined) {
			email = arg;
		} else {
			return null;
		}
	}
	return email === undefined ? null : { email, name, language };
}

function splitFlag(arg: string): [string, string | undefined] {
	const equals = arg.indexOf("=");
	return equals === -1 ? [arg, undefined] : [arg.slice(0, equals), arg.slice(equals + 1)];
}

/**
 * `webcraft admin create-superadmin`: creates the Superadmin of a fresh Install without the setup
 * wizard. Setup is then finished, so the wizard and its token stop working.
 */
export async function createSuperadmin(options: CreateSuperadminOptions): Promise<number> {
	assertValidEmail(options.email);
	const email = normaliseEmail(options.email);
	const name =
		options.name?.trim() || (interactive() ? (await ask("Full name: ")).trim() : "") || email.split("@")[0] || email;
	const password = await readPassword();

	// Logs go to standard error as JSON lines, so the Install's log keeps a record of the creation.
	const log = createLogger({
		fields: { process: "cli" },
		write: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
	});
	const services = await openInstallForCommand({ env: process.env, log });
	try {
		await services.setup.createSuperadmin({ name, email, password, adminLanguage: options.language });
		process.stdout.write(
			`Created the Superadmin ${email}. Setup is finished, so the setup wizard is closed.\n` +
				`Sign in at ${new URL("/sign-in", services.config.adminOrigin)}\n`,
		);
		return 0;
	} finally {
		await services.database.close();
	}
}

/** The password, typed twice on a terminal or read from the first line of standard input. */
async function readPassword(): Promise<string> {
	if (!interactive()) {
		const password = await firstLineOfStandardInput();
		await assertNewPasswordAllowed(password);
		return password;
	}
	const password = await askSecret("Password (at least 12 characters): ");
	await assertNewPasswordAllowed(password);
	if ((await askSecret("Type the password again: ")) !== password) {
		throw new ConfigError("The two passwords are different. Nothing was created.");
	}
	return password;
}

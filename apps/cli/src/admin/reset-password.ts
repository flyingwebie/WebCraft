import { assertNewPasswordAllowed, assertValidEmail, normaliseEmail } from "@webcraft/auth";
import { ConfigError, createLogger, openInstallForCommand } from "@webcraft/core";

import { askSecret, firstLineOfStandardInput, interactive } from "./prompt.ts";

/**
 * `webcraft admin reset-password <email>`: gives a person a new password from the server, for a
 * Superadmin whose reset email doesn't arrive (nobody on the Install can change another person's
 * password). The password is asked twice on a terminal, or read from the first line of standard
 * input, never taken from the command line. Every session of theirs ends; their second factors stay
 * as they are, so they still need one to sign in. Recorded in the Audit log as done by the command.
 */
export async function resetPassword(address: string): Promise<number> {
	assertValidEmail(address);
	const email = normaliseEmail(address);
	const password = await readNewPassword();
	// Logs go to standard error as JSON lines, so the Install's log keeps a record of the reset.
	const log = createLogger({
		fields: { process: "cli" },
		write: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
	});
	const services = await openInstallForCommand({ env: process.env, log });
	try {
		const reset = await services.passwordResets.resetByCommand(email, password);
		if (!reset) throw new ConfigError(`Nobody signs in with ${email} on this Install. Nothing was changed.`);
		log.warn("A password was reset from the server", { personId: reset.personId, email });
		process.stdout.write(
			`Changed the password of ${email}: they are signed out everywhere.\n` +
				`They sign in at ${new URL("/sign-in", services.config.adminOrigin)} with the new password, and with their second factor if they have one.\n`,
		);
		return 0;
	} finally {
		await services.database.close();
	}
}

/** The new password, typed twice on a terminal or read from the first line of standard input. */
async function readNewPassword(): Promise<string> {
	if (!interactive()) {
		const password = await firstLineOfStandardInput();
		await assertNewPasswordAllowed(password);
		return password;
	}
	const password = await askSecret("New password (at least 12 characters): ");
	await assertNewPasswordAllowed(password);
	if ((await askSecret("Type the password again: ")) !== password) {
		throw new ConfigError("The two passwords are different. Nothing was changed.");
	}
	return password;
}

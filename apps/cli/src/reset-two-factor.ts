import { assertValidEmail, normaliseEmail } from "@webcraft/auth";
import { ConfigError, createLogger, openInstallForCommandSendingJobs } from "@webcraft/core";

/**
 * `webcraft admin reset-2fa <email>`: resets a person's two-factor authentication from the server,
 * for a Superadmin who lost theirs (nobody else on the Install can reset the Superadmin's). Their
 * authenticator app, passkeys and backup codes go, every session of theirs ends and a lock on their
 * account is lifted; they are emailed, and the reset is in the Audit log as done by the command.
 */
export async function resetTwoFactor(address: string): Promise<number> {
	assertValidEmail(address);
	const email = normaliseEmail(address);
	// Logs go to standard error as JSON lines, so the Install's log keeps a record of the reset.
	const log = createLogger({
		fields: { process: "cli" },
		write: (entry) => process.stderr.write(`${JSON.stringify(entry)}\n`),
	});
	const { services, close } = await openInstallForCommandSendingJobs({ env: process.env, log });
	try {
		const reset = await services.twoFactor.resetByCommand(email);
		if (!reset) throw new ConfigError(`Nobody signs in with ${email} on this Install. Nothing was changed.`);
		log.warn("Two-factor authentication was reset from the server", { personId: reset.personId, email });
		process.stdout.write(
			`Reset the two-factor authentication of ${email}: their authenticator app, passkeys and backup codes are removed, and they are signed out everywhere.\n` +
				`They sign in with their password at ${new URL("/sign-in", services.config.adminOrigin)} and set it up again. They were emailed about it.\n`,
		);
		return 0;
	} finally {
		await close();
	}
}

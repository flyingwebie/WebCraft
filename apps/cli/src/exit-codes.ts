/**
 * What `webcraft` exits with, so scripts can tell failures apart. Documented in `webcraft help
 * exit-codes` and `docs/cli.md`; never renumber one.
 */
export const EXIT = {
	/** It worked. */
	ok: 0,
	/** The Install refused or failed the call, or something else went wrong. */
	failed: 1,
	/** The command or its options are wrong: nothing was sent. */
	usage: 2,
	/** Not signed in, or the sign-in or API token no longer works: run `webcraft login`. */
	signIn: 3,
	/** A change waits for a confirmation that wasn't given (`--yes`), or the person said no. */
	notConfirmed: 4,
	/** Someone changed it on the Install meanwhile: a stale `structure push`, or `CHANGED_MEANWHILE`. */
	changedMeanwhile: 5,
	/** The Install couldn't be reached. */
	unreachable: 6,
	/** The Install's API doesn't offer this command (it runs another WebCraft version). */
	notOffered: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the CLI explains in words and exits with a code for. */
export class CliError extends Error {
	override name = "CliError";
	readonly code: ExitCode;
	/** The Install's refusal, for `--json`. */
	readonly refusal?: { code: string; status: number; message: string; data?: unknown };
	constructor(code: ExitCode, message: string, refusal?: CliError["refusal"]) {
		super(message);
		this.code = code;
		this.refusal = refusal;
	}
}

/** The exit codes as `webcraft help exit-codes` lists them. */
export const EXIT_CODES_HELP = `Exit codes:
  0  It worked.
  1  The Install refused or failed the call, or something else went wrong.
  2  The command or its options are wrong: nothing was sent.
  3  Not signed in, or the sign-in or API token no longer works: run webcraft login.
  4  A change needs a confirmation that wasn't given (pass --yes), or you said no.
  5  Changed on the Install meanwhile: a stale structure push, or CHANGED_MEANWHILE.
  6  The Install couldn't be reached.
  7  The Install's API doesn't offer this command (it runs another WebCraft version).
`;

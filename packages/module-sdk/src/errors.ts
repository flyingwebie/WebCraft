/**
 * Why WebCraft refused something a Module tried: it isn't in the Module's manifest or definition.
 * - `permission`: a Permission it didn't declare.
 * - `table`: a table that isn't one of its own.
 * - `host`: an outside host it didn't declare (or an address inside the server's network).
 * - `use`: a WebCraft service it didn't declare in `uses`.
 * - `job`: a job it didn't define, or a payload its job doesn't accept.
 * - `secret`: a secret name that isn't allowed, or one nobody set.
 * - `email`: an email that isn't complete in the Module's languages.
 */
export type ModuleRefusal = "permission" | "table" | "host" | "use" | "job" | "secret" | "email";

/** Thrown when a Module tries something it didn't declare. Never retried: the Module must change. */
export class ModuleRefusedError extends Error {
	override name = "ModuleRefusedError";
	readonly reason: ModuleRefusal;
	constructor(reason: ModuleRefusal, message: string) {
		super(message);
		this.reason = reason;
	}
}

/**
 * An answer a Module's procedure gives on purpose, such as "that note doesn't exist": the API
 * answers it with `MODULE_ERROR`, this status and `data: { code }`. Anything else a
 * procedure throws is a failure: it goes to the Module log and the API answers 500.
 */
export class ModuleError extends Error {
	override name = "ModuleError";
	readonly code: string;
	readonly status: 400 | 403 | 404 | 409;
	constructor(code: string, message: string, status: 400 | 403 | 404 | 409 = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

/**
 * Whether an error is a Module's own answer (`ModuleError`), recognised by its name, code and status
 * rather than by its class (SDK 1.5): the Module may run against another copy of the SDK than
 * WebCraft's (a bundle, later a sandbox), whose class is a different one.
 */
export function isModuleError(error: unknown): error is ModuleError {
	if (error instanceof ModuleError) return true;
	if (!(error instanceof Error) || error.name !== "ModuleError") return false;
	const { code, status } = error as { code?: unknown; status?: unknown };
	return typeof code === "string" && (status === 400 || status === 403 || status === 404 || status === 409);
}
